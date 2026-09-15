import * as vscode from "vscode";
import * as path from "path";
import { resolveWorkspacePath } from "./workspacePath";

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

const STATE_KEY = "forgeAgent.checkpoints";

export class CheckpointStore {
  private stack: Checkpoint[] = [];
  private memento?: vscode.Memento;

  /** Bind to workspaceState for durability across reloads. */
  bindState(state: vscode.Memento): void {
    this.memento = state;
    this.stack = state.get<Checkpoint[]>(STATE_KEY, []);
  }

  private async persist(): Promise<void> {
    if (!this.memento) return;
    await this.memento.update(STATE_KEY, this.stack.slice(-30));
  }

  list(): Checkpoint[] {
    return [...this.stack].reverse();
  }

  clear(): void {
    this.stack = [];
    void this.persist();
  }

  async snapshotBeforeWrite(
    filePath: string,
    label: string
  ): Promise<Checkpoint> {
    const uri = await resolveWorkspacePath(filePath);
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
    await this.persist();
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
    await this.persist();
    for (const file of cp.files) {
      const uri = await resolveWorkspacePath(file.path);
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
