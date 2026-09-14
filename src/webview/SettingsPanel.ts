import * as vscode from "vscode";
import type { AutonomyMode, ProviderId, ProviderProfile } from "../types";
import { defaultBaseUrl, defaultModel, providerRequiresApiKey } from "../providers";
import { listModels } from "../providers/models";
import { labelFor, ProfileStore, syncSettingsFromProfile } from "../agent/profiles";
import { KeyStore } from "../secrets/keys";
import { readConfig, setAutonomy } from "../config";
import { openProjectRules } from "../agent/rules";

const PROVIDERS: Array<{ id: ProviderId; label: string }> = [
  { id: "openai", label: "OpenAI" },
  { id: "openai-compatible", label: "OpenAI-compatible" },
  { id: "ollama", label: "Ollama" },
  { id: "anthropic", label: "Anthropic" },
  { id: "gemini", label: "Gemini" },
];

function newProfileId(): string {
  return `prof_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export class SettingsPanel {
  public static current?: SettingsPanel;
  public static readonly viewType = "forgeAgent.settings";

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly keyStore: KeyStore,
    private readonly profileStore: ProfileStore,
    private readonly onChanged: () => void | Promise<void>
  ) {
    this.panel = panel;
    this.panel.webview.html = this.getHtml(this.panel.webview);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (msg) => void this.onMessage(msg),
      null,
      this.disposables
    );
  }

  static createOrShow(
    extensionUri: vscode.Uri,
    keyStore: KeyStore,
    profileStore: ProfileStore,
    onChanged: () => void | Promise<void>
  ): SettingsPanel {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    if (SettingsPanel.current) {
      SettingsPanel.current.panel.reveal(column);
      void SettingsPanel.current.pushState();
      return SettingsPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      SettingsPanel.viewType,
      "Forge Agent — Configuração",
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
      }
    );
    SettingsPanel.current = new SettingsPanel(
      panel,
      extensionUri,
      keyStore,
      profileStore,
      onChanged
    );
    void SettingsPanel.current.pushState();
    return SettingsPanel.current;
  }

  dispose(): void {
    SettingsPanel.current = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }

  private post(message: unknown): void {
    void this.panel.webview.postMessage(message);
  }

  private async pushState(): Promise<void> {
    await this.profileStore.ensureSeeded();
    const config = readConfig();
    const profiles = [];
    for (const p of this.profileStore.list()) {
      profiles.push({
        ...p,
        hasKey: await this.keyStore.hasForProfile(p.id, p.provider),
        requiresKey: providerRequiresApiKey(p.provider),
      });
    }
    this.post({
      type: "state",
      providers: PROVIDERS,
      profiles,
      activeProfileId: this.profileStore.active()?.id ?? config.profileId,
      agent: {
        autonomy: config.autonomy,
        maxToolRounds: config.maxToolRounds,
        autoApproveReads: config.autoApproveReads,
        requireApprovalForWrites: config.requireApprovalForWrites,
        requireApprovalForTerminal: config.requireApprovalForTerminal,
        systemPromptExtra: config.systemPromptExtra,
        temperature: config.temperature,
      },
    });
  }

  private async onMessage(msg: { type?: string; [k: string]: unknown }): Promise<void> {
    switch (msg.type) {
      case "ready":
        await this.pushState();
        break;
      case "selectProfile": {
        const id = String(msg.id ?? "");
        if (!id) break;
        await this.profileStore.setActive(id);
        await this.onChanged();
        await this.pushState();
        break;
      }
      case "createProfile": {
        const provider = (String(msg.provider ?? "openai") || "openai") as ProviderId;
        const profile: ProviderProfile = {
          id: newProfileId(),
          name: String(msg.name ?? "").trim() || labelFor(provider),
          provider,
          model: String(msg.model ?? "").trim() || defaultModel(provider),
          baseUrl: String(msg.baseUrl ?? "").replace(/\/$/, "") || defaultBaseUrl(provider),
          tlsInsecure: Boolean(msg.tlsInsecure),
        };
        await this.profileStore.upsert(profile);
        await this.profileStore.setActive(profile.id);
        const apiKey = String(msg.apiKey ?? "").trim();
        if (apiKey) {
          await this.keyStore.setForProfile(profile.id, apiKey);
          await this.keyStore.set(profile.provider, apiKey);
        }
        await this.onChanged();
        await this.pushState();
        this.post({ type: "toast", text: `Perfil “${profile.name}” criado.`, level: "ok" });
        break;
      }
      case "saveProfile": {
        const id = String(msg.id ?? "");
        const existing = this.profileStore.get(id);
        if (!existing) {
          this.post({ type: "toast", text: "Perfil não encontrado.", level: "error" });
          break;
        }
        const provider = (String(msg.provider ?? existing.provider) ||
          existing.provider) as ProviderId;
        const updated: ProviderProfile = {
          id,
          name: String(msg.name ?? existing.name).trim() || existing.name,
          provider,
          model: String(msg.model ?? existing.model).trim() || defaultModel(provider),
          baseUrl:
            String(msg.baseUrl ?? existing.baseUrl).replace(/\/$/, "") ||
            defaultBaseUrl(provider),
          tlsInsecure: Boolean(msg.tlsInsecure),
        };
        await this.profileStore.upsert(updated);
        if (this.profileStore.active()?.id === id) {
          await syncSettingsFromProfile(updated);
        }
        const apiKey = String(msg.apiKey ?? "").trim();
        if (apiKey) {
          await this.keyStore.setForProfile(id, apiKey);
          await this.keyStore.set(provider, apiKey);
        }
        await this.onChanged();
        await this.pushState();
        this.post({ type: "toast", text: "Perfil salvo.", level: "ok" });
        break;
      }
      case "deleteProfile": {
        const id = String(msg.id ?? "");
        if (this.profileStore.list().length <= 1) {
          this.post({
            type: "toast",
            text: "Mantenha ao menos um perfil.",
            level: "error",
          });
          break;
        }
        await this.keyStore.clearForProfile(id);
        await this.profileStore.remove(id);
        await this.onChanged();
        await this.pushState();
        this.post({ type: "toast", text: "Perfil removido.", level: "ok" });
        break;
      }
      case "clearApiKey": {
        const id = String(msg.id ?? "");
        const profile = this.profileStore.get(id);
        if (!profile) break;
        await this.keyStore.clearForProfile(id);
        await this.keyStore.clear(profile.provider);
        await this.onChanged();
        await this.pushState();
        this.post({ type: "toast", text: "API key removida.", level: "ok" });
        break;
      }
      case "listModels": {
        const id = String(msg.id ?? "");
        const profile = this.profileStore.get(id) ?? this.profileStore.active();
        if (!profile) break;
        const apiKey =
          (await this.keyStore.getForProfile(profile.id, profile.provider)) ?? "";
        try {
          const models = await listModels({
            provider: profile.provider,
            apiKey,
            baseUrl: profile.baseUrl,
            tlsInsecure: profile.tlsInsecure,
          });
          this.post({ type: "models", profileId: profile.id, models });
        } catch (e) {
          const err = e instanceof Error ? e.message : String(e);
          this.post({
            type: "toast",
            text: `Falha ao listar modelos: ${err}`,
            level: "error",
          });
          this.post({ type: "models", profileId: profile.id, models: [] });
        }
        break;
      }
      case "saveAgent": {
        const c = vscode.workspace.getConfiguration("forgeAgent");
        const target = vscode.ConfigurationTarget.Workspace;
        const autonomy = String(msg.autonomy ?? "agent") as AutonomyMode;
        if (
          autonomy === "ask" ||
          autonomy === "plan" ||
          autonomy === "agent" ||
          autonomy === "auto"
        ) {
          await setAutonomy(autonomy);
        }
        await c.update("maxToolRounds", Number(msg.maxToolRounds ?? 25), target);
        await c.update("autoApproveReads", Boolean(msg.autoApproveReads), target);
        await c.update(
          "requireApprovalForWrites",
          Boolean(msg.requireApprovalForWrites),
          target
        );
        await c.update(
          "requireApprovalForTerminal",
          Boolean(msg.requireApprovalForTerminal),
          target
        );
        await c.update("temperature", Number(msg.temperature ?? 0.2), target);
        await c.update(
          "systemPromptExtra",
          String(msg.systemPromptExtra ?? ""),
          target
        );
        await this.onChanged();
        await this.pushState();
        this.post({ type: "toast", text: "Preferências do agent salvas.", level: "ok" });
        break;
      }
      case "openRules":
        await openProjectRules();
        break;
      case "defaultsForProvider": {
        const provider = String(msg.provider ?? "openai") as ProviderId;
        this.post({
          type: "providerDefaults",
          provider,
          model: defaultModel(provider),
          baseUrl: defaultBaseUrl(provider),
          requiresKey: providerRequiresApiKey(provider),
        });
        break;
      }
      default:
        break;
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "webview", "settings.css")
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "webview", "settings.js")
    );
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Forge Agent — Configuração</title>
</head>
<body>
  <div id="app">
    <header class="hero">
      <div>
        <h1>Configuração</h1>
        <p>Perfis BYOK, modelos e comportamento do agent — sem caixas de diálogo.</p>
      </div>
      <div id="toast" class="toast hidden"></div>
    </header>

    <div class="layout">
      <aside class="profiles">
        <div class="aside-head">
          <h2>Perfis</h2>
          <button id="btnNewProfile" class="ghost" type="button">+ Novo</button>
        </div>
        <div id="profileList" class="profile-list"></div>
      </aside>

      <main class="panels">
        <section class="card" id="profileCard">
          <h2 id="profileTitle">Perfil</h2>
          <form id="profileForm" class="form">
            <input type="hidden" id="profileId" />
            <label>
              <span>Nome</span>
              <input id="name" type="text" required />
            </label>
            <label>
              <span>Provedor</span>
              <select id="provider"></select>
            </label>
            <label>
              <span>Modelo</span>
              <div class="row">
                <input id="model" type="text" required />
                <button id="btnListModels" class="ghost" type="button">Listar</button>
              </div>
            </label>
            <div id="modelPicker" class="model-picker hidden"></div>
            <label>
              <span>Base URL</span>
              <input id="baseUrl" type="text" placeholder="https://api.openai.com/v1" />
            </label>
            <label class="check">
              <input id="tlsInsecure" type="checkbox" />
              <span>TLS insecure (certificado self-signed / proxy)</span>
            </label>
            <label>
              <span>API key <em id="keyStatus"></em></span>
              <input id="apiKey" type="password" autocomplete="off" placeholder="Cole uma nova key para salvar" />
            </label>
            <div class="actions">
              <button id="btnSaveProfile" class="primary" type="submit">Salvar perfil</button>
              <button id="btnActivate" class="ghost" type="button">Ativar</button>
              <button id="btnClearKey" class="ghost" type="button">Limpar key</button>
              <button id="btnDeleteProfile" class="danger ghost" type="button">Remover</button>
            </div>
          </form>
        </section>

        <section class="card">
          <h2>Agent</h2>
          <form id="agentForm" class="form">
            <label>
              <span>Autonomia</span>
              <select id="autonomy">
                <option value="ask">ask — só leitura</option>
                <option value="plan">plan — plano antes de editar</option>
                <option value="agent">agent — edits com aprovação</option>
                <option value="auto">auto — aplica writes</option>
              </select>
            </label>
            <label>
              <span>Máx. rounds de tools</span>
              <input id="maxToolRounds" type="number" min="1" max="100" />
            </label>
            <label>
              <span>Temperature</span>
              <input id="temperature" type="number" min="0" max="2" step="0.1" />
            </label>
            <label class="check">
              <input id="autoApproveReads" type="checkbox" />
              <span>Auto-aprovar leituras</span>
            </label>
            <label class="check">
              <input id="requireApprovalForWrites" type="checkbox" />
              <span>Exigir aprovação para writes</span>
            </label>
            <label class="check">
              <input id="requireApprovalForTerminal" type="checkbox" />
              <span>Exigir aprovação para terminal</span>
            </label>
            <label>
              <span>System prompt extra</span>
              <textarea id="systemPromptExtra" rows="4" placeholder="Instruções permanentes para o agent…"></textarea>
            </label>
            <div class="actions">
              <button class="primary" type="submit">Salvar preferências</button>
              <button id="btnOpenRules" class="ghost" type="button">Abrir .forge/rules.md</button>
            </div>
          </form>
        </section>
      </main>
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}
