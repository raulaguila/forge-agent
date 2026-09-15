import type { ProviderId } from "../types";
import { httpJson } from "./http";

/** Default when API/curated lookup has nothing better. */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

/** Known model id → context tokens (used when the list API omits the field). */
const CURATED_CONTEXT: Array<{ match: RegExp; tokens: number }> = [
  { match: /^gpt-4\.1/i, tokens: 1_047_576 },
  { match: /^gpt-4o/i, tokens: 128_000 },
  { match: /^gpt-4-turbo/i, tokens: 128_000 },
  { match: /^gpt-4(?!-)/i, tokens: 8_192 },
  { match: /^gpt-3\.5/i, tokens: 16_385 },
  { match: /^o1-mini/i, tokens: 128_000 },
  { match: /^o1/i, tokens: 200_000 },
  { match: /^o3-mini/i, tokens: 200_000 },
  { match: /^o3/i, tokens: 200_000 },
  { match: /^o4-mini/i, tokens: 200_000 },
  { match: /^claude-(opus|sonnet)-4/i, tokens: 200_000 },
  { match: /^claude-3-7/i, tokens: 200_000 },
  { match: /^claude-3-5/i, tokens: 200_000 },
  { match: /^claude-3-opus/i, tokens: 200_000 },
  { match: /^claude-3-haiku/i, tokens: 200_000 },
  { match: /^claude-3-sonnet/i, tokens: 200_000 },
  { match: /^gemini-2\.5/i, tokens: 1_048_576 },
  { match: /^gemini-2\.0/i, tokens: 1_048_576 },
  { match: /^gemini-1\.5-pro/i, tokens: 2_000_000 },
  { match: /^gemini-1\.5-flash/i, tokens: 1_000_000 },
  { match: /^gemini-pro/i, tokens: 32_768 },
  { match: /^llama3\.3/i, tokens: 128_000 },
  { match: /^llama3\.2/i, tokens: 128_000 },
  { match: /^llama3\.1/i, tokens: 128_000 },
  { match: /^llama3/i, tokens: 8_192 },
  { match: /^qwen2\.5/i, tokens: 32_768 },
  { match: /^qwen2/i, tokens: 32_768 },
  { match: /^mistral/i, tokens: 32_768 },
  { match: /^mixtral/i, tokens: 32_768 },
  { match: /^deepseek/i, tokens: 64_000 },
  { match: /^codellama/i, tokens: 16_384 },
];

function resolveBase(provider: ProviderId, baseUrl: string): string {
  const trimmed = (baseUrl || "").replace(/\/$/, "");
  if (trimmed) return trimmed;
  switch (provider) {
    case "openai":
      return "https://api.openai.com/v1";
    case "anthropic":
      return "https://api.anthropic.com";
    case "gemini":
      return "https://generativelanguage.googleapis.com/v1beta";
    case "ollama":
      return "http://localhost:11434";
    default:
      return "";
  }
}

export interface ModelInfo {
  id: string;
  label: string;
  detail?: string;
  /** Context window in tokens (API, curated, or default). */
  contextWindow: number;
  /** True when the value came from the provider API (not curated/default). */
  contextFromApi?: boolean;
}

/** Pull a positive token count from common provider payload shapes. */
export function extractContextWindow(raw: unknown): number | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const m = raw as Record<string, any>;
  const candidates: unknown[] = [
    m.context_length,
    m.context_window,
    m.contextWindow,
    m.max_context_length,
    m.max_model_len,
    m.max_input_tokens,
    m.maxInputTokens,
    m.input_token_limit,
    m.inputTokenLimit,
    m.top_provider?.context_length,
    m.architecture?.context_length,
    m.limits?.context_window_tokens,
    m.model_info?.["llama.context_length"],
    m.model_info?.["qwen.context_length"],
    m.model_info?.["qwen2.context_length"],
    m.model_info?.["general.context_length"],
    m.model_info?.context_length,
    m.parameters?.num_ctx,
  ];
  if (m.model_info && typeof m.model_info === "object") {
    for (const [key, val] of Object.entries(m.model_info)) {
      if (/context.?length/i.test(key)) candidates.push(val);
    }
  }
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n >= 1_024) return Math.floor(n);
  }
  return undefined;
}

/** Resolve tokens: API value → curated id match → default. */
export function contextWindowForModelId(id: string, fromApi?: number): number {
  if (fromApi && Number.isFinite(fromApi) && fromApi >= 1_024) {
    return Math.floor(fromApi);
  }
  const name = String(id || "").trim();
  for (const entry of CURATED_CONTEXT) {
    if (entry.match.test(name)) return entry.tokens;
  }
  // Ollama tags often look like "llama3.1:8b" — match before the colon/tag
  const base = name.split(/[:/]/)[0] || name;
  if (base !== name) {
    for (const entry of CURATED_CONTEXT) {
      if (entry.match.test(base)) return entry.tokens;
    }
  }
  return DEFAULT_CONTEXT_WINDOW;
}

function finalizeModel(
  id: string,
  opts?: { fromApi?: number; detail?: string }
): ModelInfo {
  const fromApi = opts?.fromApi;
  const contextWindow = contextWindowForModelId(id, fromApi);
  const contextFromApi = Boolean(fromApi && fromApi >= 1_024);
  const bits = [
    opts?.detail,
    contextFromApi
      ? `${contextWindow.toLocaleString()} ctx (API)`
      : `${contextWindow.toLocaleString()} ctx`,
  ].filter(Boolean);
  return {
    id,
    label: id,
    contextWindow,
    contextFromApi,
    detail: bits.join(" · ") || undefined,
  };
}

export async function listModels(opts: {
  provider: ProviderId;
  apiKey: string;
  baseUrl: string;
  tlsInsecure: boolean;
}): Promise<ModelInfo[]> {
  const base = resolveBase(opts.provider, opts.baseUrl);
  switch (opts.provider) {
    case "openai":
    case "openai-compatible":
      return listOpenAiModels(base, opts.apiKey, opts.tlsInsecure);
    case "ollama":
      return listOllamaModels(base, opts.apiKey, opts.tlsInsecure);
    case "anthropic":
      return listAnthropicModels(base, opts.apiKey, opts.tlsInsecure);
    case "gemini":
      return listGeminiModels(base, opts.apiKey, opts.tlsInsecure);
    default:
      return [];
  }
}

/**
 * Best-effort context for one model (e.g. Ollama /api/show). Falls back to curated/default.
 */
export async function resolveModelContextWindow(opts: {
  provider: ProviderId;
  apiKey: string;
  baseUrl: string;
  tlsInsecure: boolean;
  model: string;
}): Promise<number> {
  const model = opts.model.trim();
  if (!model) return DEFAULT_CONTEXT_WINDOW;
  const base = resolveBase(opts.provider, opts.baseUrl);

  try {
    if (opts.provider === "ollama" && base) {
      const headers: Record<string, string> = {};
      if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
      const { status, body } = await httpJson(`${base}/api/show`, {
        method: "POST",
        headers,
        body: { name: model },
        tlsInsecure: opts.tlsInsecure,
        timeoutMs: 20_000,
      });
      if (status >= 200 && status < 300) {
        const fromApi = extractContextWindow(body);
        return contextWindowForModelId(model, fromApi);
      }
    }

    if (
      (opts.provider === "openai" || opts.provider === "openai-compatible") &&
      base
    ) {
      const { status, body } = await httpJson(
        `${base}/models/${encodeURIComponent(model)}`,
        {
          method: "GET",
          headers: opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {},
          tlsInsecure: opts.tlsInsecure,
          timeoutMs: 15_000,
        }
      );
      if (status >= 200 && status < 300) {
        const fromApi = extractContextWindow(body) ?? extractContextWindow(body?.data);
        if (fromApi) return contextWindowForModelId(model, fromApi);
      }
    }

    if (opts.provider === "gemini" && base && opts.apiKey) {
      const url = `${base}/models/${encodeURIComponent(model)}?key=${encodeURIComponent(opts.apiKey)}`;
      const { status, body } = await httpJson(url, {
        method: "GET",
        tlsInsecure: opts.tlsInsecure,
        timeoutMs: 15_000,
      });
      if (status >= 200 && status < 300) {
        const fromApi = extractContextWindow(body);
        if (fromApi) return contextWindowForModelId(model, fromApi);
      }
    }
  } catch {
    // fall through
  }

  return contextWindowForModelId(model);
}

async function listOpenAiModels(
  base: string,
  apiKey: string,
  tlsInsecure: boolean
): Promise<ModelInfo[]> {
  if (!base) {
    throw new Error("baseUrl obrigatória para listar modelos.");
  }
  const { status, body, raw } = await httpJson(`${base}/models`, {
    method: "GET",
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    tlsInsecure,
    timeoutMs: 30_000,
  });
  if (status < 200 || status >= 300) {
    throw new Error(`List models falhou (${status}): ${raw.slice(0, 300)}`);
  }
  const data = Array.isArray(body?.data) ? body.data : [];
  return data
    .map((m: any) => {
      const id = String(m.id || m.name || "");
      if (!id) return null;
      return finalizeModel(id, { fromApi: extractContextWindow(m) });
    })
    .filter(Boolean)
    .sort((a: ModelInfo, b: ModelInfo) => a.id.localeCompare(b.id)) as ModelInfo[];
}

async function listOllamaModels(
  base: string,
  apiKey: string,
  tlsInsecure: boolean
): Promise<ModelInfo[]> {
  const headers: Record<string, string> = {};
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  const { status, body, raw } = await httpJson(`${base}/api/tags`, {
    method: "GET",
    headers,
    tlsInsecure,
    timeoutMs: 30_000,
  });
  if (status < 200 || status >= 300) {
    throw new Error(`Ollama /api/tags falhou (${status}): ${raw.slice(0, 300)}`);
  }
  const models = Array.isArray(body?.models) ? body.models : [];
  const listed = models
    .map((m: any) => String(m.name || m.model || ""))
    .filter(Boolean)
    .sort() as string[];

  const enriched = await mapPool(listed, 4, async (id) => {
    try {
      const show = await httpJson(`${base}/api/show`, {
        method: "POST",
        headers,
        body: { name: id },
        tlsInsecure,
        timeoutMs: 15_000,
      });
      if (show.status >= 200 && show.status < 300) {
        return finalizeModel(id, { fromApi: extractContextWindow(show.body) });
      }
    } catch {
      // curated/default below
    }
    return finalizeModel(id);
  });

  return enriched;
}

/** Anthropic has no public models list for all keys; ship curated + optional API. */
async function listAnthropicModels(
  base: string,
  apiKey: string,
  tlsInsecure: boolean
): Promise<ModelInfo[]> {
  const curatedIds = [
    "claude-sonnet-4-20250514",
    "claude-opus-4-20250514",
    "claude-3-7-sonnet-20250219",
    "claude-3-5-sonnet-20241022",
    "claude-3-5-haiku-20241022",
    "claude-3-opus-20240229",
  ];
  const curated = curatedIds.map((id) =>
    finalizeModel(id, { detail: "curated" })
  );

  try {
    const { status, body } = await httpJson(`${base}/v1/models`, {
      method: "GET",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      tlsInsecure,
      timeoutMs: 20_000,
    });
    if (status >= 200 && status < 300 && Array.isArray(body?.data)) {
      const remote = body.data
        .map((m: any) => {
          const id = String(m.id || "");
          if (!id) return null;
          return finalizeModel(id, {
            fromApi: extractContextWindow(m),
            detail: "api",
          });
        })
        .filter(Boolean) as ModelInfo[];
      if (remote.length) {
        return remote;
      }
    }
  } catch {
    // fall through to curated
  }
  return curated;
}

async function listGeminiModels(
  base: string,
  apiKey: string,
  tlsInsecure: boolean
): Promise<ModelInfo[]> {
  const url = `${base}/models?key=${encodeURIComponent(apiKey)}`;
  const { status, body, raw } = await httpJson(url, {
    method: "GET",
    tlsInsecure,
    timeoutMs: 30_000,
  });
  if (status < 200 || status >= 300) {
    throw new Error(`Gemini models falhou (${status}): ${raw.slice(0, 300)}`);
  }
  const models = Array.isArray(body?.models) ? body.models : [];
  return models
    .map((m: any) => {
      const name = String(m.name || "");
      const id = name.replace(/^models\//, "");
      const methods: string[] = m.supportedGenerationMethods || [];
      if (!id) return null;
      if (methods.length && !methods.includes("generateContent")) {
        return null;
      }
      return finalizeModel(id, { fromApi: extractContextWindow(m) });
    })
    .filter(Boolean)
    .sort((a: ModelInfo, b: ModelInfo) => a.id.localeCompare(b.id)) as ModelInfo[];
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}
