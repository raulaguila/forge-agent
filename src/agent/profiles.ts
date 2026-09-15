import * as vscode from "vscode";
import type { ProviderId, ProviderProfile } from "../types";
import { defaultBaseUrl, defaultModel } from "../providers";
import { contextWindowForModelId } from "../providers/models";

const PROFILES_KEY = "forgeAgent.profiles";
const ACTIVE_KEY = "forgeAgent.activeProfileId";

function newId(): string {
  return `prof_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export class ProfileStore {
  constructor(private readonly state: vscode.Memento) {}

  list(): ProviderProfile[] {
    return this.state.get<ProviderProfile[]>(PROFILES_KEY, []);
  }

  get(id: string): ProviderProfile | undefined {
    return this.list().find((p) => p.id === id);
  }

  activeId(): string | undefined {
    return this.state.get<string>(ACTIVE_KEY);
  }

  active(): ProviderProfile | undefined {
    const id = this.activeId();
    if (!id) {
      return this.list()[0];
    }
    return this.get(id) ?? this.list()[0];
  }

  async saveAll(profiles: ProviderProfile[]): Promise<void> {
    await this.state.update(PROFILES_KEY, profiles);
  }

  async upsert(profile: ProviderProfile): Promise<void> {
    const all = this.list().filter((p) => p.id !== profile.id);
    all.unshift(profile);
    await this.saveAll(all);
  }

  async remove(id: string): Promise<void> {
    const all = this.list().filter((p) => p.id !== id);
    await this.saveAll(all);
    if (this.activeId() === id) {
      await this.state.update(ACTIVE_KEY, all[0]?.id);
    }
  }

  async setActive(id: string): Promise<void> {
    const profile = this.get(id);
    if (!profile) {
      return;
    }
    await this.state.update(ACTIVE_KEY, id);
    await syncSettingsFromProfile(profile);
  }

  /**
   * Ensure at least one profile exists, seeded from current settings when needed.
   */
  async ensureSeeded(): Promise<ProviderProfile> {
    const existing = this.active();
    if (existing) {
      return existing;
    }
    const c = vscode.workspace.getConfiguration("forgeAgent");
    const provider = c.get<ProviderId>("provider", "openai");
    const model = c.get<string>("model", defaultModel(provider));
    const storedCtx = c.get<number>("contextWindow");
    const profile: ProviderProfile = {
      id: newId(),
      name: labelFor(provider),
      provider,
      model,
      baseUrl: (c.get<string>("baseUrl", "") || "").replace(/\/$/, "") || defaultBaseUrl(provider),
      tlsInsecure: c.get<boolean>("tlsInsecure", false),
      contextWindow:
        Number.isFinite(storedCtx) && (storedCtx as number) >= 1_024
          ? Math.floor(storedCtx as number)
          : contextWindowForModelId(model),
    };
    await this.upsert(profile);
    await this.state.update(ACTIVE_KEY, profile.id);
    return profile;
  }
}

export function labelFor(provider: ProviderId): string {
  switch (provider) {
    case "openai":
      return "OpenAI";
    case "openai-compatible":
      return "OpenAI-compatible";
    case "ollama":
      return "Ollama";
    case "anthropic":
      return "Anthropic";
    case "gemini":
      return "Gemini";
    default:
      return provider;
  }
}

export async function syncSettingsFromProfile(profile: ProviderProfile): Promise<void> {
  const c = vscode.workspace.getConfiguration("forgeAgent");
  const target = vscode.ConfigurationTarget.Global;
  const contextWindow = contextWindowForModelId(profile.model, profile.contextWindow);
  await c.update("provider", profile.provider, target);
  await c.update("model", profile.model, target);
  await c.update("baseUrl", profile.baseUrl || "", target);
  await c.update("tlsInsecure", profile.tlsInsecure, target);
  await c.update("contextWindow", contextWindow, target);
}

export async function createProfileInteractive(
  store: ProfileStore
): Promise<ProviderProfile | undefined> {
  const providerPick = await vscode.window.showQuickPick(
    [
      { label: "OpenAI", id: "openai" as ProviderId },
      { label: "OpenAI-compatible", id: "openai-compatible" as ProviderId },
      { label: "Ollama", id: "ollama" as ProviderId },
      { label: "Anthropic", id: "anthropic" as ProviderId },
      { label: "Gemini", id: "gemini" as ProviderId },
    ],
    { title: "Forge Agent — provedor do perfil" }
  );
  if (!providerPick) {
    return undefined;
  }
  const provider = providerPick.id;
  const name = await vscode.window.showInputBox({
    title: "Nome do perfil",
    value: labelFor(provider),
    ignoreFocusOut: true,
  });
  if (!name) {
    return undefined;
  }

  let baseUrl = defaultBaseUrl(provider);
  if (provider === "openai-compatible" || provider === "ollama") {
    const entered = await vscode.window.showInputBox({
      title: `Base URL (${provider})`,
      value: baseUrl || (provider === "ollama" ? "http://localhost:11434" : ""),
      ignoreFocusOut: true,
      prompt:
        provider === "openai-compatible"
          ? "Ex.: https://openrouter.ai/api/v1"
          : "Ex.: http://localhost:11434",
    });
    if (entered === undefined) {
      return undefined;
    }
    baseUrl = entered.replace(/\/$/, "");
  }

  let tlsInsecure = false;
  if (provider === "openai-compatible") {
    const tls = await vscode.window.showQuickPick(
      [
        { label: "TLS seguro", value: false },
        { label: "TLS insecure", value: true },
      ],
      { title: "Verificação TLS" }
    );
    if (!tls) {
      return undefined;
    }
    tlsInsecure = tls.value;
  }

  const model =
    (await vscode.window.showInputBox({
      title: "Modelo inicial",
      value: defaultModel(provider),
      ignoreFocusOut: true,
      prompt: "Você poderá listar modelos do provedor depois",
    })) || defaultModel(provider);

  const profile: ProviderProfile = {
    id: newId(),
    name: name.trim(),
    provider,
    model,
    baseUrl,
    tlsInsecure,
    contextWindow: contextWindowForModelId(model),
  };
  await store.upsert(profile);
  await store.setActive(profile.id);
  return profile;
}

export async function switchProfileInteractive(store: ProfileStore): Promise<ProviderProfile | undefined> {
  await store.ensureSeeded();
  const items = [
    ...store.list().map((p) => ({
      label: p.name,
      description: `${p.provider} · ${p.model}`,
      detail: p.baseUrl || undefined,
      profile: p,
    })),
    {
      label: "$(add) Novo perfil…",
      description: "Registrar outro provedor",
      profile: undefined as ProviderProfile | undefined,
    },
  ];
  const pick = await vscode.window.showQuickPick(items, {
    title: "Forge Agent — perfil ativo",
  });
  if (!pick) {
    return undefined;
  }
  if (!pick.profile) {
    return createProfileInteractive(store);
  }
  await store.setActive(pick.profile.id);
  return pick.profile;
}

export async function manageProfilesInteractive(store: ProfileStore): Promise<void> {
  await store.ensureSeeded();
  const pick = await vscode.window.showQuickPick(
    [
      { label: "Ativar / trocar perfil", action: "switch" as const },
      { label: "Novo perfil", action: "create" as const },
      { label: "Renomear perfil ativo", action: "rename" as const },
      { label: "Remover perfil…", action: "remove" as const },
    ],
    { title: "Forge Agent — gerenciar perfis" }
  );
  if (!pick) {
    return;
  }
  if (pick.action === "switch") {
    await switchProfileInteractive(store);
    return;
  }
  if (pick.action === "create") {
    await createProfileInteractive(store);
    return;
  }
  if (pick.action === "rename") {
    const active = store.active();
    if (!active) return;
    const name = await vscode.window.showInputBox({
      title: "Renomear perfil",
      value: active.name,
      ignoreFocusOut: true,
    });
    if (!name) return;
    active.name = name.trim();
    await store.upsert(active);
    return;
  }
  if (pick.action === "remove") {
    const toRemove = await vscode.window.showQuickPick(
      store.list().map((p) => ({
        label: p.name,
        description: `${p.provider} · ${p.model}`,
        id: p.id,
      })),
      { title: "Remover perfil" }
    );
    if (!toRemove) return;
    if (store.list().length <= 1) {
      void vscode.window.showWarningMessage("Mantenha ao menos um perfil.");
      return;
    }
    await store.remove(toRemove.id);
  }
}
