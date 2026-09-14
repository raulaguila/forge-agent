/** Compact labels for chat UI (Claude/Codex-style). Full payloads stay in LLM messages only. */

const PREVIEW_MAX = 500;

export function sanitizeArgsForUi(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== "object") {
    return {};
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (typeof v === "string" && (k === "content" || k === "old_text" || k === "new_text")) {
      out[k] = v.length > 80 ? `${v.slice(0, 80)}… (${v.length} chars)` : v;
      continue;
    }
    if (typeof v === "string" && v.length > 200) {
      out[k] = `${v.slice(0, 200)}…`;
      continue;
    }
    out[k] = v;
  }
  return out;
}

export function summarizeToolRequest(
  toolName: string,
  args: Record<string, unknown> | unknown
): string {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const path = String(a.path ?? a.cwd ?? "");
  const command = String(a.command ?? "");
  const pattern = String(a.pattern ?? "");

  switch (toolName) {
    case "read_file":
      return path ? `Read ${path}` : "Read file";
    case "write_file":
      return path ? `Write ${path}` : "Write file";
    case "apply_edit":
      return path ? `Edit ${path}` : "Edit file";
    case "list_dir":
      return `List ${path || "."}`;
    case "search":
      return pattern ? `Search ${pattern}` : "Search";
    case "run_terminal":
      return command ? `Ran ${short(command, 56)}` : "Terminal";
    case "get_diagnostics":
      return path ? `Diagnostics ${path}` : "Diagnostics";
    case "get_open_editors":
      return "Open editors";
    case "get_selection":
      return "Selection";
    default:
      return toolName;
  }
}

export function summarizeToolResult(toolName: string, output: string): string {
  const failed =
    /^ERROR:/i.test(output) ||
    /^Usuário recusou/i.test(output) ||
    /^Bloqueado no modo/i.test(output) ||
    /^Tool desconhecida:/i.test(output);
  const lines = output ? output.split(/\r?\n/).length : 0;
  const chars = output.length;

  if (failed) {
    const first = output.replace(/^ERROR:\s*/i, "").split(/\r?\n/)[0] || "falhou";
    return `Failed · ${short(first, 72)}`;
  }

  switch (toolName) {
    case "read_file":
      return `${lines} lines · ${formatCount(chars)}`;
    case "list_dir": {
      const entries = output
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean).length;
      return `${entries} entries`;
    }
    case "search": {
      const hits = output
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("…")).length;
      return `${hits} hits`;
    }
    case "run_terminal": {
      const exit = output.match(/exit[_\s-]?code[:\s]+(-?\d+)/i);
      if (exit) {
        return `exit ${exit[1]} · ${lines} lines`;
      }
      return `${lines} lines output`;
    }
    case "write_file":
    case "apply_edit":
      return short(output.split(/\r?\n/)[0] || "done", 80);
    default:
      return `${lines} lines · ${formatCount(chars)}`;
  }
}

export function previewToolOutput(output: string, max = PREVIEW_MAX): string {
  if (!output) {
    return "";
  }
  if (output.length <= max) {
    return output;
  }
  return `${output.slice(0, max)}\n…`;
}

function short(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function formatCount(n: number): string {
  if (n < 1000) {
    return `${n} chars`;
  }
  if (n < 10_000) {
    return `${(n / 1000).toFixed(1)}k chars`;
  }
  return `${Math.round(n / 1000)}k chars`;
}
