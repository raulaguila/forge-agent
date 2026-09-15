import * as path from "path";

/** Pure path helpers (unit-tested). VS Code FS/realpath lives in workspacePath.ts */

export type PathApi = Pick<typeof path, "resolve" | "isAbsolute" | "sep" | "normalize">;

function isWindowsPathApi(pathApi: PathApi): boolean {
  return pathApi.sep === "\\";
}

export function isPathInsideRoot(
  root: string,
  candidate: string,
  pathApi: PathApi = path
): boolean {
  const rootNorm = pathApi.resolve(root);
  const candNorm = pathApi.resolve(candidate);
  if (isWindowsPathApi(pathApi)) {
    const r = rootNorm.toLowerCase();
    const c = candNorm.toLowerCase();
    return c === r || c.startsWith(r + pathApi.sep);
  }
  return candNorm === rootNorm || candNorm.startsWith(rootNorm + pathApi.sep);
}

export function normalizeJoin(
  root: string,
  relOrAbs: string,
  pathApi: PathApi = path
): string {
  const rootNorm = pathApi.resolve(root);
  const abs = pathApi.isAbsolute(relOrAbs)
    ? pathApi.resolve(relOrAbs)
    : pathApi.resolve(rootNorm, relOrAbs);
  if (!isPathInsideRoot(rootNorm, abs, pathApi)) {
    throw new Error(`Path fora do workspace: ${relOrAbs}`);
  }
  return abs;
}

/**
 * Minimal env for terminal tools: keep a small allowlist and drop secret-like keys.
 * PATH is always preserved when present.
 */
export function scrubEnv(
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const allow = new Set([
    "PATH",
    "Path",
    "HOME",
    "USER",
    "USERPROFILE",
    "USERNAME",
    "LANG",
    "LC_ALL",
    "TERM",
    "TMP",
    "TEMP",
    "TMPDIR",
    "ComSpec",
    "SystemRoot",
    "windir",
    "NODE_ENV",
    "PATHEXT",
  ]);
  const secretRe = /secret|token|key|password|credential/i;
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined) {
      continue;
    }
    if (k === "PATH" || k === "Path") {
      out[k] = v;
      continue;
    }
    if (secretRe.test(k)) {
      continue;
    }
    if (allow.has(k)) {
      out[k] = v;
    }
  }
  if (!out.PATH && !out.Path && source.PATH) {
    out.PATH = source.PATH;
  }
  if (!out.PATH && !out.Path && source.Path) {
    out.Path = source.Path;
  }
  return out;
}
