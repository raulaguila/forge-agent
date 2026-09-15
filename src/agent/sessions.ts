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
const MAX_SESSIONS = 40;
const MAX_TOOL_CHARS = 8_000;
const MAX_SESSION_CHARS = 1_500_000;

function compactMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    if (m.role !== "tool") return m;
    const content = m.content ?? "";
    if (content.length <= MAX_TOOL_CHARS) return m;
    return {
      ...m,
      content: `${content.slice(0, MAX_TOOL_CHARS)}\n…[truncated ${content.length - MAX_TOOL_CHARS} chars]`,
    };
  });
}

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
    const compacted: SavedSession = {
      ...session,
      messages: compactMessages(session.messages),
    };

    // Further trim oldest tool payloads if the session is huge
    let size = JSON.stringify(compacted.messages).length;
    if (size > MAX_SESSION_CHARS) {
      compacted.messages = compacted.messages.map((m, i) => {
        if (i > compacted.messages.length - 12) return m;
        if (m.role !== "tool" || (m.content?.length ?? 0) < 400) return m;
        return { ...m, content: `${m.content.slice(0, 400)}\n…[truncated]` };
      });
      size = JSON.stringify(compacted.messages).length;
    }

    const all = this.list().filter((s) => s.id !== compacted.id);
    all.unshift(compacted);
    await this.state.update(KEY, all.slice(0, MAX_SESSIONS));
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
