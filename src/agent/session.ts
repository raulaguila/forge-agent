import * as vscode from "vscode";
import type {
  AgentEvent,
  AutonomyMode,
  ChatMessage,
  DiffProposal,
  ForgeConfig,
  LlmProvider,
  ToolRisk,
} from "../types";
import {
  applyDiffProposal,
  buildEditProposal,
  buildWriteProposal,
  cleanupTemp,
  showDiffProposal,
} from "./diff";
import { createToolRegistry, toolDefinitions, type RegisteredTool } from "./tools";

export function buildSystemPrompt(config: ForgeConfig): string {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "(nenhum workspace)";
  const openFiles = vscode.window.visibleTextEditors
    .map((e) => vscode.workspace.asRelativePath(e.document.uri))
    .slice(0, 12);

  const modeHint =
    config.autonomy === "ask"
      ? "Modo ASK: apenas leitura. Não tente editar arquivos nem rodar terminal — explique o plano."
      : config.autonomy === "auto"
        ? "Modo AUTO: pode editar arquivos; ainda assim prefira apply_edit e valide com diagnostics."
        : "Modo AGENT: edições passam por diff/aprovação do usuário antes de gravar.";

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
    modeHint,
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
  diff?: DiffProposal;
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

  get autonomy(): AutonomyMode {
    return this.config.autonomy;
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
    if (this.messages.length === 1 && this.messages[0]?.role === "system") {
      this.messages[0] = { role: "system", content: buildSystemPrompt(config) };
    }
  }

  async run(userText: string): Promise<void> {
    this.stop();
    this.abort = new AbortController();
    const signal = this.abort.signal;

    this.messages.push({ role: "user", content: userText });
    this.onEvent({ type: "status", text: `Pensando… (${this.config.autonomy})` });

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
          await this.executeToolCall(call, signal);
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

  private async executeToolCall(
    call: { id: string; name: string; arguments: string },
    signal: AbortSignal
  ): Promise<void> {
    const tool = this.registry.get(call.name);
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
    } catch {
      args = { raw: call.arguments };
    }

    if (!tool) {
      await this.pushToolResult(call.id, call.name, `Tool desconhecida: ${call.name}`);
      return;
    }

    if (
      this.config.autonomy === "ask" &&
      (tool.risk === "write" || tool.risk === "terminal")
    ) {
      const denied = `Bloqueado no modo ask (${tool.risk}). Mude para agent/auto ou explique o plano sem executar.`;
      this.onEvent({
        type: "tool_request",
        toolName: call.name,
        toolCallId: call.id,
        args,
        requiresApproval: false,
      });
      await this.pushToolResult(call.id, call.name, denied);
      return;
    }

    if (tool.risk === "write" && (call.name === "write_file" || call.name === "apply_edit")) {
      await this.executeWriteWithDiff(call, args, tool.risk);
      return;
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
        await this.pushToolResult(call.id, call.name, "Usuário recusou a execução desta tool.");
        return;
      }
    }

    this.onEvent({ type: "status", text: `Executando ${call.name}…` });
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const result = await tool.run(args, { cwd: root, signal });
    await this.pushToolResult(
      call.id,
      call.name,
      result.ok ? result.output : `ERROR: ${result.output}`
    );
  }

  private async executeWriteWithDiff(
    call: { id: string; name: string; arguments: string },
    args: Record<string, unknown>,
    risk: ToolRisk
  ): Promise<void> {
    let proposal: DiffProposal;
    try {
      if (call.name === "write_file") {
        const filePath = String(args.path ?? "");
        const content = String(args.content ?? "");
        if (!filePath) {
          await this.pushToolResult(call.id, call.name, "ERROR: path é obrigatório");
          return;
        }
        proposal = await buildWriteProposal(filePath, content);
      } else {
        const built = await buildEditProposal({
          path: String(args.path ?? ""),
          old_text: String(args.old_text ?? ""),
          new_text: String(args.new_text ?? ""),
          replace_all: Boolean(args.replace_all),
        });
        if ("error" in built) {
          await this.pushToolResult(call.id, call.name, `ERROR: ${built.error}`);
          return;
        }
        proposal = built;
      }
    } catch (e) {
      await this.pushToolResult(
        call.id,
        call.name,
        `ERROR: ${e instanceof Error ? e.message : String(e)}`
      );
      return;
    }

    this.onEvent({
      type: "diff_proposal",
      toolName: call.name,
      toolCallId: call.id,
      args,
      diff: proposal,
      requiresApproval: this.config.autonomy !== "auto",
    });

    this.onEvent({
      type: "tool_request",
      toolName: call.name,
      toolCallId: call.id,
      args: {
        path: proposal.path,
        isNew: proposal.isNew,
        bytes: proposal.newContent.length,
      },
      requiresApproval: this.config.autonomy !== "auto",
      diff: proposal,
    });

    const needsApproval = this.needsApproval(risk);
    if (needsApproval) {
      try {
        await showDiffProposal(proposal);
      } catch {
        // best-effort
      }
      const ok = await this.approve({
        toolName: call.name,
        toolCallId: call.id,
        args,
        risk,
        diff: proposal,
      });
      if (!ok) {
        await cleanupTemp(proposal.path);
        await this.pushToolResult(call.id, call.name, "Usuário recusou o diff (não aplicado).");
        return;
      }
    }

    try {
      const output = await applyDiffProposal(proposal);
      await this.pushToolResult(call.id, call.name, output);
    } catch (e) {
      await this.pushToolResult(
        call.id,
        call.name,
        `ERROR: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  private async pushToolResult(
    toolCallId: string,
    toolName: string,
    output: string
  ): Promise<void> {
    this.messages.push({
      role: "tool",
      toolCallId,
      name: toolName,
      content: output,
    });
    this.onEvent({
      type: "tool_result",
      toolName,
      toolCallId,
      result: output,
    });
  }

  private needsApproval(risk: ToolRisk): boolean {
    const mode = this.config.autonomy;

    if (mode === "ask") {
      if (risk === "read") {
        return !this.config.autoApproveReads;
      }
      return true;
    }

    if (mode === "auto") {
      if (risk === "read" || risk === "write") {
        return false;
      }
      if (risk === "terminal") {
        return this.config.requireApprovalForTerminal;
      }
      return true;
    }

    // agent
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
