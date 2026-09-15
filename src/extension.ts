import * as vscode from "vscode";
import { KeyStore } from "./secrets/keys";
import { ChatViewProvider } from "./webview/ChatViewProvider";
import { SettingsPanel } from "./webview/SettingsPanel";
import { bindProfileStore, readConfig } from "./config";
import { selectionAsPrompt } from "./agent/context";
import { SessionStore } from "./agent/sessions";
import { openProjectRules } from "./agent/rules";
import { ProfileStore } from "./agent/profiles";
import { getLog, logError, logInfo, showLog } from "./log";

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(getLog());
  logInfo("Activating Forge Agent", {
    version: context.extension.packageJSON?.version,
    extensionPath: context.extensionUri.fsPath,
  });

  try {
    activateSafe(context);
    logInfo("Forge Agent activated");
  } catch (e) {
    logError("Activation failed", e);
    showLog();
    void vscode.window.showErrorMessage(
      `Forge Agent falhou ao ativar: ${e instanceof Error ? e.message : String(e)}. Veja Output → Forge Agent.`
    );
    throw e;
  }
}

function activateSafe(context: vscode.ExtensionContext): void {
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

  const openSettings = () => {
    // Prefer Continue-style sheet over the chat webview.
    if (chat.hasView()) {
      chat.showSettings();
      return;
    }
    SettingsPanel.createOrShow(context.extensionUri, keyStore, profileStore, () =>
      chat.refreshUi()
    );
  };

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
    vscode.commands.registerCommand("forgeAgent.openSettings", () => openSettings()),
    vscode.commands.registerCommand("forgeAgent.switchProfile", () => openSettings()),
    vscode.commands.registerCommand("forgeAgent.pickModel", () => chat.pickModel()),
    vscode.commands.registerCommand("forgeAgent.manageProfiles", () => openSettings()),
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
    vscode.commands.registerCommand("forgeAgent.setApiKey", () => openSettings()),
    vscode.commands.registerCommand("forgeAgent.clearApiKey", async () => {
      const config = readConfig();
      if (config.profileId) {
        await keyStore.clearForProfile(config.profileId);
      }
      await keyStore.clear(config.provider);
      await chat.refreshUi();
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
      await chat.enterEditMode();
    }),
    vscode.commands.registerCommand("forgeAgent.showLogs", () => {
      showLog();
      logInfo("Log opened by user");
    })
  );
  logInfo("Webview provider registered", ChatViewProvider.viewType);
}

export function deactivate(): void {}
