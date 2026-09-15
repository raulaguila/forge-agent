import * as vscode from "vscode";
import { KeyStore } from "./secrets/keys";
import { ChatViewProvider } from "./webview/ChatViewProvider";
import { SettingsPanel } from "./webview/SettingsPanel";
import { bindProfileStore, readConfig } from "./config";
import { selectionAsPrompt } from "./agent/context";
import { SessionStore } from "./agent/sessions";
import { openProjectRules } from "./agent/rules";
import { ProfileStore } from "./agent/profiles";
import { bindEditorContextTracking, getPreferredSelection } from "./agent/editorContext";
import { getLog, logError, logInfo, logWarn, showLog } from "./log";

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
  bindEditorContextTracking(context);
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
    vscode.commands.registerCommand("forgeAgent.openChatPanel", () => chat.openChatPanel()),
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
      const ctx = getPreferredSelection();
      if (!ctx || ctx.selection.isEmpty) {
        void vscode.window.showWarningMessage("Selecione um trecho de código.");
        return;
      }
      const rel = vscode.workspace.asRelativePath(ctx.document.uri);
      const text = ctx.document.getText(ctx.selection);
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
    }),
    vscode.commands.registerCommand("forgeAgent.repairSidebar", () =>
      chat.repairSidebar()
    )
  );
  logInfo("Webview provider registered", ChatViewProvider.viewType);

  void (async () => {
    const cmds = await vscode.commands.getCommands(true);
    const related = cmds.filter(
      (c) =>
        c.includes("forgeAgent") ||
        c.includes("forge-agent") ||
        c.includes(ChatViewProvider.viewType)
    );
    logInfo("Forge-related commands", related);
    const focusCmd = `${ChatViewProvider.viewType}.focus`;
    logInfo("Sidebar focus command present", {
      focusCmd,
      present: cmds.includes(focusCmd),
      containerCmdPresent: cmds.includes("workbench.view.extension.forge-agent"),
    });

    // Auto-heal empty Forge container (Chat view removed/hidden).
    await new Promise((r) => setTimeout(r, 1500));
    if (!chat.hasSidebarView()) {
      logWarn(
        "Sidebar chat still unresolved 1.5s after activate — trying resetViewLocation + open"
      );
      try {
        await vscode.commands.executeCommand(
          `${ChatViewProvider.viewType}.resetViewLocation`
        );
        await vscode.commands.executeCommand(`${ChatViewProvider.viewType}.open`);
        await vscode.commands.executeCommand(
          "workbench.view.extension.forge-agent"
        );
        await vscode.commands.executeCommand(focusCmd);
      } catch (e) {
        logWarn("Auto-heal sidebar failed", e);
      }
    }
  })();
}

export function deactivate(): void {}
