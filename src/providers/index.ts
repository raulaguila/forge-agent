import type {
  ChatMessage,
  CompletionRequest,
  LlmProvider,
  ProviderId,
  ToolCall,
  ToolDefinition,
} from "../types";
import { httpJson } from "./http";

export interface ProviderCreateOptions {
  provider: ProviderId;
  apiKey: string;
  baseUrl: string;
  tlsInsecure: boolean;
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

function parseOpenAiResponse(body: any): {
  message: ChatMessage;
  finishReason: "stop" | "tool_calls" | "length";
} {
  const choice = body?.choices?.[0];
  const msg = choice?.message ?? {};
  const toolCalls: ToolCall[] | undefined = Array.isArray(msg.tool_calls)
    ? msg.tool_calls.map((t: any) => ({
        id: t.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
        name: t.function?.name ?? "",
        arguments:
          typeof t.function?.arguments === "string"
            ? t.function.arguments
            : JSON.stringify(t.function?.arguments ?? {}),
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

  return { message, finishReason: finish };
}

/** OpenAI official + any OpenAI-compatible /chat/completions endpoint. */
export class OpenAiCompatibleProvider implements LlmProvider {
  readonly id: ProviderId;

  constructor(
    public readonly apiKey: string,
    public readonly baseUrl: string,
    id: ProviderId,
    public readonly tlsInsecure = false,
    private readonly authMode: "bearer" | "none" = "bearer"
  ) {
    this.id = id;
  }

  async complete(req: CompletionRequest) {
    const url = `${this.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.authMode === "bearer" && this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    const { status, body } = await httpJson(url, {
      method: "POST",
      headers,
      body: {
        model: req.model,
        messages: toOpenAiMessages(req.messages),
        tools: req.tools.length ? toOpenAiTools(req.tools) : undefined,
        tool_choice: req.tools.length ? "auto" : undefined,
        temperature: req.temperature,
      },
      signal: req.signal,
      tlsInsecure: this.tlsInsecure,
    });

    if (status >= 400) {
      const msg =
        body?.error?.message || body?.message || `OpenAI-compatible HTTP ${status}`;
      throw new Error(msg);
    }

    return parseOpenAiResponse(body);
  }
}

/** Ollama native /api/chat (tools supported on recent models). */
export class OllamaProvider implements LlmProvider {
  readonly id = "ollama" as const;

  constructor(
    public readonly baseUrl = "http://localhost:11434",
    public readonly tlsInsecure = false,
    public readonly apiKey = ""
  ) {}

  async complete(req: CompletionRequest) {
    const url = `${this.baseUrl.replace(/\/$/, "")}/api/chat`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    // Ollama accepts OpenAI-style messages/tools in /api/chat
    const messages = toOpenAiMessages(
      req.messages.filter((m) => m.role !== "system")
    );
    const system = req.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");

    const { status, body } = await httpJson(url, {
      method: "POST",
      headers,
      body: {
        model: req.model,
        messages: system
          ? [{ role: "system", content: system }, ...messages]
          : messages,
        tools: req.tools.length ? toOpenAiTools(req.tools) : undefined,
        stream: false,
        options: { temperature: req.temperature },
      },
      signal: req.signal,
      tlsInsecure: this.tlsInsecure,
    });

    if (status >= 400) {
      const msg = body?.error || body?.message || `Ollama HTTP ${status}`;
      throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
    }

    const msg = body?.message ?? {};
    const toolCalls: ToolCall[] | undefined = Array.isArray(msg.tool_calls)
      ? msg.tool_calls.map((t: any, i: number) => ({
          id: t.id ?? `ollama_tool_${i}`,
          name: t.function?.name ?? t.name ?? "",
          arguments:
            typeof t.function?.arguments === "string"
              ? t.function.arguments
              : JSON.stringify(t.function?.arguments ?? t.arguments ?? {}),
        }))
      : undefined;

    const message: ChatMessage = {
      role: "assistant",
      content: typeof msg.content === "string" ? msg.content : "",
      toolCalls: toolCalls?.length ? toolCalls : undefined,
    };

    return {
      message,
      finishReason: (toolCalls?.length ? "tool_calls" : "stop") as
        | "tool_calls"
        | "stop",
    };
  }
}

export class AnthropicProvider implements LlmProvider {
  readonly id = "anthropic" as const;

  constructor(
    public readonly apiKey: string,
    public readonly baseUrl = "https://api.anthropic.com",
    public readonly tlsInsecure = false
  ) {}

  private toAnthropicMessages(messages: ChatMessage[]): {
    system: string;
    messages: unknown[];
  } {
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

    const { status, body } = await httpJson(
      `${this.baseUrl.replace(/\/$/, "")}/v1/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: {
          model: req.model,
          max_tokens: 8192,
          system: system || undefined,
          messages,
          tools: tools.length ? tools : undefined,
          temperature: req.temperature,
        },
        signal: req.signal,
        tlsInsecure: this.tlsInsecure,
      }
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

/** Google Gemini (Generative Language API) with function calling. */
export class GeminiProvider implements LlmProvider {
  readonly id = "gemini" as const;

  constructor(
    public readonly apiKey: string,
    public readonly baseUrl = "https://generativelanguage.googleapis.com/v1beta",
    public readonly tlsInsecure = false
  ) {}

  private toGeminiContents(messages: ChatMessage[]): {
    systemInstruction?: { parts: { text: string }[] };
    contents: unknown[];
  } {
    let system = "";
    const contents: unknown[] = [];

    for (const m of messages) {
      if (m.role === "system") {
        system += (system ? "\n\n" : "") + m.content;
        continue;
      }

      if (m.role === "user") {
        contents.push({
          role: "user",
          parts: [{ text: m.content }],
        });
        continue;
      }

      if (m.role === "assistant") {
        const parts: unknown[] = [];
        if (m.content) {
          parts.push({ text: m.content });
        }
        for (const t of m.toolCalls ?? []) {
          let args: unknown = {};
          try {
            args = JSON.parse(t.arguments || "{}");
          } catch {
            args = { raw: t.arguments };
          }
          parts.push({
            functionCall: {
              name: t.name,
              args,
            },
          });
        }
        contents.push({
          role: "model",
          parts: parts.length ? parts : [{ text: "" }],
        });
        continue;
      }

      if (m.role === "tool") {
        let response: unknown;
        try {
          response = JSON.parse(m.content);
        } catch {
          response = { result: m.content };
        }
        // Gemini expects functionResponse on a user turn
        const part = {
          functionResponse: {
            name: m.name || "tool",
            response:
              typeof response === "object" && response !== null
                ? response
                : { result: response },
          },
        };
        const last = contents[contents.length - 1] as
          | { role: string; parts: unknown[] }
          | undefined;
        if (last && last.role === "user" && Array.isArray(last.parts)) {
          last.parts.push(part);
        } else {
          contents.push({ role: "user", parts: [part] });
        }
      }
    }

    return {
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      contents,
    };
  }

  async complete(req: CompletionRequest) {
    const model = req.model || "gemini-2.0-flash";
    const base = this.baseUrl.replace(/\/$/, "");
    const url = `${base}/models/${encodeURIComponent(model)}:generateContent`;
    const { systemInstruction, contents } = this.toGeminiContents(req.messages);

    const tools =
      req.tools.length > 0
        ? [
            {
              functionDeclarations: req.tools.map((t) => ({
                name: t.name,
                description: t.description,
                parameters: t.parameters,
              })),
            },
          ]
        : undefined;

    const { status, body } = await httpJson(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": this.apiKey,
      },
      body: {
        systemInstruction,
        contents,
        tools,
        generationConfig: {
          temperature: req.temperature,
        },
      },
      signal: req.signal,
      tlsInsecure: this.tlsInsecure,
    });

    if (status >= 400) {
      const msg =
        body?.error?.message || body?.message || `Gemini HTTP ${status}`;
      throw new Error(msg);
    }

    const parts = body?.candidates?.[0]?.content?.parts ?? [];
    let text = "";
    const toolCalls: ToolCall[] = [];
    for (const part of parts) {
      if (typeof part.text === "string") {
        text += part.text;
      }
      if (part.functionCall?.name) {
        toolCalls.push({
          id: `gemini_${toolCalls.length}_${part.functionCall.name}`,
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args ?? {}),
        });
      }
    }

    // Preserve tool names on subsequent tool result turns
    const message: ChatMessage = {
      role: "assistant",
      content: text,
      toolCalls: toolCalls.length ? toolCalls : undefined,
    };

    const finishReasonRaw = body?.candidates?.[0]?.finishReason as string | undefined;
    const finish = toolCalls.length
      ? "tool_calls"
      : finishReasonRaw === "MAX_TOKENS"
        ? "length"
        : "stop";

    return {
      message,
      finishReason: finish as "stop" | "tool_calls" | "length",
    };
  }
}

export function defaultBaseUrl(provider: ProviderId): string {
  switch (provider) {
    case "openai":
      return "https://api.openai.com/v1";
    case "anthropic":
      return "https://api.anthropic.com";
    case "gemini":
      return "https://generativelanguage.googleapis.com/v1beta";
    case "ollama":
      return "http://localhost:11434";
    case "openai-compatible":
      return "";
    default:
      return "";
  }
}

export function defaultModel(provider: ProviderId): string {
  switch (provider) {
    case "openai":
      return "gpt-4o";
    case "anthropic":
      return "claude-sonnet-4-20250514";
    case "gemini":
      return "gemini-2.0-flash";
    case "ollama":
      return "llama3.1";
    case "openai-compatible":
      return "gpt-4o";
    default:
      return "gpt-4o";
  }
}

export function providerRequiresApiKey(provider: ProviderId): boolean {
  return provider !== "ollama";
}

export function createProvider(opts: ProviderCreateOptions): LlmProvider {
  const { provider, apiKey, tlsInsecure } = opts;
  const baseUrl = (opts.baseUrl || defaultBaseUrl(provider)).replace(/\/$/, "");

  switch (provider) {
    case "openai":
      return new OpenAiCompatibleProvider(
        apiKey,
        baseUrl || defaultBaseUrl("openai"),
        "openai",
        tlsInsecure,
        "bearer"
      );
    case "openai-compatible":
      if (!baseUrl) {
        throw new Error("forgeAgent.baseUrl é obrigatório para openai-compatible.");
      }
      return new OpenAiCompatibleProvider(
        apiKey,
        baseUrl,
        "openai-compatible",
        tlsInsecure,
        "bearer"
      );
    case "ollama":
      return new OllamaProvider(baseUrl || defaultBaseUrl("ollama"), tlsInsecure, apiKey);
    case "anthropic":
      if (!apiKey) {
        throw new Error("API key Anthropic é obrigatória.");
      }
      return new AnthropicProvider(
        apiKey,
        baseUrl || defaultBaseUrl("anthropic"),
        tlsInsecure
      );
    case "gemini":
      if (!apiKey) {
        throw new Error("API key Gemini é obrigatória.");
      }
      return new GeminiProvider(
        apiKey,
        baseUrl || defaultBaseUrl("gemini"),
        tlsInsecure
      );
    default:
      throw new Error(`Provedor desconhecido: ${provider as string}`);
  }
}
