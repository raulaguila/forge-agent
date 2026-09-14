import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { readConfig } from "../config";
import { createProvider, providerRequiresApiKey } from "../providers";
import { KeyStore, promptAndStoreApiKey } from "../secrets/keys";
import { AgentSession } from "../agent/session";
import type { AgentEvent } from "../types";

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "forgeAgent.chatView";

  private view?: vscode.WebviewView;
  private session?: AgentSession;
  private pendingApprovals = new Map<
    string,
    { resolve: (ok: boolean) => void }
  >();

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
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, "media"),
        vscode.Uri.joinPath(this.extensionUri, "src", "webview", "media"),
      ],
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

  async sendPrompt(text: string): Promise<void> {
    await this.openChat();
    await this.handleSend(text);
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
      hasKey,
    });
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

    const freshConfig = readConfig();
    const key = (await this.keyStore.get(freshConfig.provider)) ?? "";
    let provider;
    try {
      provider = createProvider({
        provider: freshConfig.provider,
        apiKey: key,
        baseUrl: freshConfig.baseUrl,
        tlsInsecure: freshConfig.tlsInsecure,
      });
    } catch (e) {
      this.post({
        type: "error",
        text: e instanceof Error ? e.message : String(e),
      });
      return undefined;
    }

    if (!this.session) {
      this.session = new AgentSession(
        provider,
        freshConfig,
        (ev) => this.emitAgentEvent(ev),
        (req) => this.requestApproval(req)
      );
    } else {
      this.session.updateProvider(provider, freshConfig);
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
  }): Promise<boolean> {
    return new Promise((resolve) => {
      this.pendingApprovals.set(req.toolCallId, { resolve });
      this.post({
        type: "approval",
        toolName: req.toolName,
        toolCallId: req.toolCallId,
        args: req.args,
        risk: req.risk,
      });

      if (!this.view?.visible) {
        void vscode.window
          .showWarningMessage(
            `Forge Agent quer executar ${req.toolName} (${req.risk})`,
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
      return;
    }
    await session.run(trimmed);
  }

  private getHtml(webview: vscode.Webview): string {
    const mediaCandidates = [
      path.join(this.extensionUri.fsPath, "media", "webview"),
      path.join(this.extensionUri.fsPath, "src", "webview", "media"),
    ];
    const mediaDir =
      mediaCandidates.find((p) => fs.existsSync(path.join(p, "main.js"))) ??
      mediaCandidates[0];

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
        <button id="btnKey" class="ghost" title="API Key">Key</button>
        <button id="btnNew" class="ghost" title="Novo chat">New</button>
        <button id="btnStop" class="ghost danger" title="Parar">Stop</button>
      </div>
    </header>
    <main id="messages"></main>
    <section id="approval" class="approval hidden"></section>
    <footer class="composer">
      <textarea id="input" rows="3" placeholder="Peça ao agent para implementar, depurar ou refatorar…"></textarea>
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
