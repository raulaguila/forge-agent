import * as vscode from "vscode";
import * as path from "path";
import {
  activeFileRelativePath,
  getPreferredDocument,
  getPreferredSelection,
  getPreferredTextEditor,
  listOpenEditorInfos,
} from "./editorContext";
import { resolveWorkspacePath, toRelativePath } from "./workspacePath";

const MAX_FILE_CHARS = 80_000;
const MAX_DIR_ENTRIES = 200;

/** Phrases that mean “the currently open file”. */
const ACTIVE_FILE_INTENT =
  /\b(arquivo\s+(aberto|atual|ativo)|este\s+arquivo|nessa?\s+aba|open\s+file|current\s+file|active\s+file|this\s+file|analyse?\s+this|analyze\s+this)\b/i;

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
    const rel = toRelativePath(uri);
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

  const folders = new Set<string>();
  for (const uri of files) {
    const rel = toRelativePath(uri);
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
  try {
    const uri = await resolveWorkspacePath(rel);
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
  const clean = rel.replace(/\/$/, "");
  try {
    const uri = await resolveWorkspacePath(clean);
    const entries = await vscode.workspace.fs.readDirectory(uri);
    const lines = entries
      .slice(0, MAX_DIR_ENTRIES)
      .map(([name, type]) => {
        const kind =
          type & vscode.FileType.Directory
            ? "dir"
            : type & vscode.FileType.SymbolicLink
              ? "link"
              : "file";
        return `${kind.padEnd(4)} ${name}`;
      });
    return `### Folder: ${clean}/\n\`\`\`\n${lines.join("\n") || "(empty)"}\n\`\`\``;
  } catch (e) {
    return `### Folder: ${clean}\n(ERROR: ${e instanceof Error ? e.message : String(e)})`;
  }
}

function selectionBlock(): string {
  const ctx = getPreferredSelection();
  if (!ctx || ctx.selection.isEmpty) {
    return "### Selection\n(nenhuma seleção ativa)";
  }
  const rel = toRelativePath(ctx.document.uri);
  const text = ctx.document.getText(ctx.selection);
  return `### Selection: ${rel} L${ctx.selection.start.line + 1}-${ctx.selection.end.line + 1}\n\`\`\`\n${text}\n\`\`\``;
}

function activeBlock(): string {
  const doc = getPreferredDocument();
  if (!doc) {
    return "### Active file\n(nenhum editor ativo — foque um arquivo no editor e tente de novo)";
  }
  const rel = toRelativePath(doc.uri);
  let text = doc.getText();
  if (text.length > MAX_FILE_CHARS) {
    text = text.slice(0, MAX_FILE_CHARS) + `\n…[truncated]`;
  }
  return `### Active file: ${rel}\n\`\`\`${doc.languageId}\n${text}\n\`\`\``;
}

/**
 * Expande @mentions e anexa contexto automático (arquivo ativo + seleção se houver).
 * Usa o último editor de código lembrado — o chat webview limpa activeTextEditor.
 */
export async function expandUserMessage(userText: string): Promise<string> {
  const mentions = extractMentions(userText);
  const blocks: string[] = [];
  const seen = new Set<string>();
  const wantsActiveFile =
    ACTIVE_FILE_INTENT.test(userText) || mentions.some((t) => t.toLowerCase() === "active");

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

  // Natural language: "analise o arquivo aberto" → inject full active file
  if (wantsActiveFile && !seen.has("active")) {
    seen.add("active");
    blocks.push(activeBlock());
  }

  // Auto-context when nothing was attached yet
  if (blocks.length === 0) {
    const sel = getPreferredSelection();
    if (sel && !sel.selection.isEmpty) {
      blocks.push(selectionBlock());
    } else {
      const rel = activeFileRelativePath();
      const open = listOpenEditorInfos();
      if (rel) {
        blocks.push(`### Active file (path): ${rel}`);
        blocks.push(
          "Use a tool `read_file` com esse path se precisar do conteúdo completo."
        );
      } else if (open.length) {
        blocks.push(
          `### Open editors\n${open.map((e) => `- ${e.active ? "(ativo) " : ""}${e.path}`).join("\n")}`
        );
      } else {
        blocks.push(
          "### Active file\n(nenhum editor de código conhecido — o usuário pode estar só no chat)"
        );
      }
    }
  }

  // Always stamp active path for the model when we have one
  const activePath = activeFileRelativePath();
  const openInfos = listOpenEditorInfos();
  const meta: string[] = [];
  if (activePath) {
    meta.push(`Arquivo ativo: ${activePath}`);
  }
  if (openInfos.length) {
    meta.push(
      `Abas: ${openInfos
        .slice(0, 8)
        .map((e) => (e.active ? `*${e.path}*` : e.path))
        .join(", ")}`
    );
  }
  // Touch preferred editor so tracking stays warm (no-op read)
  void getPreferredTextEditor();

  if (!blocks.length && !meta.length) {
    return userText;
  }

  const parts = [userText, "", "---", "## Context"];
  if (meta.length) {
    parts.push(meta.join("\n"));
    parts.push("");
  }
  if (blocks.length) {
    parts.push(blocks.join("\n\n"));
  }
  return parts.join("\n");
}

export function selectionAsPrompt(prefix: string): string | undefined {
  const ctx = getPreferredSelection();
  if (!ctx || ctx.selection.isEmpty) {
    return undefined;
  }
  const rel = toRelativePath(ctx.document.uri);
  const text = ctx.document.getText(ctx.selection);
  return `${prefix}\n\n@${rel}\n\`\`\`\n${text}\n\`\`\``;
}
