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
/** Soft cap for one session's messages JSON (~2MB total store budget). */
const MAX_SESSION_CHARS = 2_000_000;
const MAX_STORE_CHARS = 2_000_000;

function compactMessages(messages: ChatMessage[], toolMax = MAX_TOOL_CHARS): ChatMessage[] {
  return messages.map((m) => {
    if (m.role !== "tool") return m;
    const content = m.content ?? "";
    if (content.length <= toolMax) return m;
    return {
      ...m,
      content: `${content.slice(0, toolMax)}\n…[truncated ${content.length - toolMax} chars]`,
    };
  });
}

function aggressiveTrimTools(messages: ChatMessage[], keepRecent = 12, cap = 400): ChatMessage[] {
  return messages.map((m, i) => {
    if (i > messages.length - keepRecent) return m;
    if (m.role !== "tool" || (m.content?.length ?? 0) <= cap) return m;
    return { ...m, content: `${m.content.slice(0, cap)}\n…[truncated]` };
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
    if (JSON.stringify(compacted.messages).length > MAX_SESSION_CHARS) {
      compacted.messages = aggressiveTrimTools(compacted.messages);
    }

    let all = this.list().filter((s) => s.id !== compacted.id);
    all.unshift(compacted);
    all = all.slice(0, MAX_SESSIONS);

    // Rough ~2MB store budget: shrink older sessions' tool payloads, then drop oldest.
    let storeJson = JSON.stringify(all);
    if (storeJson.length > MAX_STORE_CHARS) {
      all = all.map((s, idx) => {
        if (idx === 0) return s;
        return { ...s, messages: aggressiveTrimTools(s.messages, 8, 200) };
      });
      storeJson = JSON.stringify(all);
    }
    while (storeJson.length > MAX_STORE_CHARS && all.length > 1) {
      all.pop();
      storeJson = JSON.stringify(all);
    }

    await this.state.update(KEY, all);
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
