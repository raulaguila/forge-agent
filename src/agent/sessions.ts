import * as vscode from "vscode";
import type { ChatMessage } from "../types";

export interface SavedSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

const KEY = "forgeAgent.sessions";

export class SessionStore {
  constructor(private readonly state: vscode.Memento) {}

  list(): SavedSession[] {
    const all = this.state.get<SavedSession[]>(KEY, []);
    return [...all].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): SavedSession | undefined {
    return this.list().find((s) => s.id === id);
  }

  async save(session: SavedSession): Promise<void> {
    const all = this.list().filter((s) => s.id !== session.id);
    all.unshift(session);
    await this.state.update(KEY, all.slice(0, 40));
  }

  async remove(id: string): Promise<void> {
    await this.state.update(
      KEY,
      this.list().filter((s) => s.id !== id)
    );
  }

  createEmpty(title = "Nova conversa"): SavedSession {
    const now = Date.now();
    return {
      id: `sess_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      title,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
  }
}

export function titleFromMessages(messages: ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser?.content) {
    return "Nova conversa";
  }
  const line = firstUser.content.split("\n")[0].replace(/^#+\s*/, "").trim();
  return line.slice(0, 60) || "Nova conversa";
}
