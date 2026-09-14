import * as vscode from "vscode";
import type { ProviderId } from "../types";

const SECRET_PREFIX = "forgeAgent.apiKey.";

export class KeyStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  private keyFor(provider: ProviderId): string {
    // openai-compatible shares the openai secret slot unless a dedicated one is desired
    const slot = provider === "openai-compatible" ? "openai-compatible" : provider;
    return `${SECRET_PREFIX}${slot}`;
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
    const v = await this.get(provider);
    return Boolean(v && v.length > 0);
  }
}

export async function promptAndStoreApiKey(
  keyStore: KeyStore,
  preferred?: ProviderId
): Promise<ProviderId | undefined> {
  const provider =
    preferred ??
    ((await vscode.window.showQuickPick(
      [
        { label: "OpenAI", description: "api.openai.com", id: "openai" as ProviderId },
        { label: "Anthropic", description: "api.anthropic.com", id: "anthropic" as ProviderId },
        {
          label: "OpenAI-compatible",
          description: "OpenRouter, Groq, DeepSeek, Ollama, Azure…",
          id: "openai-compatible" as ProviderId,
        },
      ],
      { title: "Forge Agent — escolha o provedor (BYOK)" }
    ))?.id);

  if (!provider) {
    return undefined;
  }

  const apiKey = await vscode.window.showInputBox({
    title: `Forge Agent — API Key (${provider})`,
    prompt: "A chave fica no SecretStorage do VS Code (não no settings.json).",
    password: true,
    ignoreFocusOut: true,
    placeHolder: provider === "anthropic" ? "sk-ant-…" : "sk-…",
  });

  if (!apiKey) {
    return undefined;
  }

  await keyStore.set(provider, apiKey);

  const config = vscode.workspace.getConfiguration("forgeAgent");
  await config.update("provider", provider, vscode.ConfigurationTarget.Global);

  if (provider === "openai-compatible") {
    const baseUrl = await vscode.window.showInputBox({
      title: "Base URL (openai-compatible)",
      prompt: "Ex.: https://openrouter.ai/api/v1 ou http://localhost:11434/v1",
      ignoreFocusOut: true,
      value: config.get<string>("baseUrl") || "",
    });
    if (baseUrl) {
      await config.update("baseUrl", baseUrl.replace(/\/$/, ""), vscode.ConfigurationTarget.Global);
    }
  }

  void vscode.window.showInformationMessage(`API key salva para ${provider}.`);
  return provider;
}
