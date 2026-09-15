import * as vscode from "vscode";
import * as path from "path";
import { spawn } from "child_process";
import type { ToolDefinition, ToolResult, ToolRisk } from "../types";
import {
  getPreferredSelection,
  listOpenEditorInfos,
} from "./editorContext";

export interface ToolContext {
  cwd: string;
  signal?: AbortSignal;
}

export interface RegisteredTool {
  def: ToolDefinition;
  risk: ToolRisk;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

function workspaceRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    throw new Error("Nenhuma pasta aberta no workspace.");
  }
  return folder.uri.fsPath;
}

function resolveInWorkspace(relOrAbs: string): vscode.Uri {
  const root = workspaceRoot();
  const abs = path.isAbsolute(relOrAbs) ? relOrAbs : path.join(root, relOrAbs);
  const normalized = path.normalize(abs);
  const rootNorm = path.normalize(root);
  if (normalized !== rootNorm && !normalized.startsWith(rootNorm + path.sep)) {
    throw new Error(`Path fora do workspace: ${relOrAbs}`);
  }
  return vscode.Uri.file(normalized);
}

async function readFile(args: Record<string, unknown>): Promise<ToolResult> {
  const filePath = String(args.path ?? "");
  if (!filePath) {
    return { ok: false, output: "path é obrigatório" };
  }
  try {
    const uri = resolveInWorkspace(filePath);
    const data = await vscode.workspace.fs.readFile(uri);
    const text = Buffer.from(data).toString("utf8");
    const max = 120_000;
    if (text.length > max) {
      return {
        ok: true,
        output: text.slice(0, max) + `\n\n…[truncated ${text.length - max} chars]`,
      };
    }
    return { ok: true, output: text };
  } catch (e) {
    return { ok: false, output: e instanceof Error ? e.message : String(e) };
  }
}

async function writeFile(args: Record<string, unknown>): Promise<ToolResult> {
  const filePath = String(args.path ?? "");
  const content = String(args.content ?? "");
  if (!filePath) {
    return { ok: false, output: "path é obrigatório" };
  }
  try {
    const uri = resolveInWorkspace(filePath);
    const dir = vscode.Uri.file(path.dirname(uri.fsPath));
    await vscode.workspace.fs.createDirectory(dir);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
    return { ok: true, output: `Wrote ${filePath} (${content.length} chars)` };
  } catch (e) {
    return { ok: false, output: e instanceof Error ? e.message : String(e) };
  }
}

async function applyEdit(args: Record<string, unknown>): Promise<ToolResult> {
  const filePath = String(args.path ?? "");
  const oldText = String(args.old_text ?? "");
  const newText = String(args.new_text ?? "");
  if (!filePath || !oldText) {
    return { ok: false, output: "path e old_text são obrigatórios" };
  }
  try {
    const uri = resolveInWorkspace(filePath);
    const data = await vscode.workspace.fs.readFile(uri);
    const text = Buffer.from(data).toString("utf8");
    if (!text.includes(oldText)) {
      return { ok: false, output: "old_text não encontrado no arquivo (precisa bater exatamente)." };
    }
    const occurrences = text.split(oldText).length - 1;
    if (occurrences > 1 && !args.replace_all) {
      return {
        ok: false,
        output: `old_text aparece ${occurrences} vezes. Use replace_all=true ou um trecho único.`,
      };
    }
    const next = args.replace_all
      ? text.split(oldText).join(newText)
      : text.replace(oldText, newText);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(next, "utf8"));
    return { ok: true, output: `Edited ${filePath}` };
  } catch (e) {
    return { ok: false, output: e instanceof Error ? e.message : String(e) };
  }
}

async function listDir(args: Record<string, unknown>): Promise<ToolResult> {
  const dirPath = String(args.path ?? ".");
  try {
    const uri = resolveInWorkspace(dirPath);
    const entries = await vscode.workspace.fs.readDirectory(uri);
    const lines = entries
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, type]) => {
        const kind =
          type & vscode.FileType.Directory
            ? "dir"
            : type & vscode.FileType.SymbolicLink
              ? "link"
              : "file";
        return `${kind.padEnd(4)} ${name}`;
      });
    return { ok: true, output: lines.join("\n") || "(empty)" };
  } catch (e) {
    return { ok: false, output: e instanceof Error ? e.message : String(e) };
  }
}

async function searchFiles(args: Record<string, unknown>): Promise<ToolResult> {
  const pattern = String(args.pattern ?? "");
  const glob = String(args.glob ?? "**/*");
  const maxResults = Math.min(Number(args.max_results ?? 40), 100);
  if (!pattern) {
    return { ok: false, output: "pattern é obrigatório" };
  }
  try {
    const files = await vscode.workspace.findFiles(glob, "**/node_modules/**", 200);
    const regex = new RegExp(pattern, args.case_insensitive ? "i" : "");
    const hits: string[] = [];
    for (const file of files) {
      if (hits.length >= maxResults) {
        break;
      }
      try {
        const data = await vscode.workspace.fs.readFile(file);
        const text = Buffer.from(data).toString("utf8");
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            const rel = vscode.workspace.asRelativePath(file);
            hits.push(`${rel}:${i + 1}: ${lines[i].slice(0, 240)}`);
            if (hits.length >= maxResults) {
              break;
            }
          }
        }
      } catch {
        // skip unreadable
      }
    }
    return {
      ok: true,
      output: hits.length ? hits.join("\n") : "Nenhum match.",
    };
  } catch (e) {
    return { ok: false, output: e instanceof Error ? e.message : String(e) };
  }
}

function runTerminal(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const command = String(args.command ?? "");
  if (!command) {
    return Promise.resolve({ ok: false, output: "command é obrigatório" });
  }
  const cwd = args.cwd ? resolveInWorkspace(String(args.cwd)).fsPath : ctx.cwd;
  const timeoutMs = Math.min(Number(args.timeout_ms ?? 60_000), 300_000);

  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    const onAbort = () => {
      killed = true;
      child.kill("SIGTERM");
    };
    ctx.signal?.addEventListener("abort", onAbort);

    child.stdout.on("data", (d) => {
      stdout += d.toString();
      if (stdout.length > 80_000) {
        stdout = stdout.slice(0, 80_000) + "\n…[truncated]";
      }
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > 40_000) {
        stderr = stderr.slice(0, 40_000) + "\n…[truncated]";
      }
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      ctx.signal?.removeEventListener("abort", onAbort);
      const output = [
        `exit=${code}${killed ? " (killed)" : ""}`,
        stdout && `--- stdout ---\n${stdout}`,
        stderr && `--- stderr ---\n${stderr}`,
      ]
        .filter(Boolean)
        .join("\n");
      resolve({ ok: code === 0 && !killed, output });
    });

    child.on("error", (e) => {
      clearTimeout(timer);
      ctx.signal?.removeEventListener("abort", onAbort);
      resolve({ ok: false, output: e.message });
    });
  });
}

async function getDiagnostics(args: Record<string, unknown>): Promise<ToolResult> {
  const filePath = args.path ? String(args.path) : undefined;
  const all = vscode.languages.getDiagnostics();
  const lines: string[] = [];
  for (const [uri, diags] of all) {
    if (filePath) {
      const target = resolveInWorkspace(filePath);
      if (uri.fsPath !== target.fsPath) {
        continue;
      }
    }
    const rel = vscode.workspace.asRelativePath(uri);
    for (const d of diags) {
      const sev =
        d.severity === vscode.DiagnosticSeverity.Error
          ? "error"
          : d.severity === vscode.DiagnosticSeverity.Warning
            ? "warning"
            : "info";
      lines.push(
        `${rel}:${d.range.start.line + 1}:${d.range.start.character + 1} [${sev}] ${d.message}`
      );
    }
  }
  return {
    ok: true,
    output: lines.length ? lines.slice(0, 80).join("\n") : "Sem diagnósticos.",
  };
}

async function getOpenEditors(): Promise<ToolResult> {
  const editors = listOpenEditorInfos();
  if (!editors.length) {
    return {
      ok: true,
      output:
        "Nenhum editor de código aberto (o foco no chat não conta). Abra um arquivo no editor.",
    };
  }
  const lines = editors.map((e) => {
    const mark = e.active ? " [ativo]" : "";
    return `${e.path}${mark} lang=${e.language}`;
  });
  return { ok: true, output: lines.join("\n") };
}

async function getSelection(): Promise<ToolResult> {
  const ctx = getPreferredSelection();
  if (!ctx) {
    return {
      ok: false,
      output:
        "Nenhum editor ativo. Foque um arquivo no editor (o chat webview remove o activeTextEditor).",
    };
  }
  const text = ctx.document.getText(ctx.selection);
  const rel = vscode.workspace.asRelativePath(ctx.document.uri);
  return {
    ok: true,
    output: JSON.stringify(
      {
        path: rel,
        language: ctx.document.languageId,
        selection: text,
        empty: ctx.selection.isEmpty,
        range: {
          start: {
            line: ctx.selection.start.line + 1,
            character: ctx.selection.start.character + 1,
          },
          end: {
            line: ctx.selection.end.line + 1,
            character: ctx.selection.end.character + 1,
          },
        },
      },
      null,
      2
    ),
  };
}

export function createToolRegistry(): Map<string, RegisteredTool> {
  const tools: RegisteredTool[] = [
    {
      risk: "read",
      def: {
        name: "read_file",
        description: "Lê um arquivo do workspace (path relativo à raiz).",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Caminho relativo do arquivo" },
          },
          required: ["path"],
        },
      },
      run: (args) => readFile(args),
    },
    {
      risk: "write",
      def: {
        name: "write_file",
        description: "Cria ou sobrescreve um arquivo no workspace.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
          },
          required: ["path", "content"],
        },
      },
      run: (args) => writeFile(args),
    },
    {
      risk: "write",
      def: {
        name: "apply_edit",
        description:
          "Substitui um trecho exato (old_text) por new_text em um arquivo. Prefira isto a write_file para edições pontuais.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            old_text: { type: "string" },
            new_text: { type: "string" },
            replace_all: { type: "boolean" },
          },
          required: ["path", "old_text", "new_text"],
        },
      },
      run: (args) => applyEdit(args),
    },
    {
      risk: "read",
      def: {
        name: "list_dir",
        description: "Lista arquivos e pastas em um diretório do workspace.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Diretório relativo (default .)" },
          },
        },
      },
      run: (args) => listDir(args),
    },
    {
      risk: "read",
      def: {
        name: "search",
        description: "Busca regex no conteúdo dos arquivos do workspace.",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string" },
            glob: { type: "string", description: "Glob VS Code, ex. **/*.ts" },
            case_insensitive: { type: "boolean" },
            max_results: { type: "number" },
          },
          required: ["pattern"],
        },
      },
      run: (args) => searchFiles(args),
    },
    {
      risk: "terminal",
      def: {
        name: "run_terminal",
        description:
          "Executa um comando no shell do workspace. Use para build, testes, git status, etc.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string" },
            cwd: { type: "string", description: "Subpasta relativa opcional" },
            timeout_ms: { type: "number" },
          },
          required: ["command"],
        },
      },
      run: (args, ctx) => runTerminal(args, ctx),
    },
    {
      risk: "read",
      def: {
        name: "get_diagnostics",
        description: "Retorna erros/warnings do language service do VS Code.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Opcional: filtrar por arquivo" },
          },
        },
      },
      run: (args) => getDiagnostics(args),
    },
    {
      risk: "read",
      def: {
        name: "get_open_editors",
        description:
          "Lista arquivos abertos nas abas e marca o arquivo ativo (funciona com foco no chat).",
        parameters: { type: "object", properties: {} },
      },
      run: () => getOpenEditors(),
    },
    {
      risk: "read",
      def: {
        name: "get_selection",
        description:
          "Retorna a seleção/cursor do arquivo ativo do usuário (último editor de código, não o webview).",
        parameters: { type: "object", properties: {} },
      },
      run: () => getSelection(),
    },
  ];

  return new Map(tools.map((t) => [t.def.name, t]));
}

export function toolDefinitions(
  registry: Map<string, RegisteredTool>,
  opts?: { risks?: ToolRisk[] }
): ToolDefinition[] {
  let tools = [...registry.values()];
  if (opts?.risks?.length) {
    const allowed = new Set(opts.risks);
    tools = tools.filter((t) => allowed.has(t.risk));
  }
  return tools.map((t) => t.def);
}
