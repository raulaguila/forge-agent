import * as vscode from "vscode";
import * as path from "path";

const MAX_FILE_CHARS = 80_000;
const MAX_DIR_ENTRIES = 200;

export interface MentionSuggestion {
  label: string;
  kind: "file" | "folder" | "selection" | "active";
  insert: string;
}

/** Extrai tokens @path do texto do usuário (sem espaços). */
export function extractMentions(text: string): string[] {
  const re = /(?:^|[\s])@([^\s@]+)/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const token = m[1];
    if (token && !out.includes(token)) {
      out.push(token);
    }
  }
  return out;
}

export async function suggestMentions(query: string): Promise<MentionSuggestion[]> {
  const q = query.trim().toLowerCase();
  const suggestions: MentionSuggestion[] = [
    { label: "selection", kind: "selection", insert: "@selection" },
    { label: "active", kind: "active", insert: "@active" },
  ];

  const files = await vscode.workspace.findFiles(
    "**/*",
    "**/{node_modules,out,dist,.git}/**",
    300
  );

  for (const uri of files) {
    const rel = vscode.workspace.asRelativePath(uri);
    if (q && !rel.toLowerCase().includes(q)) {
      continue;
    }
    suggestions.push({
      label: rel,
      kind: "file",
      insert: `@${rel}`,
    });
    if (suggestions.length >= 40) {
      break;
    }
  }

  // folders from unique parents
  const folders = new Set<string>();
  for (const uri of files) {
    const rel = vscode.workspace.asRelativePath(uri);
    const dir = path.posix.dirname(rel.replace(/\\/g, "/"));
    if (dir && dir !== ".") {
      folders.add(dir);
    }
  }
  for (const dir of [...folders].sort()) {
    if (q && !dir.toLowerCase().includes(q)) {
      continue;
    }
    suggestions.push({
      label: dir + "/",
      kind: "folder",
      insert: `@${dir}/`,
    });
    if (suggestions.length >= 60) {
      break;
    }
  }

  return suggestions.filter((s) => !q || s.label.toLowerCase().includes(q)).slice(0, 30);
}

async function readFileBlock(rel: string): Promise<string> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.[0]) {
    return `(sem workspace) ${rel}`;
  }
  const uri = vscode.Uri.joinPath(folders[0].uri, rel);
  try {
    const data = await vscode.workspace.fs.readFile(uri);
    let text = Buffer.from(data).toString("utf8");
    if (text.length > MAX_FILE_CHARS) {
      text = text.slice(0, MAX_FILE_CHARS) + `\n…[truncated ${text.length - MAX_FILE_CHARS} chars]`;
    }
    return `### File: ${rel}\n\`\`\`\n${text}\n\`\`\``;
  } catch (e) {
    return `### File: ${rel}\n(ERROR: ${e instanceof Error ? e.message : String(e)})`;
  }
}

async function readFolderBlock(rel: string): Promise<string> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.[0]) {
    return `(sem workspace) ${rel}`;
  }
  const clean = rel.replace(/\/$/, "");
  const uri = vscode.Uri.joinPath(folders[0].uri, clean);
  try {
    const entries = await vscode.workspace.fs.readDirectory(uri);
    const lines = entries
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(0, MAX_DIR_ENTRIES)
      .map(([name, type]) => {
        const kind = type & vscode.FileType.Directory ? "dir" : "file";
        return `${kind.padEnd(4)} ${name}`;
      });
    return `### Folder: ${clean}/\n\`\`\`\n${lines.join("\n") || "(empty)"}\n\`\`\``;
  } catch (e) {
    return `### Folder: ${clean}\n(ERROR: ${e instanceof Error ? e.message : String(e)})`;
  }
}

function selectionBlock(): string {
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.selection.isEmpty) {
    return "### Selection\n(nenhuma seleção ativa)";
  }
  const rel = vscode.workspace.asRelativePath(ed.document.uri);
  const text = ed.document.getText(ed.selection);
  return `### Selection: ${rel} L${ed.selection.start.line + 1}-${ed.selection.end.line + 1}\n\`\`\`\n${text}\n\`\`\``;
}

function activeBlock(): string {
  const ed = vscode.window.activeTextEditor;
  if (!ed) {
    return "### Active file\n(nenhum editor ativo)";
  }
  const rel = vscode.workspace.asRelativePath(ed.document.uri);
  let text = ed.document.getText();
  if (text.length > MAX_FILE_CHARS) {
    text = text.slice(0, MAX_FILE_CHARS) + `\n…[truncated]`;
  }
  return `### Active file: ${rel}\n\`\`\`\n${text}\n\`\`\``;
}

/**
 * Expande @mentions e anexa contexto automático (arquivo ativo + seleção se houver).
 */
export async function expandUserMessage(userText: string): Promise<string> {
  const mentions = extractMentions(userText);
  const blocks: string[] = [];
  const seen = new Set<string>();

  for (const token of mentions) {
    const key = token.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    if (token === "selection") {
      blocks.push(selectionBlock());
      continue;
    }
    if (token === "active") {
      blocks.push(activeBlock());
      continue;
    }
    if (token.endsWith("/")) {
      blocks.push(await readFolderBlock(token));
      continue;
    }
    blocks.push(await readFileBlock(token));
  }

  // Auto-context se o usuário não mencionou nada
  if (blocks.length === 0) {
    const ed = vscode.window.activeTextEditor;
    if (ed && !ed.selection.isEmpty) {
      blocks.push(selectionBlock());
    } else if (ed) {
      const rel = vscode.workspace.asRelativePath(ed.document.uri);
      blocks.push(`### Active file (path only): ${rel}`);
    }
  }

  if (!blocks.length) {
    return userText;
  }

  return `${userText}\n\n---\n## Context\n${blocks.join("\n\n")}`;
}

export function selectionAsPrompt(prefix: string): string | undefined {
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.selection.isEmpty) {
    return undefined;
  }
  const rel = vscode.workspace.asRelativePath(ed.document.uri);
  const text = ed.document.getText(ed.selection);
  return `${prefix}\n\n@${rel}\n\`\`\`\n${text}\n\`\`\``;
}
