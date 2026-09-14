import * as vscode from "vscode";
import { KeyStore, promptAndStoreApiKey } from "./secrets/keys";
import { ChatViewProvider } from "./webview/ChatViewProvider";
import { readConfig } from "./config";

export function activate(context: vscode.ExtensionContext): void {
  const keyStore = new KeyStore(context.secrets);
  const chat = new ChatViewProvider(context.extensionUri, keyStore);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chat, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("forgeAgent.openChat", () => chat.openChat()),
    vscode.commands.registerCommand("forgeAgent.newChat", () => chat.newChat()),
    vscode.commands.registerCommand("forgeAgent.stopAgent", () => chat.stop()),
    vscode.commands.registerCommand("forgeAgent.setApiKey", () =>
      promptAndStoreApiKey(keyStore)
    ),
    vscode.commands.registerCommand("forgeAgent.clearApiKey", async () => {
      const config = readConfig();
      await keyStore.clear(config.provider);
      void vscode.window.showInformationMessage(`API key removida (${config.provider}).`);
    }),
    vscode.commands.registerCommand("forgeAgent.explainSelection", async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed || ed.selection.isEmpty) {
        void vscode.window.showWarningMessage("Selecione um trecho de código.");
        return;
      }
      const rel = vscode.workspace.asRelativePath(ed.document.uri);
      const text = ed.document.getText(ed.selection);
      await chat.sendPrompt(
        `Explique este trecho de \`${rel}\` (linhas ${ed.selection.start.line + 1}-${ed.selection.end.line + 1}):\n\n\`\`\`\n${text}\n\`\`\``
      );
    }),
    vscode.commands.registerCommand("forgeAgent.editSelection", async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed || ed.selection.isEmpty) {
        void vscode.window.showWarningMessage("Selecione um trecho de código.");
        return;
      }
      const instruction = await vscode.window.showInputBox({
        title: "Forge Agent — editar seleção",
        prompt: "O que você quer que o agent faça com este trecho?",
        ignoreFocusOut: true,
      });
      if (!instruction) {
        return;
      }
      const rel = vscode.workspace.asRelativePath(ed.document.uri);
      const text = ed.document.getText(ed.selection);
      await chat.sendPrompt(
        `${instruction}\n\nArquivo: \`${rel}\`\nSeleção (linhas ${ed.selection.start.line + 1}-${ed.selection.end.line + 1}):\n\`\`\`\n${text}\n\`\`\`\n\nUse apply_edit ou write_file para aplicar a mudança.`
      );
    })
  );
}

export function deactivate(): void {}
