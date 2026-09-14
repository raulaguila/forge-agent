import type { ProviderId } from "../types";
import { httpJson } from "./http";

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
    .map((m: any) => String(m.id || m.name || ""))
    .filter(Boolean)
    .sort()
    .map((id: string) => ({ id, label: id }));
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
  return models
    .map((m: any) => String(m.name || m.model || ""))
    .filter(Boolean)
    .sort()
    .map((id: string) => ({ id, label: id }));
}

/** Anthropic has no public models list for all keys; ship curated + optional API. */
async function listAnthropicModels(
  base: string,
  apiKey: string,
  tlsInsecure: boolean
): Promise<ModelInfo[]> {
  const curated = [
    "claude-sonnet-4-20250514",
    "claude-opus-4-20250514",
    "claude-3-7-sonnet-20250219",
    "claude-3-5-sonnet-20241022",
    "claude-3-5-haiku-20241022",
    "claude-3-opus-20240229",
  ].map((id) => ({ id, label: id, detail: "curated" }));

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
        .map((m: any) => String(m.id || ""))
        .filter(Boolean)
        .map((id: string) => ({ id, label: id, detail: "api" }));
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
      if (methods.length && !methods.includes("generateContent")) {
        return "";
      }
      return id;
    })
    .filter(Boolean)
    .sort()
    .map((id: string) => ({ id, label: id }));
}
