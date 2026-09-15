import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs/promises";
import { isPathInsideRoot, normalizeJoin } from "./pathGuard";

export function getWorkspaceRoots(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) =>
    path.resolve(f.uri.fsPath)
  );
}

export function getPrimaryWorkspaceRoot(): string {
  const roots = getWorkspaceRoots();
  if (!roots.length) {
    throw new Error("Nenhuma pasta aberta no workspace.");
  }
  return roots[0];
}

/**
 * Realpath when the path exists. For new files, realpath the nearest existing
 * ancestor and re-join missing segments.
 */
async function realExisting(abs: string): Promise<string> {
  try {
    return await fs.realpath(abs);
  } catch {
    // fall through — path may not exist yet
  }

  const missing: string[] = [];
  let current = path.resolve(abs);
  while (true) {
    const parent = path.dirname(current);
    if (parent === current) {
      // Filesystem root — join unresolved segments
      return path.join(current, ...missing.reverse());
    }
    missing.push(path.basename(current));
    try {
      const parentReal = await fs.realpath(parent);
      return path.join(parentReal, ...missing.reverse());
    } catch {
      current = parent;
    }
  }
}

async function realpathRoots(roots: string[]): Promise<string[]> {
  return Promise.all(
    roots.map(async (r) => {
      try {
        return await fs.realpath(r);
      } catch {
        return path.resolve(r);
      }
    })
  );
}

function insideAnyRoot(abs: string, roots: string[]): boolean {
  return roots.some((r) => isPathInsideRoot(r, abs));
}

function stripFileScheme(input: string): string {
  if (input.startsWith("file:")) {
    try {
      return vscode.Uri.parse(input).fsPath;
    } catch {
      return input.replace(/^file:\/\//, "");
    }
  }
  return input;
}

function joinAgainstRoots(relOrAbs: string, roots: string[]): string {
  if (path.isAbsolute(relOrAbs)) {
    const joined = path.resolve(relOrAbs);
    if (!insideAnyRoot(joined, roots)) {
      throw new Error(`Path fora do workspace: ${relOrAbs}`);
    }
    return joined;
  }
  let lastErr: unknown;
  for (const root of roots) {
    try {
      return normalizeJoin(root, relOrAbs);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(`Path fora do workspace: ${relOrAbs}`);
}

/**
 * Resolve a user path into a file Uri that stays inside SOME workspace root
 * even when symlinks are involved.
 */
export async function resolveWorkspacePath(relOrAbs: string): Promise<vscode.Uri> {
  const roots = getWorkspaceRoots();
  if (!roots.length) {
    throw new Error("Nenhuma pasta aberta no workspace.");
  }
  const raw = stripFileScheme(String(relOrAbs ?? "").trim());
  if (!raw) {
    throw new Error("Path vazio.");
  }
  const joined = joinAgainstRoots(raw, roots);
  const real = await realExisting(joined);
  const realRoots = await realpathRoots(roots);
  if (!insideAnyRoot(real, realRoots)) {
    throw new Error(`Path fora do workspace (symlink): ${relOrAbs}`);
  }
  return vscode.Uri.file(real);
}

/** Alias used by tools/diff. */
export const resolveWorkspaceUri = resolveWorkspacePath;

export async function assertInsideWorkspace(absPath: string): Promise<void> {
  await resolveWorkspacePath(absPath);
}

export function toRelativePath(uriOrPath: string | vscode.Uri): string {
  const uri =
    typeof uriOrPath === "string"
      ? vscode.Uri.file(stripFileScheme(uriOrPath))
      : uriOrPath;
  return vscode.workspace.asRelativePath(uri, false);
}
