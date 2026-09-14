import * as vscode from "vscode";
import type { ForgeConfig, ProviderId } from "./types";
import { defaultBaseUrl } from "./providers";

export function readConfig(): ForgeConfig {
  const c = vscode.workspace.getConfiguration("forgeAgent");
  const provider = c.get<ProviderId>("provider", "openai");
  const configuredBase = (c.get<string>("baseUrl", "") || "").replace(/\/$/, "");
  return {
    provider,
    model: c.get<string>("model", "gpt-4o"),
    baseUrl: configuredBase || defaultBaseUrl(provider),
    tlsInsecure: c.get<boolean>("tlsInsecure", false),
    maxToolRounds: c.get<number>("maxToolRounds", 25),
    autoApproveReads: c.get<boolean>("autoApproveReads", true),
    requireApprovalForWrites: c.get<boolean>("requireApprovalForWrites", true),
    requireApprovalForTerminal: c.get<boolean>("requireApprovalForTerminal", true),
    systemPromptExtra: c.get<string>("systemPromptExtra", "") || "",
    temperature: c.get<number>("temperature", 0.2),
  };
}
