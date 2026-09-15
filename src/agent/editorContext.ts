import * as vscode from "vscode";

/** Last code editor the user focused — webview focus clears activeTextEditor. */
let lastActiveUri: string | undefined;
let lastActiveViewColumn: vscode.ViewColumn | undefined;
let lastSelection: {
  uri: string;
  anchor: vscode.Position;
  active: vscode.Position;
} | undefined;

function isCodeEditor(editor: vscode.TextEditor | undefined): editor is vscode.TextEditor {
  if (!editor) return false;
  const scheme = editor.document.uri.scheme;
  return scheme === "file" || scheme === "vscode-notebook-cell" || scheme === "untitled";
}

function rememberEditor(editor: vscode.TextEditor | undefined): void {
  if (!isCodeEditor(editor)) return;
  lastActiveUri = editor.document.uri.toString();
  lastActiveViewColumn = editor.viewColumn;
  lastSelection = {
    uri: lastActiveUri,
    anchor: editor.selection.anchor,
    active: editor.selection.active,
  };
}

/** Call once on activate; keeps a durable pointer to the user's code editor. */
export function bindEditorContextTracking(context: vscode.ExtensionContext): void {
  rememberEditor(vscode.window.activeTextEditor);
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((ed) => rememberEditor(ed)),
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (!isCodeEditor(e.textEditor)) return;
      lastActiveUri = e.textEditor.document.uri.toString();
      lastSelection = {
        uri: lastActiveUri,
        anchor: e.selections[0]?.anchor ?? e.textEditor.selection.anchor,
        active: e.selections[0]?.active ?? e.textEditor.selection.active,
      };
    })
  );
}

export function getPreferredTextEditor(): vscode.TextEditor | undefined {
  if (isCodeEditor(vscode.window.activeTextEditor)) {
    return vscode.window.activeTextEditor;
  }
  if (lastActiveUri) {
    const match = vscode.window.visibleTextEditors.find(
      (e) => isCodeEditor(e) && e.document.uri.toString() === lastActiveUri
    );
    if (match) return match;
  }
  const visible = vscode.window.visibleTextEditors.find((e) => isCodeEditor(e));
  if (visible) return visible;
  return undefined;
}

export function getPreferredDocument(): vscode.TextDocument | undefined {
  const ed = getPreferredTextEditor();
  if (ed) return ed.document;
  if (!lastActiveUri) return undefined;
  return vscode.workspace.textDocuments.find((d) => d.uri.toString() === lastActiveUri);
}

export function getPreferredSelection(): {
  document: vscode.TextDocument;
  selection: vscode.Selection;
  editor?: vscode.TextEditor;
} | undefined {
  const ed = getPreferredTextEditor();
  if (ed) {
    return { document: ed.document, selection: ed.selection, editor: ed };
  }
  const doc = getPreferredDocument();
  if (!doc) return undefined;
  if (lastSelection && lastSelection.uri === doc.uri.toString()) {
    return {
      document: doc,
      selection: new vscode.Selection(lastSelection.anchor, lastSelection.active),
    };
  }
  return {
    document: doc,
    selection: new vscode.Selection(0, 0, 0, 0),
  };
}

export interface OpenEditorInfo {
  path: string;
  language: string;
  scheme: string;
  active: boolean;
  viewColumn?: number;
}

/** Open code tabs via tabGroups + visible editors (works with sidebar focus). */
export function listOpenEditorInfos(): OpenEditorInfo[] {
  const preferred = getPreferredDocument();
  const preferredKey = preferred?.uri.toString();
  const seen = new Set<string>();
  const out: OpenEditorInfo[] = [];

  const pushDoc = (
    uri: vscode.Uri,
    language: string,
    viewColumn?: vscode.ViewColumn
  ): void => {
    const key = uri.toString();
    if (seen.has(key)) return;
    if (uri.scheme !== "file" && uri.scheme !== "untitled") return;
    seen.add(key);
    out.push({
      path: vscode.workspace.asRelativePath(uri),
      language,
      scheme: uri.scheme,
      active: key === preferredKey,
      viewColumn,
    });
  };

  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input as { uri?: vscode.Uri } | undefined;
      if (!input?.uri) continue;
      const doc = vscode.workspace.textDocuments.find(
        (d) => d.uri.toString() === input.uri!.toString()
      );
      pushDoc(
        input.uri,
        doc?.languageId || "plaintext",
        group.viewColumn
      );
    }
  }

  for (const ed of vscode.window.visibleTextEditors) {
    if (!isCodeEditor(ed)) continue;
    pushDoc(ed.document.uri, ed.document.languageId, ed.viewColumn);
  }

  if (preferred && !seen.has(preferred.uri.toString())) {
    pushDoc(preferred.uri, preferred.languageId, lastActiveViewColumn);
  }

  // Active file first
  out.sort((a, b) => Number(b.active) - Number(a.active));
  return out;
}

export function activeFileRelativePath(): string | undefined {
  const doc = getPreferredDocument();
  if (!doc) return undefined;
  return vscode.workspace.asRelativePath(doc.uri);
}
