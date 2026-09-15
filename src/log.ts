import * as vscode from "vscode";

let channel: vscode.OutputChannel | undefined;
let runId = "";

export function getLog(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel("Forge Agent");
  }
  return channel;
}

/** Start a correlated log run (e.g. one user send). */
export function beginLogRun(prefix = "run"): string {
  runId = `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  logInfo("run start", { runId });
  return runId;
}

export function endLogRun(): void {
  if (runId) {
    logInfo("run end", { runId });
  }
  runId = "";
}

export function currentRunId(): string {
  return runId;
}

export function logInfo(message: string, ...details: unknown[]): void {
  write("INFO", message, details);
}

export function logWarn(message: string, ...details: unknown[]): void {
  write("WARN", message, details);
}

export function logError(message: string, ...details: unknown[]): void {
  write("ERROR", message, details);
}

export function showLog(preserveFocus = false): void {
  getLog().show(preserveFocus);
}

function redact(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(
      /(api[_-]?key|token|authorization|bearer)\s*[:=]\s*["']?([^\s"']+)/gi,
      "$1=[redacted]"
    );
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/secret|token|key|password|authorization|credential/i.test(k)) {
        out[k] = "[redacted]";
      } else {
        out[k] = redact(v);
      }
    }
    return out;
  }
  return value;
}

function write(level: string, message: string, details: unknown[]): void {
  const ts = new Date().toISOString();
  const rid = runId ? ` run=${runId}` : "";
  const extra =
    details.length === 0
      ? ""
      : " " +
        details
          .map((d) => {
            if (d instanceof Error) {
              return d.stack || d.message;
            }
            try {
              const safe = redact(d);
              return typeof safe === "string" ? safe : JSON.stringify(safe);
            } catch {
              return String(d);
            }
          })
          .join(" ");
  getLog().appendLine(`[${ts}]${rid} ${level} ${message}${extra}`);
}
