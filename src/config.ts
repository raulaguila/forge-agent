import * as vscode from "vscode";
import type { AutonomyMode, ForgeConfig, ProviderId } from "./types";
import { defaultBaseUrl } from "./providers";
import type { ProfileStore } from "./agent/profiles";

let profileStore: ProfileStore | undefined;

export function bindProfileStore(store: ProfileStore): void {
  profileStore = store;
}

export function readConfig(): ForgeConfig {
  const c = vscode.workspace.getConfiguration("forgeAgent");
  const profile = profileStore?.active();
  const provider = (profile?.provider ?? c.get<ProviderId>("provider", "openai")) as ProviderId;
  const configuredBase = (
    profile?.baseUrl ??
    c.get<string>("baseUrl", "") ??
    ""
  ).replace(/\/$/, "");
  return {
    provider,
    model: profile?.model ?? c.get<string>("model", "gpt-4o"),
    baseUrl: configuredBase || defaultBaseUrl(provider),
    tlsInsecure: profile?.tlsInsecure ?? c.get<boolean>("tlsInsecure", false),
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

export async function setActiveModel(model: string): Promise<void> {
  if (profileStore) {
    const active = await profileStore.ensureSeeded();
    active.model = model;
    await profileStore.upsert(active);
    await profileStore.setActive(active.id);
    return;
  }
  await vscode.workspace
    .getConfiguration("forgeAgent")
    .update("model", model, vscode.ConfigurationTarget.Global);
}
