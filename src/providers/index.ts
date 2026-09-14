import type { ChatMessage, CompletionRequest, LlmProvider, ToolCall, ToolDefinition } from "../types";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(
  url: string,
  init: RequestInit,
  retries = 2
): Promise<{ status: number; body: any }> {
  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, init);
      const body = await res.json().catch(() => ({}));
      if (res.status === 429 || res.status >= 500) {
        if (i < retries) {
          await sleep(500 * (i + 1));
          continue;
        }
      }
      return { status: res.status, body };
    } catch (e) {
      lastErr = e;
      if (i < retries) {
        await sleep(400 * (i + 1));
        continue;
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function toOpenAiMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === "assistant" && m.toolCalls?.length) {
      return {
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls.map((t) => ({
          id: t.id,
          type: "function",
          function: { name: t.name, arguments: t.arguments },
        })),
      };
    }
    if (m.role === "tool") {
      return {
        role: "tool",
        tool_call_id: m.toolCallId,
        content: m.content,
      };
    }
    return { role: m.role, content: m.content };
  });
}

function toOpenAiTools(tools: ToolDefinition[]): unknown[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly id;
  constructor(
    public readonly apiKey: string,
    public readonly baseUrl: string,
    id: "openai" | "openai-compatible" = "openai"
  ) {
    this.id = id;
  }

  async complete(req: CompletionRequest) {
    const url = `${this.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const { status, body } = await fetchJson(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: req.model,
          messages: toOpenAiMessages(req.messages),
          tools: req.tools.length ? toOpenAiTools(req.tools) : undefined,
          tool_choice: req.tools.length ? "auto" : undefined,
          temperature: req.temperature,
        }),
        signal: req.signal,
      },
      2
    );

    if (status >= 400) {
      const msg =
        body?.error?.message ||
        body?.message ||
        `OpenAI-compatible HTTP ${status}`;
      throw new Error(msg);
    }

    const choice = body?.choices?.[0];
    const msg = choice?.message ?? {};
    const toolCalls: ToolCall[] | undefined = Array.isArray(msg.tool_calls)
      ? msg.tool_calls.map((t: any) => ({
          id: t.id,
          name: t.function?.name ?? "",
          arguments: t.function?.arguments ?? "{}",
        }))
      : undefined;

    const message: ChatMessage = {
      role: "assistant",
      content: typeof msg.content === "string" ? msg.content : "",
      toolCalls: toolCalls?.length ? toolCalls : undefined,
    };

    const finish =
      choice?.finish_reason === "tool_calls" || toolCalls?.length
        ? "tool_calls"
        : choice?.finish_reason === "length"
          ? "length"
          : "stop";

    return { message, finishReason: finish as "stop" | "tool_calls" | "length" };
  }
}

export class AnthropicProvider implements LlmProvider {
  readonly id = "anthropic" as const;
  constructor(
    public readonly apiKey: string,
    public readonly baseUrl = "https://api.anthropic.com"
  ) {}

  private toAnthropicMessages(messages: ChatMessage[]): { system: string; messages: unknown[] } {
    let system = "";
    const out: unknown[] = [];

    for (const m of messages) {
      if (m.role === "system") {
        system += (system ? "\n\n" : "") + m.content;
        continue;
      }
      if (m.role === "user") {
        out.push({ role: "user", content: m.content });
        continue;
      }
      if (m.role === "assistant") {
        const content: unknown[] = [];
        if (m.content) {
          content.push({ type: "text", text: m.content });
        }
        for (const t of m.toolCalls ?? []) {
          let input: unknown = {};
          try {
            input = JSON.parse(t.arguments || "{}");
          } catch {
            input = { raw: t.arguments };
          }
          content.push({
            type: "tool_use",
            id: t.id,
            name: t.name,
            input,
          });
        }
        out.push({ role: "assistant", content: content.length ? content : m.content });
        continue;
      }
      if (m.role === "tool") {
        // Anthropic expects tool_result blocks inside a user message
        const last = out[out.length - 1] as { role: string; content: unknown } | undefined;
        const block = {
          type: "tool_result",
          tool_use_id: m.toolCallId,
          content: m.content,
        };
        if (last && last.role === "user" && Array.isArray(last.content)) {
          (last.content as unknown[]).push(block);
        } else {
          out.push({ role: "user", content: [block] });
        }
      }
    }

    return { system, messages: out };
  }

  async complete(req: CompletionRequest) {
    const { system, messages } = this.toAnthropicMessages(req.messages);
    const tools = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));

    const { status, body } = await fetchJson(
      `${this.baseUrl.replace(/\/$/, "")}/v1/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: req.model,
          max_tokens: 8192,
          system: system || undefined,
          messages,
          tools: tools.length ? tools : undefined,
          temperature: req.temperature,
        }),
        signal: req.signal,
      },
      2
    );

    if (status >= 400) {
      const msg = body?.error?.message || body?.message || `Anthropic HTTP ${status}`;
      throw new Error(msg);
    }

    const content = Array.isArray(body?.content) ? body.content : [];
    let text = "";
    const toolCalls: ToolCall[] = [];
    for (const block of content) {
      if (block.type === "text") {
        text += block.text ?? "";
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        });
      }
    }

    const message: ChatMessage = {
      role: "assistant",
      content: text,
      toolCalls: toolCalls.length ? toolCalls : undefined,
    };

    const finish =
      body?.stop_reason === "tool_use" || toolCalls.length
        ? "tool_calls"
        : body?.stop_reason === "max_tokens"
          ? "length"
          : "stop";

    return { message, finishReason: finish as "stop" | "tool_calls" | "length" };
  }
}

export function createProvider(
  provider: "openai" | "anthropic" | "openai-compatible",
  apiKey: string,
  baseUrl: string
): LlmProvider {
  if (provider === "anthropic") {
    return new AnthropicProvider(apiKey, baseUrl || "https://api.anthropic.com");
  }
  if (provider === "openai-compatible") {
    if (!baseUrl) {
      throw new Error("forgeAgent.baseUrl é obrigatório para openai-compatible.");
    }
    return new OpenAiCompatibleProvider(apiKey, baseUrl, "openai-compatible");
  }
  return new OpenAiCompatibleProvider(apiKey, baseUrl || "https://api.openai.com/v1", "openai");
}
