import * as vscode from "vscode";

let channel: vscode.OutputChannel | undefined;

export function getLog(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel("Forge Agent");
  }
  return channel;
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

function write(level: string, message: string, details: unknown[]): void {
  const ts = new Date().toISOString();
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
              return typeof d === "string" ? d : JSON.stringify(d);
            } catch {
              return String(d);
            }
          })
          .join(" ");
  getLog().appendLine(`[${ts}] ${level} ${message}${extra}`);
}
