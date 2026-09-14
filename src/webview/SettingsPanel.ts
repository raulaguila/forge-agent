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
        await this.fetchAndPostModels({ profileId: id, autoSelect: false });
        break;
      }
      case "createProfile": {
        const provider = (String(msg.provider ?? "openai") || "openai") as ProviderId;
        const requestedModel = String(msg.model ?? "").trim();
        const profile: ProviderProfile = {
          id: newProfileId(),
          name: String(msg.name ?? "").trim() || labelFor(provider),
          provider,
          model: requestedModel || defaultModel(provider),
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
        const models = await this.fetchAndPostModels({
          profileId: profile.id,
          autoSelect: !requestedModel,
        });
        if (!requestedModel && models[0]) {
          profile.model = models[0].id;
          await this.profileStore.upsert(profile);
          await syncSettingsFromProfile(profile);
          await this.pushState();
          this.post({
            type: "models",
            profileId: profile.id,
            models,
            selected: profile.model,
            autoSelect: false,
          });
        }
        this.post({
          type: "toast",
          text: models.length
            ? `Perfil “${profile.name}” criado. Selecione o modelo.`
            : `Perfil “${profile.name}” criado.`,
          level: "ok",
        });
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
        const requestedModel = String(msg.model ?? existing.model).trim();
        const updated: ProviderProfile = {
          id,
          name: String(msg.name ?? existing.name).trim() || existing.name,
          provider,
          model: requestedModel || defaultModel(provider),
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
        await this.fetchAndPostModels({ profileId: id, autoSelect: false });
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
      case "listModels":
      case "fetchModels": {
        await this.fetchAndPostModels({
          profileId: String(msg.profileId ?? msg.id ?? "") || undefined,
          provider: msg.provider ? (String(msg.provider) as ProviderId) : undefined,
          baseUrl: msg.baseUrl != null ? String(msg.baseUrl) : undefined,
          tlsInsecure: msg.tlsInsecure != null ? Boolean(msg.tlsInsecure) : undefined,
          apiKey: msg.apiKey != null ? String(msg.apiKey) : undefined,
          autoSelect: Boolean(msg.autoSelect),
          selected: msg.selected != null ? String(msg.selected) : undefined,
        });
        break;
      }
      case "setModel": {
        const id = String(msg.profileId ?? msg.id ?? "");
        const model = String(msg.model ?? "").trim();
        const profile = this.profileStore.get(id);
        if (!profile || !model) break;
        profile.model = model;
        await this.profileStore.upsert(profile);
        if (this.profileStore.active()?.id === id) {
          await syncSettingsFromProfile(profile);
        }
        await this.onChanged();
        await this.pushState();
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

  private async fetchAndPostModels(opts: {
    profileId?: string;
    provider?: ProviderId;
    baseUrl?: string;
    tlsInsecure?: boolean;
    apiKey?: string;
    autoSelect?: boolean;
    selected?: string;
  }): Promise<Array<{ id: string; label: string; detail?: string }>> {
    const profile = opts.profileId
      ? this.profileStore.get(opts.profileId)
      : this.profileStore.active();
    const provider = (opts.provider ?? profile?.provider ?? "openai") as ProviderId;
    const baseUrl =
      (opts.baseUrl ?? profile?.baseUrl ?? "").replace(/\/$/, "") || defaultBaseUrl(provider);
    const tlsInsecure = opts.tlsInsecure ?? profile?.tlsInsecure ?? false;
    let apiKey = (opts.apiKey ?? "").trim();
    if (!apiKey && profile) {
      apiKey = (await this.keyStore.getForProfile(profile.id, provider)) ?? "";
    }
    if (providerRequiresApiKey(provider) && !apiKey) {
      this.post({
        type: "models",
        profileId: profile?.id,
        models: [],
        selected: opts.selected ?? profile?.model,
        status: "missing-key",
      });
      return [];
    }
    this.post({
      type: "modelsStatus",
      status: "loading",
      profileId: profile?.id,
    });
    try {
      const models = await listModels({
        provider,
        apiKey,
        baseUrl,
        tlsInsecure,
      });
      let selected = opts.selected ?? profile?.model ?? "";
      if (opts.autoSelect && models.length && !models.some((m) => m.id === selected)) {
        selected = models[0].id;
      }
      this.post({
        type: "models",
        profileId: profile?.id,
        models,
        selected,
        autoSelect: Boolean(opts.autoSelect),
        status: "ok",
      });
      return models;
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      this.post({
        type: "toast",
        text: `Falha ao listar modelos: ${err}`,
        level: "error",
      });
      this.post({
        type: "models",
        profileId: profile?.id,
        models: [],
        selected: opts.selected ?? profile?.model,
        status: "error",
      });
      return [];
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
              <span>Base URL</span>
              <input id="baseUrl" type="text" placeholder="https://api.openai.com/v1" />
            </label>
            <label class="check">
              <input id="tlsInsecure" type="checkbox" />
              <span>TLS insecure (certificado self-signed / proxy)</span>
            </label>
            <label>
              <span>API key <em id="keyStatus"></em></span>
              <input id="apiKey" type="password" autocomplete="off" placeholder="Cole a key do provedor" />
            </label>
            <label>
              <span>Modelo <em id="modelStatus"></em></span>
              <div class="row">
                <select id="model" required>
                  <option value="">Preencha a key para listar…</option>
                </select>
                <button id="btnListModels" class="ghost" type="button">Atualizar</button>
              </div>
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
                <option value="ask">chat — conversa sem tools</option>
                <option value="plan">plan — investiga e propõe plano</option>
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
