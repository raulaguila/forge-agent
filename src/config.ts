import * as vscode from "vscode";
import type { ForgeConfig, ProviderId } from "./types";

export function readConfig(): ForgeConfig {
  const c = vscode.workspace.getConfiguration("forgeAgent");
  return {
    provider: c.get<ProviderId>("provider", "openai"),
    model: c.get<string>("model", "gpt-4o"),
    baseUrl: (c.get<string>("baseUrl", "") || "").replace(/\/$/, ""),
    maxToolRounds: c.get<number>("maxToolRounds", 25),
    autoApproveReads: c.get<boolean>("autoApproveReads", true),
    requireApprovalForWrites: c.get<boolean>("requireApprovalForWrites", true),
    requireApprovalForTerminal: c.get<boolean>("requireApprovalForTerminal", true),
    systemPromptExtra: c.get<string>("systemPromptExtra", "") || "",
    temperature: c.get<number>("temperature", 0.2),
  };
}
