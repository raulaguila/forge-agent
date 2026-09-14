import * as vscode from "vscode";
import * as path from "path";
import { cycleAutonomy, readConfig, setAutonomy } from "../config";
import { createProvider, providerRequiresApiKey } from "../providers";
import { KeyStore, promptAndStoreApiKey } from "../secrets/keys";
import { AgentSession } from "../agent/session";
import { expandUserMessage, suggestMentions } from "../agent/context";
import type { AgentEvent, AutonomyMode, DiffProposal } from "../types";

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "forgeAgent.chatView";

  private view?: vscode.WebviewView;
  private session?: AgentSession;
  private pendingApprovals = new Map<string, { resolve: (ok: boolean) => void }>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly keyStore: KeyStore
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
          await promptAndStoreApiKey(this.keyStore);
          await this.pushConfig();
          break;
        case "cycleAutonomy":
          await this.cycleAutonomyMode();
          break;
        case "setAutonomy": {
          const mode = String(msg.mode ?? "") as AutonomyMode;
          if (mode === "ask" || mode === "agent" || mode === "auto") {
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
        case "insertText": {
          this.post({ type: "insertIntoComposer", text: String(msg.text ?? "") });
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

  async sendPrompt(text: string): Promise<void> {
    await this.openChat();
    await this.handleSend(text);
  }

  /** Insere texto no composer (ex.: seleção do editor). */
  async insertIntoChat(text: string): Promise<void> {
    await this.openChat();
    this.post({ type: "insertIntoComposer", text });
  }

  private post(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }

  private async pushConfig(): Promise<void> {
    const config = readConfig();
    const hasKey = await this.keyStore.has(config.provider);
    this.post({
      type: "config",
      provider: config.provider,
      model: config.model,
      autonomy: config.autonomy,
      hasKey,
    });
  }

  private async rebuildProvider() {
    const config = readConfig();
    const key = (await this.keyStore.get(config.provider)) ?? "";
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
    const config = readConfig();
    const apiKey = await this.keyStore.get(config.provider);
    if (providerRequiresApiKey(config.provider) && !apiKey) {
      this.post({
        type: "error",
        text: "Nenhuma API key configurada. Use “Set API Key (BYOK)”.",
      });
      const chosen = await promptAndStoreApiKey(this.keyStore, config.provider);
      if (!chosen) {
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
        args: req.args,
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
    const session = await this.ensureSession();
    if (!session) {
      this.post({ type: "agent", event: { type: "done" } });
      return;
    }
    const expanded = await expandUserMessage(trimmed);
    await session.run(expanded);
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
        <span class="mark"></span>
        <div>
          <div class="name">Forge Agent</div>
          <div class="meta" id="meta">BYOK</div>
        </div>
      </div>
      <div class="actions">
        <button id="btnMode" class="ghost mode" title="Ciclar modo ask / agent / auto">agent</button>
        <button id="btnKey" class="ghost" title="API Key">Key</button>
        <button id="btnNew" class="ghost" title="Novo chat">New</button>
        <button id="btnStop" class="ghost danger" title="Parar">Stop</button>
      </div>
    </header>
    <main id="messages"></main>
    <section id="approval" class="approval hidden"></section>
    <div id="usage" class="usage hidden"></div>
    <footer class="composer">
      <div class="composer-wrap">
        <div id="mentionPopup" class="mention-popup hidden"></div>
        <textarea id="input" rows="3" placeholder="Peça ao agent… Use @arquivo, @pasta/, @selection ou @active"></textarea>
      </div>
      <button id="btnSend" class="primary">Enviar</button>
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
