import * as vscode from "vscode";
import * as path from "path";

export interface FileSnapshot {
  path: string;
  existed: boolean;
  content: string;
}

export interface Checkpoint {
  id: string;
  createdAt: number;
  label: string;
  files: FileSnapshot[];
}

function workspaceRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    throw new Error("Nenhuma pasta aberta no workspace.");
  }
  return folder.uri.fsPath;
}

function resolvePath(relOrAbs: string): vscode.Uri {
  const root = workspaceRoot();
  const abs = path.isAbsolute(relOrAbs) ? relOrAbs : path.join(root, relOrAbs);
  const normalized = path.normalize(abs);
  const rootNorm = path.normalize(root);
  if (normalized !== rootNorm && !normalized.startsWith(rootNorm + path.sep)) {
    throw new Error(`Path fora do workspace: ${relOrAbs}`);
  }
  return vscode.Uri.file(normalized);
}

export class CheckpointStore {
  private stack: Checkpoint[] = [];

  list(): Checkpoint[] {
    return [...this.stack].reverse();
  }

  clear(): void {
    this.stack = [];
  }

  async snapshotBeforeWrite(
    filePath: string,
    label: string
  ): Promise<Checkpoint> {
    const uri = resolvePath(filePath);
    let existed = true;
    let content = "";
    try {
      const data = await vscode.workspace.fs.readFile(uri);
      content = Buffer.from(data).toString("utf8");
    } catch {
      existed = false;
    }
    const cp: Checkpoint = {
      id: `cp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      createdAt: Date.now(),
      label,
      files: [{ path: filePath, existed, content }],
    };
    this.stack.push(cp);
    if (this.stack.length > 30) {
      this.stack.shift();
    }
    return cp;
  }

  async restore(id?: string): Promise<string> {
    if (!this.stack.length) {
      return "Nenhum checkpoint para restaurar.";
    }
    const idx = id
      ? this.stack.findIndex((c) => c.id === id)
      : this.stack.length - 1;
    if (idx < 0) {
      return "Checkpoint não encontrado.";
    }
    const [cp] = this.stack.splice(idx, 1);
    for (const file of cp.files) {
      const uri = resolvePath(file.path);
      if (!file.existed) {
        try {
          await vscode.workspace.fs.delete(uri);
        } catch {
          // ignore
        }
      } else {
        const dir = vscode.Uri.file(path.dirname(uri.fsPath));
        await vscode.workspace.fs.createDirectory(dir);
        await vscode.workspace.fs.writeFile(uri, Buffer.from(file.content, "utf8"));
      }
    }
    return `Restaurado checkpoint: ${cp.label} (${cp.files.length} arquivo(s))`;
  }
}
