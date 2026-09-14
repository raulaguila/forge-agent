import * as vscode from "vscode";
import type { ProviderId } from "../types";
import { defaultBaseUrl, defaultModel, providerRequiresApiKey } from "../providers";

const SECRET_PREFIX = "forgeAgent.apiKey.";

const PROVIDER_PICKS: Array<{
  label: string;
  description: string;
  id: ProviderId;
}> = [
  { label: "OpenAI", description: "api.openai.com", id: "openai" },
  {
    label: "OpenAI-compatible",
    description: "OpenRouter, Groq, DeepSeek, Azure, proxies… (TLS insecure opcional)",
    id: "openai-compatible",
  },
  { label: "Ollama", description: "localhost:11434 (key opcional)", id: "ollama" },
  { label: "Anthropic", description: "api.anthropic.com", id: "anthropic" },
  { label: "Gemini", description: "Google Generative Language API", id: "gemini" },
];

export class KeyStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  private keyFor(provider: ProviderId): string {
    return `${SECRET_PREFIX}${provider}`;
  }

  async get(provider: ProviderId): Promise<string | undefined> {
    return this.secrets.get(this.keyFor(provider));
  }

  async set(provider: ProviderId, apiKey: string): Promise<void> {
    await this.secrets.store(this.keyFor(provider), apiKey.trim());
  }

  async clear(provider: ProviderId): Promise<void> {
    await this.secrets.delete(this.keyFor(provider));
  }

  async has(provider: ProviderId): Promise<boolean> {
    if (!providerRequiresApiKey(provider)) {
      return true;
    }
    const v = await this.get(provider);
    return Boolean(v && v.length > 0);
  }
}

function placeholderFor(provider: ProviderId): string {
  switch (provider) {
    case "anthropic":
      return "sk-ant-…";
    case "gemini":
      return "AIza…";
    case "ollama":
      return "(opcional)";
    case "openai-compatible":
      return "sk-… ou token do proxy";
    default:
      return "sk-…";
  }
}

export async function promptAndStoreApiKey(
  keyStore: KeyStore,
  preferred?: ProviderId
): Promise<ProviderId | undefined> {
  const provider =
    preferred ??
    ((await vscode.window.showQuickPick(PROVIDER_PICKS, {
      title: "Forge Agent — escolha o provedor (BYOK)",
    }))?.id);

  if (!provider) {
    return undefined;
  }

  const config = vscode.workspace.getConfiguration("forgeAgent");
  await config.update("provider", provider, vscode.ConfigurationTarget.Global);

  const suggestedModel = defaultModel(provider);
  const currentModel = config.get<string>("model") || "";
  if (!currentModel || currentModel === "gpt-4o" || currentModel.startsWith("claude") || currentModel.startsWith("gemini") || currentModel.startsWith("llama")) {
    await config.update("model", suggestedModel, vscode.ConfigurationTarget.Global);
  }

  if (provider === "openai-compatible" || provider === "ollama") {
    const baseUrl = await vscode.window.showInputBox({
      title: `Base URL (${provider})`,
      prompt:
        provider === "ollama"
          ? "Ex.: http://localhost:11434"
          : "Ex.: https://openrouter.ai/api/v1 — use https://host/v1",
      ignoreFocusOut: true,
      value: config.get<string>("baseUrl") || defaultBaseUrl(provider),
    });
    if (baseUrl !== undefined) {
      await config.update(
        "baseUrl",
        baseUrl.replace(/\/$/, ""),
        vscode.ConfigurationTarget.Global
      );
    }
  }

  if (provider === "openai-compatible") {
    const tls = await vscode.window.showQuickPick(
      [
        { label: "TLS seguro (padrão)", value: false },
        {
          label: "TLS insecure",
          description: "Ignorar certificado (self-signed / proxy corporativo)",
          value: true,
        },
      ],
      { title: "Forge Agent — verificação TLS" }
    );
    if (tls) {
      await config.update("tlsInsecure", tls.value, vscode.ConfigurationTarget.Global);
    }
  }

  if (!providerRequiresApiKey(provider)) {
    const optionalKey = await vscode.window.showInputBox({
      title: `Forge Agent — API Key opcional (${provider})`,
      prompt: "Deixe vazio se o Ollama local não exige autenticação.",
      password: true,
      ignoreFocusOut: true,
      placeHolder: placeholderFor(provider),
    });
    if (optionalKey) {
      await keyStore.set(provider, optionalKey);
    } else {
      await keyStore.clear(provider);
    }
    void vscode.window.showInformationMessage(`Provedor ${provider} configurado.`);
    return provider;
  }

  const apiKey = await vscode.window.showInputBox({
    title: `Forge Agent — API Key (${provider})`,
    prompt: "A chave fica no SecretStorage do VS Code (não no settings.json).",
    password: true,
    ignoreFocusOut: true,
    placeHolder: placeholderFor(provider),
  });

  if (!apiKey) {
    return undefined;
  }

  await keyStore.set(provider, apiKey);
  void vscode.window.showInformationMessage(`API key salva para ${provider}.`);
  return provider;
}
