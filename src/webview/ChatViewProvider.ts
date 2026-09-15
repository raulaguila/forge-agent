import * as vscode from "vscode";
import * as path from "path";
import { cycleAutonomy, readConfig, setActiveModel, setAutonomy } from "../config";
import { sanitizeArgsForUi, summarizeToolRequest } from "../agent/toolSummary";
import { createProvider, providerRequiresApiKey } from "../providers";
import { listModels } from "../providers/models";
import { KeyStore } from "../secrets/keys";
import { AgentSession } from "../agent/session";
import { expandUserMessage, suggestMentions } from "../agent/context";
import { getPreferredSelection } from "../agent/editorContext";
import { expandSlash, parseSlash, SLASH_COMMANDS } from "../agent/slash";
import { openProjectRules } from "../agent/rules";
import { ProfileStore } from "../agent/profiles";
import { SessionStore, titleFromMessages } from "../agent/sessions";
import type { AgentEvent, AutonomyMode, DiffProposal } from "../types";
import { logError, logInfo, logWarn, showLog } from "../log";

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "forgeAgent.chatView";

  private view?: vscode.WebviewView;
  private panel?: vscode.WebviewPanel;
  private session?: AgentSession;
  private pendingApprovals = new Map<string, { resolve: (ok: boolean) => void }>();
  private currentSessionId?: string;
  private editContext?: {
    filePath: string;
    language: string;
    selection: string;
    startLine: number;
    endLine: number;
  };

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
    logInfo("Resolving chat webview");
    webviewView.onDidChangeVisibility(() => {
      logInfo("Sidebar webview visibility", { visible: webviewView.visible });
    });
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    try {
      webviewView.webview.html = this.getHtml(webviewView.webview);
      logInfo("Chat webview HTML assigned");
      // If the webview never calls ready, surface that in Output.
      setTimeout(() => {
        if (!this.view) return;
        logWarn("Webview still mounted 3s after HTML assign — if UI is blank, run Forge Agent: Show Logs and check for webview errors");
      }, 3000);
    } catch (e) {
      logError("Failed to build chat HTML", e);
      showLog();
      webviewView.webview.html = `<!DOCTYPE html><html><body style="font:13px sans-serif;padding:12px;color:#f48771">
        <h3>Forge Agent — erro ao montar UI</h3>
        <pre>${String(e instanceof Error ? e.stack || e.message : e).replace(/</g, "&lt;")}</pre>
        <p>Abra Output → Forge Agent ou rode “Forge Agent: Show Logs”.</p>
      </body></html>`;
    }

    webviewView.webview.onDidReceiveMessage((msg) => {
      void this.handleWebviewMessage(msg);
    });
  }

  private async handleWebviewMessage(msg: any): Promise<void> {
      switch (msg.type) {
        case "ready":
          logInfo("Webview ready");
          await this.profileStore.ensureSeeded();
          await this.pushConfig();
          break;
        case "webviewLog":
        case "webviewLog": {
          const level = String(msg.level ?? "info");
          const text = String(msg.message ?? "");
          if (level === "error") logError("webview: " + text, msg.detail);
          else if (level === "warn") logWarn("webview: " + text, msg.detail);
          else logInfo("webview: " + text, msg.detail);
          break;
        }
        case "send": {
          const text = String(msg.text ?? "");
          if (msg.edit && this.editContext) {
            await this.handleEditSend(text);
          } else {
            await this.handleSend(text);
          }
          break;
        }
        case "exitEdit":
          this.clearEditContext();
          break;
        case "stop":
          this.session?.stop();
          break;
        case "newChat":
          this.clearEditContext();
          this.session?.clear();
          this.post({ type: "cleared" });
          break;
        case "openSettings":
        case "setApiKey":
        case "switchProfile":
        case "manageProfiles":
          await vscode.commands.executeCommand("forgeAgent.openSettings");
          break;
        case "pickModel":
          await this.pickModel();
          break;
        case "listModels":
          await this.pushModels();
          break;
        case "selectModel": {
          const model = String(msg.model ?? "").trim();
          if (model) {
            await setActiveModel(model);
            await this.refreshSessionConfig();
            await this.pushConfig();
          }
          break;
        }
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
            sessions: this.sessionStore.list().slice(0, 12).map((s) => ({
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
  }

  async openChat(): Promise<void> {
    logInfo("openChat: restoring + revealing sidebar chat view");
    // If the user (or VS Code) removed/hid the Chat view, the activity-bar
    // container opens empty and resolveWebviewView never runs. Restore first.
    for (const cmd of [
      `${ChatViewProvider.viewType}.resetViewLocation`,
      `${ChatViewProvider.viewType}.open`,
      "workbench.view.extension.forge-agent",
      `${ChatViewProvider.viewType}.focus`,
    ]) {
      try {
        await vscode.commands.executeCommand(cmd);
        logInfo("openChat: ran", cmd);
      } catch (e) {
        logWarn("openChat: command failed", cmd, e);
      }
    }

    // If the sidebar webview still never resolved, fall back to an editor panel.
    await new Promise((r) => setTimeout(r, 500));
    if (!this.view) {
      logWarn("openChat: sidebar webview not resolved — opening editor panel fallback");
      void vscode.window.showInformationMessage(
        "Forge: a view Chat da sidebar está vazia/removida; abrindo no editor. Use “View: Reset View Locations” se quiser restaurar a sidebar."
      );
      await this.openChatPanel();
    } else {
      logInfo("openChat: sidebar webview is active");
      this.view.show?.(true);
    }
  }

  /** Restore Chat view into the Forge sidebar container and open it. */
  async repairSidebar(): Promise<void> {
    logInfo("repairSidebar: resetting chat view location");
    for (const cmd of [
      `${ChatViewProvider.viewType}.resetViewLocation`,
      "workbench.action.resetViewLocations",
      `${ChatViewProvider.viewType}.open`,
      "workbench.view.extension.forge-agent",
      `${ChatViewProvider.viewType}.focus`,
    ]) {
      try {
        await vscode.commands.executeCommand(cmd);
        logInfo("repairSidebar: ran", cmd);
      } catch (e) {
        logWarn("repairSidebar: command failed", cmd, e);
      }
    }
    await new Promise((r) => setTimeout(r, 600));
    if (!this.view) {
      logWarn("repairSidebar: still unresolved — opening editor panel");
      await this.openChatPanel();
    }
  }

  async openChatPanel(): Promise<void> {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside, false);
      return;
    }
    logInfo("Creating Forge chat editor panel");
    const panel = vscode.window.createWebviewPanel(
      "forgeAgent.chatPanel",
      "Forge Chat",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
      }
    );
    this.panel = panel;
    panel.webview.html = this.getHtml(panel.webview);
    panel.webview.onDidReceiveMessage((msg) => {
      void this.handleWebviewMessage(msg);
    });
    panel.onDidDispose(() => {
      if (this.panel === panel) this.panel = undefined;
      logInfo("Chat editor panel disposed");
    });
  }

  async newChat(): Promise<void> {
    this.clearEditContext();
    this.session?.clear();
    this.session?.checkpoints.clear();
    this.currentSessionId = undefined;
    this.post({ type: "cleared" });
  }

  /** Continue-style Edit: abre o chat com chrome de edição da seleção atual. */
  async enterEditMode(): Promise<void> {
    const ctx = getPreferredSelection();
    if (!ctx || ctx.selection.isEmpty) {
      void vscode.window.showWarningMessage("Selecione um trecho de código.");
      return;
    }

    const filePath = vscode.workspace.asRelativePath(ctx.document.uri);
    const selection = ctx.document.getText(ctx.selection);
    const startLine = ctx.selection.start.line + 1;
    const endLine = ctx.selection.end.line + 1;

    this.editContext = {
      filePath,
      language: ctx.document.languageId,
      selection,
      startLine,
      endLine,
    };

    await this.openChat();
    await setAutonomy("agent");
    await this.refreshSessionConfig();
    await this.pushConfig();
    this.post({
      type: "editMode",
      active: true,
      fileName: filePath,
      startLine,
      endLine,
      selectionPreview: selection.slice(0, 240),
    });
  }

  private clearEditContext(): void {
    this.editContext = undefined;
    this.post({ type: "editMode", active: false });
  }

  private async handleEditSend(instruction: string): Promise<void> {
    const ctx = this.editContext;
    if (!ctx) {
      await this.handleSend(instruction);
      return;
    }
    const prompt = [
      `Edite a seleção em @${ctx.filePath} (linhas ${ctx.startLine}–${ctx.endLine}).`,
      "",
      "Instrução do usuário:",
      instruction.trim(),
      "",
      "Trecho atual:",
      "```" + (ctx.language || ""),
      ctx.selection,
      "```",
      "",
      "Use apply_edit ou write_file para aplicar as mudanças.",
    ].join("\n");
    this.clearEditContext();
    await this.handleSend(prompt);
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
    await vscode.commands.executeCommand("forgeAgent.openSettings");
  }

  async manageProfiles(): Promise<void> {
    await vscode.commands.executeCommand("forgeAgent.openSettings");
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
      await vscode.commands.executeCommand("forgeAgent.openSettings");
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

  private post(message: unknown): void {
    void this.view?.webview.postMessage(message);
    void this.panel?.webview.postMessage(message);
  }

  /** Opens the Forge settings editor tab (not VS Code Settings). */
  showSettings(): void {
    void vscode.commands.executeCommand("forgeAgent.openSettings");
  }

  hasView(): boolean {
    return Boolean(this.view || this.panel);
  }

  /** True only when the activity-bar webview resolved (not the editor panel). */
  hasSidebarView(): boolean {
    return Boolean(this.view);
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
    this.postRecentSessions();
  }

  private postRecentSessions(): void {
    this.post({
      type: "sessions",
      sessions: this.sessionStore.list().slice(0, 5).map((s) => ({
        id: s.id,
        title: s.title,
        updatedAt: s.updatedAt,
      })),
    });
  }

  private async pushModels(): Promise<void> {
    const config = readConfig();
    const apiKey =
      (await this.keyStore.getForProfile(config.profileId, config.provider)) ?? "";
    try {
      const models = await listModels({
        provider: config.provider,
        apiKey,
        baseUrl: config.baseUrl,
        tlsInsecure: config.tlsInsecure,
      });
      this.post({
        type: "models",
        models: models.map((m) => ({ id: m.id, label: m.label || m.id })),
      });
    } catch {
      this.post({
        type: "models",
        models: config.model ? [{ id: config.model, label: config.model }] : [],
      });
    }
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
        text: "Nenhuma API key configurada. Abra Configurações (⚙) para definir a chave do perfil.",
      });
      await vscode.commands.executeCommand("forgeAgent.openSettings");
      return undefined;
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
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "webview", "main.js")
    );
    const markdownUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "webview", "markdown.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "webview", "styles.css")
    );
    const nonce = getNonce();
    logInfo("Webview assets", {
      script: String(scriptUri),
      style: String(styleUri),
      markdown: String(markdownUri),
    });

    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <style>
    /* Critical fallback if styles.css fails to load — prefer VS Code theme tokens */
    html,body{height:100%;margin:0;background:var(--vscode-sideBar-background,#1e1e1e);color:var(--vscode-foreground,#ccc);font:13px/1.4 var(--vscode-font-family,system-ui,sans-serif)}
    #app{display:flex;flex-direction:column;height:100%;min-height:0}
    #messages{flex:1;overflow:auto;padding:16px}
    .composer{padding:10px 12px 12px}
    #bootError{display:none;margin:12px;padding:10px;border:1px solid var(--vscode-errorForeground,#f48771);border-radius:8px;color:var(--vscode-errorForeground,#f48771);white-space:pre-wrap}
    .empty-fallback{opacity:.75;text-align:center;margin-top:24px}
  </style>
  <title>Forge Agent</title>
</head>
<body>
  <div id="bootError"></div>
  <div id="app">
    <header class="top">
      <div class="brand">
        <span class="mark" aria-hidden="true"></span>
        <div class="brand-text">
          <div class="name">Forge</div>
        </div>
      </div>
      <div class="top-actions">
        <button id="btnDemo" class="text-btn" title="Prévia visual" type="button" aria-pressed="false">Demo</button>
        <button id="btnNew" class="icon-btn" title="Novo chat" aria-label="Novo chat">＋</button>
        <div class="menu-wrap">
          <button id="btnMenu" class="icon-btn" title="Mais opções" aria-label="Mais opções" aria-expanded="false">⋯</button>
          <div id="overflowMenu" class="menu hidden" role="menu">
            <button type="button" data-action="settings" role="menuitem">Configurações</button>
            <button type="button" data-action="history" role="menuitem">Histórico</button>
            <button type="button" data-action="undo" role="menuitem">Desfazer checkpoint</button>
            <button type="button" data-action="demo" role="menuitem">Prévia visual</button>
          </div>
        </div>
      </div>
    </header>

    <div id="modeBanner" class="mode-banner" role="status"></div>
    <div id="editBanner" class="edit-banner hidden" role="status">
      <button type="button" id="btnExitEdit" class="edit-back" title="Sair do Edit (Esc)">←</button>
      <div class="edit-copy">
        <div class="edit-title">Editing <span id="editFile">arquivo</span></div>
        <div class="edit-meta" id="editMeta">seleção</div>
      </div>
      <kbd class="edit-esc">Esc</kbd>
    </div>

    <main id="messages">
      <div class="empty empty-fallback" id="staticEmpty" style="text-align:center;padding:28px 12px;color:#ddd">
        <div class="hero-mark" style="width:28px;height:28px;border-radius:8px;background:#c9954a;margin:0 auto 10px"></div>
        <h1 style="margin:0 0 8px;font-size:20px;color:#fff">Forge</h1>
        <p style="margin:0;opacity:.8">Carregando interface… Se isto não sumir, rode <b>Forge Agent: Show Logs</b>.</p>
      </div>
    </main>
    <section id="approval" class="approval hidden"></section>
    <div id="usage" class="usage hidden"></div>

    <footer class="composer">
      <div class="composer-card">
        <div id="contextStrip" class="context-strip hidden">
          <span class="context-dot" aria-hidden="true"></span>
          <span id="contextLabel" class="context-label">Seleção · 12 linhas</span>
          <button type="button" class="context-clear" id="btnClearContext" title="Ocultar">×</button>
        </div>
        <div id="mentionPopup" class="mention-popup hidden"></div>
        <textarea id="input" rows="2" placeholder="Pergunte sobre o código…"></textarea>
        <div class="composer-bar">
          <div class="bar-left">
            <div class="select-wrap" id="modeWrap">
              <button id="btnMode" class="pill mode" type="button" aria-haspopup="listbox" aria-expanded="false" title="Modo">
                <span class="pill-icon" id="modeIcon" aria-hidden="true">✦</span>
                <span class="pill-label" id="modeLabel">Agent</span>
                <span class="pill-caret" aria-hidden="true">▾</span>
              </button>
              <div id="modeMenu" class="popover mode-popover hidden" role="listbox">
                <button type="button" class="pop-item" data-mode="ask" role="option">
                  <span class="pop-icon">💬</span>
                  <span class="pop-text">
                    <span class="pop-label">Ask</span>
                    <span class="pop-hint">Lê o repo e responde</span>
                  </span>
                  <span class="pop-check"></span>
                </button>
                <button type="button" class="pop-item" data-mode="plan" role="option">
                  <span class="pop-icon">☰</span>
                  <span class="pop-text">
                    <span class="pop-label">Plan</span>
                    <span class="pop-hint">Investiga e propõe plano</span>
                  </span>
                  <span class="pop-check"></span>
                </button>
                <button type="button" class="pop-item" data-mode="agent" role="option">
                  <span class="pop-icon">✦</span>
                  <span class="pop-text">
                    <span class="pop-label">Agent</span>
                    <span class="pop-hint">Edita com aprovação</span>
                  </span>
                  <span class="pop-check"></span>
                </button>
                <button type="button" class="pop-item" data-mode="auto" role="option">
                  <span class="pop-icon">⚡</span>
                  <span class="pop-text">
                    <span class="pop-label">Auto</span>
                    <span class="pop-hint">Aplica writes sozinho</span>
                  </span>
                  <span class="pop-check"></span>
                </button>
                <div class="pop-footer">Ctrl . próximo modo</div>
              </div>
            </div>

            <div class="select-wrap" id="modelWrap">
              <button id="btnModel" class="pill model" type="button" aria-haspopup="listbox" aria-expanded="false" title="Modelo">
                <span class="pill-label" id="modelLabel">modelo</span>
                <span class="pill-caret" aria-hidden="true">▾</span>
              </button>
              <div id="modelMenu" class="popover model-popover hidden" role="listbox">
                <div class="pop-header">
                  <span>Models</span>
                  <button type="button" id="btnModelSettings" class="icon-btn tiny" title="Configurações">⚙</button>
                </div>
                <div id="modelList" class="pop-list"></div>
                <button type="button" class="pop-item add" id="btnAddModel">
                  <span class="pop-icon">＋</span><span class="pop-label">Add model</span>
                </button>
                <div class="pop-footer">Ctrl ' alternar modelo</div>
              </div>
            </div>

            <button id="btnComposerSettings" class="icon-btn tiny" type="button" title="Configurações" aria-label="Configurações">⚙</button>
          </div>

          <div class="bar-right">
            <button id="btnStop" class="chip danger hidden" title="Parar" type="button">Parar</button>
            <button id="btnSend" class="send" type="button" title="Enviar (Enter)" aria-label="Enviar">
              <span class="send-icon" aria-hidden="true">↑</span>
            </button>
          </div>
        </div>
      </div>
    </footer>

  </div>
  <script nonce="${nonce}">
    (function () {
      // acquireVsCodeApi() can only be called once per webview session.
      var api = acquireVsCodeApi();
      window.__forgeVscode = api;
      function show(err) {
        var el = document.getElementById("bootError");
        if (!el) return;
        el.style.display = "block";
        el.textContent = "Forge UI error: " + err;
        try { api.postMessage({ type: "webviewLog", level: "error", message: String(err) }); } catch (_) {}
      }
      window.addEventListener("error", function (e) {
        show((e && e.message) || "script error");
      });
      window.addEventListener("unhandledrejection", function (e) {
        show((e && e.reason && (e.reason.message || e.reason)) || "promise rejection");
      });
      try { api.postMessage({ type: "webviewLog", level: "info", message: "inline boot ok" }); } catch (_) {}
    })();
  </script>
  <script nonce="${nonce}" src="${markdownUri}"></script>
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
