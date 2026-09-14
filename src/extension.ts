import * as vscode from "vscode";
import { KeyStore, promptAndStoreApiKey } from "./secrets/keys";
import { ChatViewProvider } from "./webview/ChatViewProvider";
import { bindProfileStore, readConfig } from "./config";
import { selectionAsPrompt } from "./agent/context";
import { SessionStore } from "./agent/sessions";
import { openProjectRules } from "./agent/rules";
import { ProfileStore } from "./agent/profiles";

export function activate(context: vscode.ExtensionContext): void {
  const keyStore = new KeyStore(context.secrets);
  const sessionStore = new SessionStore(context.workspaceState);
  const profileStore = new ProfileStore(context.globalState);
  bindProfileStore(profileStore);
  void profileStore.ensureSeeded();

  const chat = new ChatViewProvider(
    context.extensionUri,
    keyStore,
    sessionStore,
    profileStore
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chat, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("forgeAgent.openChat", () => chat.openChat()),
    vscode.commands.registerCommand("forgeAgent.newChat", () => chat.newChat()),
    vscode.commands.registerCommand("forgeAgent.stopAgent", () => chat.stop()),
    vscode.commands.registerCommand("forgeAgent.cycleAutonomy", () =>
      chat.cycleAutonomyMode()
    ),
    vscode.commands.registerCommand("forgeAgent.undoCheckpoint", () =>
      chat.undoLastCheckpoint()
    ),
    vscode.commands.registerCommand("forgeAgent.openRules", () => openProjectRules()),
    vscode.commands.registerCommand("forgeAgent.switchProfile", () => chat.switchProfile()),
    vscode.commands.registerCommand("forgeAgent.pickModel", () => chat.pickModel()),
    vscode.commands.registerCommand("forgeAgent.manageProfiles", () =>
      chat.manageProfiles()
    ),
    vscode.commands.registerCommand("forgeAgent.focusChatInput", () => chat.openChat()),
    vscode.commands.registerCommand("forgeAgent.addSelectionToChat", async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed || ed.selection.isEmpty) {
        void vscode.window.showWarningMessage("Selecione um trecho de código.");
        return;
      }
      const rel = vscode.workspace.asRelativePath(ed.document.uri);
      const text = ed.document.getText(ed.selection);
      await chat.insertIntoChat(
        `@${rel}\n\`\`\`\n${text}\n\`\`\`\n\n`
      );
    }),
    vscode.commands.registerCommand("forgeAgent.setApiKey", async () => {
      await profileStore.ensureSeeded();
      const config = readConfig();
      await promptAndStoreApiKey(keyStore, config.provider, config.profileId);
      await chat.refreshUi();
    }),
    vscode.commands.registerCommand("forgeAgent.clearApiKey", async () => {
      const config = readConfig();
      if (config.profileId) {
        await keyStore.clearForProfile(config.profileId);
      }
      await keyStore.clear(config.provider);
      void vscode.window.showInformationMessage(
        `API key removida (${config.profileName || config.provider}).`
      );
    }),
    vscode.commands.registerCommand("forgeAgent.explainSelection", async () => {
      const prompt = selectionAsPrompt("Explique este trecho:");
      if (!prompt) {
        void vscode.window.showWarningMessage("Selecione um trecho de código.");
        return;
      }
      await chat.sendPrompt(prompt);
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
      const prompt = selectionAsPrompt(instruction);
      if (prompt) {
        await chat.sendPrompt(prompt + "\n\nUse apply_edit ou write_file para aplicar.");
      }
    })
  );
}

export function deactivate(): void {}
