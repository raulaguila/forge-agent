import type {
  ChatMessage,
  CompletionRequest,
  LlmProvider,
  ProviderId,
  TokenUsage,
  ToolCall,
  ToolDefinition,
} from "../types";
import { httpJson, httpStreamText } from "./http";
import { estimateCostUsd } from "./usage";

export interface ProviderCreateOptions {
  provider: ProviderId;
  apiKey: string;
  baseUrl: string;
  tlsInsecure: boolean;
}

function usageFromOpenAi(body: any, model: string): TokenUsage | undefined {
  const u = body?.usage;
  if (!u) {
    return undefined;
  }
  const inputTokens = Number(u.prompt_tokens ?? u.input_tokens ?? 0);
  const outputTokens = Number(u.completion_tokens ?? u.output_tokens ?? 0);
  const totalTokens = Number(u.total_tokens ?? inputTokens + outputTokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    estimatedCostUsd: estimateCostUsd(model, inputTokens, outputTokens),
  };
}

function emitFullDelta(req: CompletionRequest, text: string): void {
  if (text && req.onDelta) {
    req.onDelta(text);
  }
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

    const useStream = Boolean(req.onDelta);
    if (useStream) {
      return this.completeStream(url, headers, req);
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

    const parsed = parseOpenAiResponse(body);
    return { ...parsed, usage: usageFromOpenAi(body, req.model) };
  }

  private async completeStream(
    url: string,
    headers: Record<string, string>,
    req: CompletionRequest
  ) {
    let content = "";
    const toolAcc = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();
    let finishReason: "stop" | "tool_calls" | "length" = "stop";
    let usage: TokenUsage | undefined;
    let buffer = "";

    for await (const chunk of httpStreamText(url, {
      method: "POST",
      headers,
      body: {
        model: req.model,
        messages: toOpenAiMessages(req.messages),
        tools: req.tools.length ? toOpenAiTools(req.tools) : undefined,
        tool_choice: req.tools.length ? "auto" : undefined,
        temperature: req.temperature,
        stream: true,
        stream_options: { include_usage: true },
      },
      signal: req.signal,
      tlsInsecure: this.tlsInsecure,
    })) {
      buffer += chunk;
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      for (const line of parts) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) {
          continue;
        }
        const data = trimmed.slice(5).trim();
        if (!data || data === "[DONE]") {
          continue;
        }
        let json: any;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }
        if (json.usage) {
          usage = usageFromOpenAi(json, req.model);
        }
        const choice = json.choices?.[0];
        const delta = choice?.delta;
        if (typeof delta?.content === "string" && delta.content) {
          content += delta.content;
          req.onDelta?.(delta.content);
        }
        if (Array.isArray(delta?.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            const cur = toolAcc.get(idx) ?? { id: "", name: "", arguments: "" };
            if (tc.id) {
              cur.id = tc.id;
            }
            if (tc.function?.name) {
              cur.name += tc.function.name;
            }
            if (tc.function?.arguments) {
              cur.arguments += tc.function.arguments;
            }
            toolAcc.set(idx, cur);
          }
        }
        if (choice?.finish_reason === "tool_calls") {
          finishReason = "tool_calls";
        } else if (choice?.finish_reason === "length") {
          finishReason = "length";
        }
      }
    }

    const toolCalls = [...toolAcc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, t]) => ({
        id: t.id || `call_${Math.random().toString(36).slice(2, 10)}`,
        name: t.name,
        arguments: t.arguments || "{}",
      }));
    if (toolCalls.length) {
      finishReason = "tool_calls";
    }

    return {
      message: {
        role: "assistant" as const,
        content,
        toolCalls: toolCalls.length ? toolCalls : undefined,
      },
      finishReason,
      usage,
    };
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

    emitFullDelta(req, message.content);

    return {
      message,
      finishReason: (toolCalls?.length ? "tool_calls" : "stop") as
        | "tool_calls"
        | "stop",
      usage: body?.prompt_eval_count
        ? {
            inputTokens: Number(body.prompt_eval_count ?? 0),
            outputTokens: Number(body.eval_count ?? 0),
            totalTokens:
              Number(body.prompt_eval_count ?? 0) + Number(body.eval_count ?? 0),
            estimatedCostUsd: 0,
          }
        : undefined,
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

    emitFullDelta(req, message.content);
    const usage = body?.usage
      ? {
          inputTokens: Number(body.usage.input_tokens ?? 0),
          outputTokens: Number(body.usage.output_tokens ?? 0),
          totalTokens:
            Number(body.usage.input_tokens ?? 0) +
            Number(body.usage.output_tokens ?? 0),
          estimatedCostUsd: estimateCostUsd(
            req.model,
            Number(body.usage.input_tokens ?? 0),
            Number(body.usage.output_tokens ?? 0)
          ),
        }
      : undefined;

    return {
      message,
      finishReason: finish as "stop" | "tool_calls" | "length",
      usage,
    };
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

    emitFullDelta(req, message.content);
    const um = body?.usageMetadata;
    const usage = um
      ? {
          inputTokens: Number(um.promptTokenCount ?? 0),
          outputTokens: Number(um.candidatesTokenCount ?? 0),
          totalTokens: Number(um.totalTokenCount ?? 0),
          estimatedCostUsd: estimateCostUsd(
            req.model,
            Number(um.promptTokenCount ?? 0),
            Number(um.candidatesTokenCount ?? 0)
          ),
        }
      : undefined;

    return {
      message,
      finishReason: finish as "stop" | "tool_calls" | "length",
      usage,
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
