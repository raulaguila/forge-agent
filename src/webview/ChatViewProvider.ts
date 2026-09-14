import * as vscode from "vscode";
import * as path from "path";
import { cycleAutonomy, readConfig, setActiveModel, setAutonomy } from "../config";
import { sanitizeArgsForUi, summarizeToolRequest } from "../agent/toolSummary";
import { createProvider, providerRequiresApiKey } from "../providers";
import { listModels } from "../providers/models";
import { KeyStore, promptAndStoreApiKey } from "../secrets/keys";
import { AgentSession } from "../agent/session";
import { expandUserMessage, suggestMentions } from "../agent/context";
import { expandSlash, parseSlash, SLASH_COMMANDS } from "../agent/slash";
import { openProjectRules } from "../agent/rules";
import {
  manageProfilesInteractive,
  ProfileStore,
  switchProfileInteractive,
} from "../agent/profiles";
import { SessionStore, titleFromMessages } from "../agent/sessions";
import type { AgentEvent, AutonomyMode, DiffProposal } from "../types";

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "forgeAgent.chatView";

  private view?: vscode.WebviewView;
  private session?: AgentSession;
  private pendingApprovals = new Map<string, { resolve: (ok: boolean) => void }>();
  private currentSessionId?: string;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly keyStore: KeyStore,
    private readonly sessionStore: SessionStore,
    private readonly profileStore: ProfileStore
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case "ready":
          await this.profileStore.ensureSeeded();
          await this.pushConfig();
          break;
        case "send":
          await this.handleSend(String(msg.text ?? ""));
          break;
        case "stop":
          this.session?.stop();
          break;
        case "newChat":
          this.session?.clear();
          this.post({ type: "cleared" });
          break;
        case "setApiKey":
        case "switchProfile":
        case "manageProfiles":
        case "openSettings":
          await vscode.commands.executeCommand("forgeAgent.openSettings");
          break;
        case "pickModel":
          await this.pickModel();
          break;
        case "cycleAutonomy":
          await this.cycleAutonomyMode();
          break;
        case "setAutonomy": {
          const mode = String(msg.mode ?? "") as AutonomyMode;
          if (mode === "ask" || mode === "plan" || mode === "agent" || mode === "auto") {
            await setAutonomy(mode);
            await this.refreshSessionConfig();
            await this.pushConfig();
          }
          break;
        }
        case "approve":
        case "deny": {
          const id = String(msg.toolCallId ?? "");
          const pending = this.pendingApprovals.get(id);
          if (pending) {
            pending.resolve(msg.type === "approve");
            this.pendingApprovals.delete(id);
          }
          break;
        }
        case "searchMentions": {
          const suggestions = await suggestMentions(String(msg.query ?? ""));
          this.post({ type: "mentionSuggestions", suggestions });
          break;
        }
        case "openRules":
          await openProjectRules();
          break;
        case "listSlash": {
          const q = String(msg.query ?? "")
            .replace(/^\//, "")
            .toLowerCase();
          const suggestions = SLASH_COMMANDS.filter(
            (c) => !q || c.name.startsWith(q)
          ).map((c) => ({
            name: c.name,
            description: c.description,
            insert: "/" + c.name + " ",
          }));
          this.post({ type: "slashSuggestions", suggestions, query: q });
          break;
        }
        case "listSessions": {
          this.post({
            type: "sessions",
            sessions: this.sessionStore.list().map((s) => ({
              id: s.id,
              title: s.title,
              updatedAt: s.updatedAt,
            })),
          });
          break;
        }
        case "loadSession": {
          const id = String(msg.id ?? "");
          const saved = this.sessionStore.get(id);
          if (!saved) break;
          this.currentSessionId = saved.id;
          const sess = await this.ensureSession();
          sess?.loadMessages(saved.messages);
          this.post({ type: "cleared" });
          for (const m of saved.messages) {
            if (m.role === "user") this.post({ type: "user", text: m.content });
            if (m.role === "assistant" && m.content) {
              this.post({ type: "agent", event: { type: "assistant_done", text: m.content } });
            }
          }
          break;
        }
        case "deleteSession": {
          await this.sessionStore.remove(String(msg.id ?? ""));
          this.post({
            type: "sessions",
            sessions: this.sessionStore.list().map((s) => ({
              id: s.id,
              title: s.title,
              updatedAt: s.updatedAt,
            })),
          });
          break;
        }
        case "undoCheckpoint": {
          const result = (await this.session?.checkpoints.restore()) ?? "Sem sessão.";
          this.post({ type: "agent", event: { type: "status", text: result } });
          break;
        }
        case "executePlan": {
          const plan = String(msg.plan ?? "");
          if (!plan.trim()) {
            break;
          }
          await setAutonomy("agent");
          await this.refreshSessionConfig();
          await this.pushConfig();
          await this.handleSend(
            `Execute este plano aprovado pelo usuário. Siga os passos, use tools e implemente de fato.\n\n${plan}`
          );
          break;
        }
        default:
          break;
      }
    });
  }

  async openChat(): Promise<void> {
    await vscode.commands.executeCommand("forgeAgent.chatView.focus");
  }

  async newChat(): Promise<void> {
    this.session?.clear();
    this.session?.checkpoints.clear();
    this.currentSessionId = undefined;
    this.post({ type: "cleared" });
  }

  stop(): void {
    this.session?.stop();
  }

  async cycleAutonomyMode(): Promise<void> {
    const next = cycleAutonomy(readConfig().autonomy);
    await setAutonomy(next);
    await this.refreshSessionConfig();
    await this.pushConfig();
    void vscode.window.setStatusBarMessage(`Forge Agent: modo ${next}`, 2500);
  }

  async switchProfile(): Promise<void> {
    const profile = await switchProfileInteractive(this.profileStore);
    if (!profile) return;
    await this.refreshSessionConfig();
    await this.pushConfig();
    void vscode.window.setStatusBarMessage(
      `Forge Agent: ${profile.name} · ${profile.model}`,
      3000
    );
  }

  async manageProfiles(): Promise<void> {
    await manageProfilesInteractive(this.profileStore);
    await this.refreshSessionConfig();
    await this.pushConfig();
  }

  async pickModel(): Promise<void> {
    await this.profileStore.ensureSeeded();
    const config = readConfig();
    const apiKey =
      (await this.keyStore.getForProfile(config.profileId, config.provider)) ?? "";
    if (providerRequiresApiKey(config.provider) && !apiKey) {
      this.post({
        type: "error",
        text: "Configure a API key do perfil ativo antes de listar modelos.",
      });
      await this.setApiKeyForActive();
      return;
    }

    let models;
    try {
      models = await listModels({
        provider: config.provider,
        apiKey,
        baseUrl: config.baseUrl,
        tlsInsecure: config.tlsInsecure,
      });
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      void vscode.window.showErrorMessage(`Não foi possível listar modelos: ${err}`);
      const manual = await vscode.window.showInputBox({
        title: `Modelo (${config.profileName || config.provider})`,
        value: config.model,
        ignoreFocusOut: true,
      });
      if (manual) {
        await setActiveModel(manual.trim());
        await this.refreshSessionConfig();
        await this.pushConfig();
      }
      return;
    }

    if (!models.length) {
      void vscode.window.showWarningMessage("Nenhum modelo retornado por este provedor.");
      return;
    }

    const pick = await vscode.window.showQuickPick(
      models.map((m) => ({
        label: m.label,
        description: m.id === config.model ? "ativo" : undefined,
        detail: m.detail,
        id: m.id,
      })),
      {
        title: `Modelos — ${config.profileName || config.provider}`,
        matchOnDescription: true,
        matchOnDetail: true,
      }
    );
    if (!pick) return;
    await setActiveModel(pick.id);
    await this.refreshSessionConfig();
    await this.pushConfig();
  }

  async sendPrompt(text: string): Promise<void> {
    await this.openChat();
    await this.handleSend(text);
  }

  async insertIntoChat(text: string): Promise<void> {
    await this.openChat();
    this.post({ type: "insertIntoComposer", text });
  }

  async refreshUi(): Promise<void> {
    await this.refreshSessionConfig();
    await this.pushConfig();
  }

  private async setApiKeyForActive(): Promise<void> {
    await this.profileStore.ensureSeeded();
    const config = readConfig();
    await promptAndStoreApiKey(this.keyStore, config.provider, config.profileId);
    const active = this.profileStore.active();
    if (active) {
      const c = vscode.workspace.getConfiguration("forgeAgent");
      active.provider = c.get("provider", active.provider) as typeof active.provider;
      active.model = c.get("model", active.model) || active.model;
      active.baseUrl = (c.get<string>("baseUrl", "") || active.baseUrl).replace(/\/$/, "");
      active.tlsInsecure = c.get("tlsInsecure", active.tlsInsecure);
      await this.profileStore.upsert(active);
      await this.profileStore.setActive(active.id);
    }
    await this.refreshSessionConfig();
  }

  private post(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }

  private async pushConfig(): Promise<void> {
    const config = readConfig();
    const hasKey = await this.keyStore.hasForProfile(config.profileId, config.provider);
    this.post({
      type: "config",
      provider: config.provider,
      model: config.model,
      autonomy: config.autonomy,
      hasKey,
      profileName: config.profileName || config.provider,
      profileId: config.profileId,
    });
  }

  private async rebuildProvider() {
    const config = readConfig();
    const key =
      (await this.keyStore.getForProfile(config.profileId, config.provider)) ?? "";
    return {
      config,
      provider: createProvider({
        provider: config.provider,
        apiKey: key,
        baseUrl: config.baseUrl,
        tlsInsecure: config.tlsInsecure,
      }),
    };
  }

  private async refreshSessionConfig(): Promise<void> {
    if (!this.session) {
      return;
    }
    try {
      const { provider, config } = await this.rebuildProvider();
      this.session.updateProvider(provider, config);
    } catch {
      // ignore until next send
    }
  }

  private async ensureSession(): Promise<AgentSession | undefined> {
    await this.profileStore.ensureSeeded();
    const config = readConfig();
    const apiKey = await this.keyStore.getForProfile(config.profileId, config.provider);
    if (providerRequiresApiKey(config.provider) && !apiKey) {
      this.post({
        type: "error",
        text: "Nenhuma API key configurada. Use “Set API Key (BYOK)”.",
      });
      await this.setApiKeyForActive();
      const cfg2 = readConfig();
      const again = await this.keyStore.getForProfile(cfg2.profileId, cfg2.provider);
      if (providerRequiresApiKey(cfg2.provider) && !again) {
        return undefined;
      }
    }

    let rebuilt;
    try {
      rebuilt = await this.rebuildProvider();
    } catch (e) {
      this.post({
        type: "error",
        text: e instanceof Error ? e.message : String(e),
      });
      return undefined;
    }

    if (!this.session) {
      this.session = new AgentSession(
        rebuilt.provider,
        rebuilt.config,
        (ev) => this.emitAgentEvent(ev),
        (req) => this.requestApproval(req)
      );
    } else {
      this.session.updateProvider(rebuilt.provider, rebuilt.config);
    }
    return this.session;
  }

  private emitAgentEvent(ev: AgentEvent): void {
    if (ev.type === "diff_proposal" && ev.diff) {
      this.post({
        type: "agent",
        event: {
          ...ev,
          args: sanitizeArgsForUi(ev.args),
          diff: {
            path: ev.diff.path,
            isNew: ev.diff.isNew,
            oldContent: "",
            newContent: "",
          },
          summary:
            ev.summary ||
            `${ev.diff.isNew ? "Create" : "Edit"} ${ev.diff.path}`,
        },
      });
      return;
    }
    if (ev.type === "tool_request") {
      this.post({
        type: "agent",
        event: {
          ...ev,
          args: sanitizeArgsForUi(ev.args),
          diff: undefined,
        },
      });
      return;
    }
    this.post({ type: "agent", event: ev });
  }

  private requestApproval(req: {
    toolName: string;
    toolCallId: string;
    args: unknown;
    risk: string;
    diff?: DiffProposal;
  }): Promise<boolean> {
    return new Promise((resolve) => {
      this.pendingApprovals.set(req.toolCallId, { resolve });
      this.post({
        type: "approval",
        toolName: req.toolName,
        toolCallId: req.toolCallId,
        summary: summarizeToolRequest(
          req.toolName,
          (req.args && typeof req.args === "object"
            ? req.args
            : {}) as Record<string, unknown>
        ),
        args: sanitizeArgsForUi(req.args),
        risk: req.risk,
        diff: req.diff
          ? {
              path: req.diff.path,
              isNew: req.diff.isNew,
              bytes: req.diff.newContent.length,
            }
          : undefined,
      });

      if (!this.view?.visible) {
        const detail = req.diff
          ? `${req.diff.isNew ? "Criar" : "Editar"} ${req.diff.path}`
          : req.toolName;
        void vscode.window
          .showWarningMessage(
            `Forge Agent (${req.risk}): ${detail}`,
            "Permitir",
            "Recusar"
          )
          .then((choice) => {
            if (!this.pendingApprovals.has(req.toolCallId)) {
              return;
            }
            this.pendingApprovals.delete(req.toolCallId);
            resolve(choice === "Permitir");
          });
      }
    });
  }

  private async handleSend(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    this.post({ type: "user", text: trimmed });

    if (trimmed === "/help" || trimmed.startsWith("/help ")) {
      const lines = SLASH_COMMANDS.map((c) => `/${c.name} — ${c.description}`);
      this.post({
        type: "agent",
        event: { type: "assistant_done", text: "Comandos slash:\n" + lines.join("\n") },
      });
      this.post({ type: "agent", event: { type: "done" } });
      return;
    }

    const { command, rest } = parseSlash(trimmed);
    let prompt = trimmed;
    if (command) {
      if (command.autonomy) {
        await setAutonomy(command.autonomy);
        await this.refreshSessionConfig();
        await this.pushConfig();
      }
      prompt = expandSlash(command, rest);
    }

    const session = await this.ensureSession();
    if (!session) {
      this.post({ type: "agent", event: { type: "done" } });
      return;
    }
    const expanded = await expandUserMessage(prompt);
    await session.run(expanded);
    await this.persistSession();
  }

  private async persistSession(): Promise<void> {
    if (!this.session) return;
    const messages = this.session.history;
    if (!messages.length) return;
    const existing = this.currentSessionId
      ? this.sessionStore.get(this.currentSessionId)
      : undefined;
    const saved = existing ?? this.sessionStore.createEmpty();
    saved.messages = messages;
    saved.updatedAt = Date.now();
    saved.title = titleFromMessages(messages);
    this.currentSessionId = saved.id;
    await this.sessionStore.save(saved);
  }

  async undoLastCheckpoint(): Promise<void> {
    const result = (await this.session?.checkpoints.restore()) ?? "Sem checkpoint.";
    void vscode.window.showInformationMessage(result);
  }

  private getHtml(webview: vscode.Webview): string {
    const mediaDir = path.join(this.extensionUri.fsPath, "media", "webview");
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(mediaDir, "main.js"))
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(mediaDir, "styles.css"))
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
  <title>Forge Agent</title>
</head>
<body>
  <div id="app">
    <header class="top">
      <div class="brand">
        <span class="mark" aria-hidden="true"></span>
        <div class="brand-text">
          <div class="name">Forge</div>
        </div>
      </div>
      <div class="top-actions">
        <button id="btnNew" class="icon-btn" title="Novo chat" aria-label="Novo chat">＋</button>
        <div class="menu-wrap">
          <button id="btnMenu" class="icon-btn" title="Mais opções" aria-label="Mais opções" aria-expanded="false">⋯</button>
          <div id="overflowMenu" class="menu hidden" role="menu">
            <button type="button" data-action="settings" role="menuitem">Configurações</button>
            <button type="button" data-action="history" role="menuitem">Histórico</button>
            <button type="button" data-action="undo" role="menuitem">Desfazer checkpoint</button>
          </div>
        </div>
      </div>
    </header>

    <main id="messages"></main>
    <section id="approval" class="approval hidden"></section>
    <div id="usage" class="usage hidden"></div>

    <footer class="composer">
      <div class="composer-card">
        <div id="mentionPopup" class="mention-popup hidden"></div>
        <textarea id="input" rows="3" placeholder="Pergunte ao Forge…  @arquivo  /plan"></textarea>
        <div class="composer-bar">
          <button id="btnMode" class="chip mode" title="Modo de autonomia" type="button">agent</button>
          <button id="btnModel" class="chip model" title="Modelo / provedor" type="button">modelo</button>
          <span class="spacer"></span>
          <button id="btnStop" class="chip danger hidden" title="Parar" type="button">Parar</button>
          <button id="btnSend" class="send" type="button" title="Enviar">↑</button>
        </div>
      </div>
    </footer>
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
