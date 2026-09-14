import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import type { DiffProposal } from "../types";

const pendingTemps = new Map<string, string>();

function workspaceRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    throw new Error("Nenhuma pasta aberta no workspace.");
  }
  return folder.uri.fsPath;
}

export function resolveWorkspacePath(relOrAbs: string): vscode.Uri {
  const root = workspaceRoot();
  const abs = path.isAbsolute(relOrAbs) ? relOrAbs : path.join(root, relOrAbs);
  const normalized = path.normalize(abs);
  const rootNorm = path.normalize(root);
  if (normalized !== rootNorm && !normalized.startsWith(rootNorm + path.sep)) {
    throw new Error(`Path fora do workspace: ${relOrAbs}`);
  }
  return vscode.Uri.file(normalized);
}

async function readWorkspaceText(relOrAbs: string): Promise<{
  exists: boolean;
  content: string;
}> {
  const uri = resolveWorkspacePath(relOrAbs);
  try {
    const data = await vscode.workspace.fs.readFile(uri);
    return { exists: true, content: Buffer.from(data).toString("utf8") };
  } catch {
    return { exists: false, content: "" };
  }
}

export async function buildWriteProposal(
  filePath: string,
  newContent: string
): Promise<DiffProposal> {
  const { exists, content } = await readWorkspaceText(filePath);
  return {
    path: filePath,
    isNew: !exists,
    oldContent: content,
    newContent,
  };
}

export async function buildEditProposal(args: {
  path: string;
  old_text: string;
  new_text: string;
  replace_all?: boolean;
}): Promise<DiffProposal | { error: string }> {
  const filePath = args.path;
  const { exists, content } = await readWorkspaceText(filePath);
  if (!exists) {
    return { error: `Arquivo não encontrado: ${filePath}` };
  }
  if (!content.includes(args.old_text)) {
    return { error: "old_text não encontrado no arquivo (precisa bater exatamente)." };
  }
  const occurrences = content.split(args.old_text).length - 1;
  if (occurrences > 1 && !args.replace_all) {
    return {
      error: `old_text aparece ${occurrences} vezes. Use replace_all=true ou um trecho único.`,
    };
  }
  const next = args.replace_all
    ? content.split(args.old_text).join(args.new_text)
    : content.replace(args.old_text, args.new_text);
  return {
    path: filePath,
    isNew: false,
    oldContent: content,
    newContent: next,
  };
}

export async function showDiffProposal(proposal: DiffProposal): Promise<void> {
  const target = resolveWorkspacePath(proposal.path);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "forge-agent-"));
  const tmpFile = path.join(tmpDir, path.basename(proposal.path) || "proposal.txt");
  await fs.writeFile(tmpFile, proposal.newContent, "utf8");
  pendingTemps.set(proposal.path, tmpFile);

  const left = proposal.isNew
    ? vscode.Uri.parse(`untitled:forge-new/${proposal.path}`)
    : target;
  const right = vscode.Uri.file(tmpFile);
  const title = `${proposal.path} (Forge ${proposal.isNew ? "criar" : "editar"})`;
  await vscode.commands.executeCommand("vscode.diff", left, right, title);
}

export async function applyDiffProposal(proposal: DiffProposal): Promise<string> {
  const uri = resolveWorkspacePath(proposal.path);
  const dir = vscode.Uri.file(path.dirname(uri.fsPath));
  await vscode.workspace.fs.createDirectory(dir);
  await vscode.workspace.fs.writeFile(uri, Buffer.from(proposal.newContent, "utf8"));
  await cleanupTemp(proposal.path);
  return proposal.isNew
    ? `Created ${proposal.path} (${proposal.newContent.length} chars)`
    : `Applied edit to ${proposal.path} (${proposal.newContent.length} chars)`;
}

export async function cleanupTemp(filePath: string): Promise<void> {
  const tmp = pendingTemps.get(filePath);
  if (!tmp) {
    return;
  }
  pendingTemps.delete(filePath);
  try {
    await fs.unlink(tmp);
    await fs.rmdir(path.dirname(tmp));
  } catch {
    // ignore
  }
}
