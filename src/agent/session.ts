import * as vscode from "vscode";
import type { AgentEvent, ChatMessage, ForgeConfig, LlmProvider } from "../types";
import { createToolRegistry, toolDefinitions, type RegisteredTool } from "./tools";

export function buildSystemPrompt(config: ForgeConfig): string {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "(nenhum workspace)";
  const openFiles = vscode.window.visibleTextEditors
    .map((e) => vscode.workspace.asRelativePath(e.document.uri))
    .slice(0, 12);

  return [
    "Você é o Forge Agent — um coding agent autônomo dentro do VS Code.",
    "Objetivo: implementar, depurar e refatorar código no workspace do usuário com precisão.",
    "",
    "Regras:",
    "- Use tools para inspecionar o código antes de editar.",
    "- Prefira apply_edit a write_file para mudanças locais.",
    "- Mantenha diffs mínimos e alinhados ao estilo do projeto.",
    "- Não invente APIs; confirme no código.",
    "- Após edições relevantes, use get_diagnostics e/ou run_terminal (testes/build) quando fizer sentido.",
    "- Responda em português do Brasil, a menos que o usuário peça outro idioma.",
    "- Seja direto: diga o que fez e o que falta, sem enrolação.",
    "",
    `Workspace root: ${root}`,
    openFiles.length ? `Editores abertos: ${openFiles.join(", ")}` : "Nenhum editor aberto.",
    config.systemPromptExtra ? `\nInstruções extras do usuário:\n${config.systemPromptExtra}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export type ApprovalHandler = (req: {
  toolName: string;
  toolCallId: string;
  args: unknown;
  risk: string;
}) => Promise<boolean>;

export class AgentSession {
  private messages: ChatMessage[] = [];
  private registry: Map<string, RegisteredTool>;
  private abort?: AbortController;

  constructor(
    private provider: LlmProvider,
    private config: ForgeConfig,
    private onEvent: (e: AgentEvent) => void,
    private approve: ApprovalHandler
  ) {
    this.registry = createToolRegistry();
    this.messages.push({ role: "system", content: buildSystemPrompt(config) });
  }

  get history(): ChatMessage[] {
    return this.messages.filter((m) => m.role !== "system");
  }

  clear(): void {
    this.stop();
    this.messages = [{ role: "system", content: buildSystemPrompt(this.config) }];
  }

  stop(): void {
    this.abort?.abort();
    this.abort = undefined;
  }

  updateProvider(provider: LlmProvider, config: ForgeConfig): void {
    this.provider = provider;
    this.config = config;
  }

  async run(userText: string): Promise<void> {
    this.stop();
    this.abort = new AbortController();
    const signal = this.abort.signal;

    this.messages.push({ role: "user", content: userText });
    this.onEvent({ type: "status", text: "Pensando…" });

    try {
      for (let round = 0; round < this.config.maxToolRounds; round++) {
        if (signal.aborted) {
          this.onEvent({ type: "error", text: "Interrompido." });
          return;
        }

        const { message, finishReason } = await this.provider.complete({
          model: this.config.model,
          messages: this.messages,
          tools: toolDefinitions(this.registry),
          temperature: this.config.temperature,
          signal,
        });

        this.messages.push(message);

        if (message.content) {
          this.onEvent({ type: "assistant_delta", text: message.content });
          this.onEvent({ type: "assistant_done", text: message.content });
        }

        if (finishReason !== "tool_calls" || !message.toolCalls?.length) {
          this.onEvent({ type: "done" });
          return;
        }

        for (const call of message.toolCalls) {
          if (signal.aborted) {
            this.onEvent({ type: "error", text: "Interrompido." });
            return;
          }

          const tool = this.registry.get(call.name);
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
          } catch {
            args = { raw: call.arguments };
          }

          if (!tool) {
            const output = `Tool desconhecida: ${call.name}`;
            this.messages.push({
              role: "tool",
              toolCallId: call.id,
              name: call.name,
              content: output,
            });
            this.onEvent({
              type: "tool_result",
              toolName: call.name,
              toolCallId: call.id,
              result: output,
            });
            continue;
          }

          const needsApproval = this.needsApproval(tool.risk);
          this.onEvent({
            type: "tool_request",
            toolName: call.name,
            toolCallId: call.id,
            args,
            requiresApproval: needsApproval,
          });

          if (needsApproval) {
            const ok = await this.approve({
              toolName: call.name,
              toolCallId: call.id,
              args,
              risk: tool.risk,
            });
            if (!ok) {
              const denied = "Usuário recusou a execução desta tool.";
              this.messages.push({
                role: "tool",
                toolCallId: call.id,
                name: call.name,
                content: denied,
              });
              this.onEvent({
                type: "tool_result",
                toolName: call.name,
                toolCallId: call.id,
                result: denied,
              });
              continue;
            }
          }

          this.onEvent({ type: "status", text: `Executando ${call.name}…` });
          const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
          const result = await tool.run(args, { cwd: root, signal });
          const output = result.ok ? result.output : `ERROR: ${result.output}`;

          this.messages.push({
            role: "tool",
            toolCallId: call.id,
            name: call.name,
            content: output,
          });
          this.onEvent({
            type: "tool_result",
            toolName: call.name,
            toolCallId: call.id,
            result: output,
          });
        }
      }

      this.onEvent({
        type: "error",
        text: `Limite de ${this.config.maxToolRounds} rounds de tools atingido.`,
      });
      this.onEvent({ type: "done" });
    } catch (e) {
      if (signal.aborted) {
        this.onEvent({ type: "error", text: "Interrompido." });
      } else {
        this.onEvent({
          type: "error",
          text: e instanceof Error ? e.message : String(e),
        });
      }
      this.onEvent({ type: "done" });
    }
  }

  private needsApproval(risk: string): boolean {
    if (risk === "read") {
      return !this.config.autoApproveReads;
    }
    if (risk === "write") {
      return this.config.requireApprovalForWrites;
    }
    if (risk === "terminal") {
      return this.config.requireApprovalForTerminal;
    }
    return true;
  }
}
