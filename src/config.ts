import * as vscode from "vscode";
import type { AutonomyMode, ForgeConfig, ProviderId } from "./types";
import { defaultBaseUrl } from "./providers";
import {
  contextWindowForModelId,
  DEFAULT_CONTEXT_WINDOW,
} from "./providers/models";
import type { ProfileStore } from "./agent/profiles";

let profileStore: ProfileStore | undefined;

export function bindProfileStore(store: ProfileStore): void {
  profileStore = store;
}

function normalizeContextWindow(value: unknown, model: string): number {
  const n = Number(value);
  if (Number.isFinite(n) && n >= 1_024) {
    return Math.floor(n);
  }
  return contextWindowForModelId(model);
}

export function readConfig(): ForgeConfig {
  const c = vscode.workspace.getConfiguration("forgeAgent");
  const profile = profileStore?.active();
  const provider = (profile?.provider ?? c.get<ProviderId>("provider", "openai")) as ProviderId;
  const model = profile?.model ?? c.get<string>("model", "gpt-4o");
  const configuredBase = (
    profile?.baseUrl ??
    c.get<string>("baseUrl", "") ??
    ""
  ).replace(/\/$/, "");
  const contextWindow = normalizeContextWindow(
    profile?.contextWindow ?? c.get<number>("contextWindow", DEFAULT_CONTEXT_WINDOW),
    model
  );
  return {
    provider,
    model,
    baseUrl: configuredBase || defaultBaseUrl(provider),
    tlsInsecure: profile?.tlsInsecure ?? c.get<boolean>("tlsInsecure", false),
    contextWindow,
    maxToolRounds: c.get<number>("maxToolRounds", 25),
    autonomy: c.get<AutonomyMode>("autonomy", "agent"),
    autoApproveReads: c.get<boolean>("autoApproveReads", true),
    requireApprovalForWrites: c.get<boolean>("requireApprovalForWrites", true),
    requireApprovalForTerminal: c.get<boolean>("requireApprovalForTerminal", true),
    systemPromptExtra: c.get<string>("systemPromptExtra", "") || "",
    temperature: c.get<number>("temperature", 0.2),
    profileId: profile?.id,
    profileName: profile?.name,
  };
}

export async function setAutonomy(mode: AutonomyMode): Promise<void> {
  await vscode.workspace
    .getConfiguration("forgeAgent")
    .update("autonomy", mode, vscode.ConfigurationTarget.Workspace);
}

export function cycleAutonomy(current: AutonomyMode): AutonomyMode {
  const order: AutonomyMode[] = ["ask", "plan", "agent", "auto"];
  const i = order.indexOf(current);
  return order[(i + 1) % order.length];
}

export async function setActiveModel(
  model: string,
  contextWindow?: number
): Promise<void> {
  const resolved = normalizeContextWindow(contextWindow, model);
  if (profileStore) {
    const active = await profileStore.ensureSeeded();
    active.model = model;
    active.contextWindow = resolved;
    await profileStore.upsert(active);
    await profileStore.setActive(active.id);
    return;
  }
  const c = vscode.workspace.getConfiguration("forgeAgent");
  await c.update("model", model, vscode.ConfigurationTarget.Global);
  await c.update("contextWindow", resolved, vscode.ConfigurationTarget.Global);
}
