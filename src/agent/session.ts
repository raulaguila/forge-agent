import * as vscode from "vscode";
import type {
  AgentEvent,
  AutonomyMode,
  ChatMessage,
  DiffProposal,
  ForgeConfig,
  LlmProvider,
  ToolDefinition,
  ToolRisk,
} from "../types";
import {
  applyDiffProposal,
  buildEditProposal,
  buildWriteProposal,
  cleanupTemp,
  showDiffProposal,
} from "./diff";
import { CheckpointStore } from "./checkpoints";
import { createToolRegistry, toolDefinitions, type RegisteredTool } from "./tools";
import {
  previewToolOutput,
  sanitizeArgsForUi,
  summarizeToolRequest,
  summarizeToolResult,
} from "./toolSummary";
import { loadProjectRules } from "./rules";
import { activeFileRelativePath, listOpenEditorInfos } from "./editorContext";
import { getPrimaryWorkspaceRoot } from "./workspacePath";

export async function buildSystemPrompt(config: ForgeConfig): Promise<string> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "(nenhum workspace)";
  const openFiles = listOpenEditorInfos();
  const activePath = activeFileRelativePath();

  const modeHint =
    config.autonomy === "ask"
      ? "Modo ASK: responda perguntas sobre o repositório usando tools de leitura (read_file, list_dir, search, diagnostics, get_open_editors, etc.). NÃO edite arquivos nem rode terminal."
      : config.autonomy === "plan"
        ? "Modo PLAN: apenas leitura. Investigue o código com tools de leitura e entregue um plano Markdown detalhado (objetivo, passos, arquivos a tocar, riscos). NÃO edite arquivos nem rode terminal."
        : config.autonomy === "auto"
          ? "Modo AUTO: pode editar arquivos; ainda assim prefira apply_edit e valide com diagnostics."
          : "Modo AGENT: edições passam por diff/aprovação do usuário antes de gravar.";
  const rules = await loadProjectRules();

  const openLine = openFiles.length
    ? `Editores abertos: ${openFiles
        .map((e) => (e.active ? `${e.path} (ativo)` : e.path))
        .join(", ")}`
    : "Nenhum editor de código aberto.";

  return [
    "Você é o Forge Agent — um coding agent autônomo dentro do VS Code.",
    "Objetivo: implementar, depurar e refatorar código no workspace do usuário com precisão.",
    "",
    "Regras:",
    "- Use tools para inspecionar o código antes de editar.",
    "- Quando o usuário falar em “arquivo aberto/atual/este arquivo”, use o Arquivo ativo abaixo (ou get_open_editors / read_file).",
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
    activePath ? `Arquivo ativo: ${activePath}` : "Arquivo ativo: (nenhum)",
    openLine,
    config.systemPromptExtra ? `\nInstruções extras do usuário:\n${config.systemPromptExtra}` : "",
    rules ? `\n## Regras do projeto\n${rules}` : "",
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
  readonly checkpoints = new CheckpointStore();

  constructor(
    private provider: LlmProvider,
    private config: ForgeConfig,
    private onEvent: (e: AgentEvent) => void,
    private approve: ApprovalHandler
  ) {
    this.registry = createToolRegistry();
    this.messages.push({ role: "system", content: "Forge Agent" });
  }

  get history(): ChatMessage[] {
    return this.messages.filter((m) => m.role !== "system");
  }

  private async refreshSystemPrompt(): Promise<void> {
    const content = await buildSystemPrompt(this.config);
    if (this.messages[0]?.role === "system") {
      this.messages[0] = { role: "system", content };
    } else {
      this.messages.unshift({ role: "system", content });
    }
  }

  /** Drop/truncate old turns so long chats stay within a soft context budget. */
  private compactMessages(): void {
    const MAX_CHARS = 120_000;
    const KEEP_RECENT = 40;
    if (this.messages.length <= 2) return;

    const system = this.messages[0]?.role === "system" ? [this.messages[0]] : [];
    let rest = this.messages.slice(system.length);

    if (rest.length > KEEP_RECENT) {
      rest = rest.slice(-KEEP_RECENT);
    }

    const total = () =>
      [...system, ...rest].reduce((n, m) => n + (m.content?.length ?? 0), 0);

    if (total() > MAX_CHARS) {
      rest = rest.map((m, idx) => {
        if (idx >= rest.length - 8) return m;
        if (m.role !== "tool" && m.role !== "assistant") return m;
        if ((m.content?.length ?? 0) <= 500) return m;
        return {
          ...m,
          content: `${m.content.slice(0, 500)}\n…[truncated for context]`,
        };
      });
    }

    while (total() > MAX_CHARS && rest.length > 6) {
      rest.shift();
    }

    this.messages = [...system, ...rest];
  }

  loadMessages(messages: ChatMessage[]): void {
    this.stop();
    this.messages = [
      { role: "system", content: "Forge Agent" },
      ...messages.filter((m) => m.role !== "system"),
    ];
    void this.refreshSystemPrompt();
  }

  get autonomy(): AutonomyMode {
    return this.config.autonomy;
  }

  clear(): void {
    this.stop();
    this.messages = [{ role: "system", content: "Forge Agent" }];
    void this.refreshSystemPrompt();
  }

  stop(): void {
    this.abort?.abort();
    this.abort = undefined;
  }

  updateProvider(provider: LlmProvider, config: ForgeConfig): void {
    this.provider = provider;
    this.config = config;
    void this.refreshSystemPrompt();
  }

  async run(userText: string): Promise<void> {
    this.stop();
    this.abort = new AbortController();
    const signal = this.abort.signal;
    await this.refreshSystemPrompt();

    this.messages.push({ role: "user", content: userText });
    this.compactMessages();
    this.onEvent({ type: "status", text: `Pensando… (${this.config.autonomy})` });

    try {
      for (let round = 0; round < this.config.maxToolRounds; round++) {
        if (signal.aborted) {
          this.onEvent({ type: "error", text: "Interrompido." });
          return;
        }

        this.compactMessages();

        const { message, finishReason, usage } = await this.provider.complete({
          model: this.config.model,
          messages: this.messages,
          tools: this.toolsForMode(),
          temperature: this.config.temperature,
          signal,
          onDelta: (text) => {
            this.onEvent({ type: "assistant_delta", text });
          },
        });

        this.messages.push(message);

        if (message.content) {
          this.onEvent({ type: "assistant_done", text: message.content });
        }
        if (usage) {
          this.onEvent({ type: "usage", usage });
        }

        if (finishReason !== "tool_calls" || !message.toolCalls?.length) {
          if (this.config.autonomy === "plan" && (message.content || "").trim()) {
            await this.publishPlan(message.content);
          }
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
      this.config.autonomy === "ask" ||
      this.config.autonomy === "plan"
    ) {
      if (tool.risk === "write" || tool.risk === "terminal") {
        const denied = `Bloqueado no modo ${this.config.autonomy} (${tool.risk}).`;
        this.emitToolRequest(call.id, call.name, args, false);
        await this.pushToolResult(call.id, call.name, denied);
        return;
      }
    }

    if (tool.risk === "write" && (call.name === "write_file" || call.name === "apply_edit")) {
      await this.executeWriteWithDiff(call, args, tool.risk);
      return;
    }

    const needsApproval = this.needsApproval(tool.risk);
    this.emitToolRequest(call.id, call.name, args, needsApproval);

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

    let root: string;
    try {
      root = getPrimaryWorkspaceRoot();
    } catch (e) {
      await this.pushToolResult(
        call.id,
        call.name,
        `ERROR: ${e instanceof Error ? e.message : String(e)}`
      );
      return;
    }
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
      summary: summarizeToolRequest(call.name, { path: proposal.path }),
      args: {
        path: proposal.path,
        isNew: proposal.isNew,
        bytes: proposal.newContent.length,
      },
      diff: proposal,
      requiresApproval: this.config.autonomy !== "auto",
    });

    this.emitToolRequest(
      call.id,
      call.name,
      {
        path: proposal.path,
        isNew: proposal.isNew,
        bytes: proposal.newContent.length,
      },
      this.config.autonomy !== "auto"
    );

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
      await this.checkpoints.snapshotBeforeWrite(
        proposal.path,
        `${call.name} ${proposal.path}`
      );
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

  private async publishPlan(planMarkdown: string): Promise<void> {
    try {
      const doc = await vscode.workspace.openTextDocument({
        language: "markdown",
        content: `# Forge Agent — Plano\n\n${planMarkdown}\n`,
      });
      await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
    } catch {
      // best-effort
    }
    this.onEvent({ type: "plan_ready", plan: planMarkdown, text: planMarkdown });
  }

  private emitToolRequest(
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
    requiresApproval: boolean
  ): void {
    this.onEvent({
      type: "tool_request",
      toolName,
      toolCallId,
      args: sanitizeArgsForUi(args),
      summary: summarizeToolRequest(toolName, args),
      requiresApproval,
    });
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
    const ok =
      !/^ERROR:/i.test(output) &&
      !/^Usuário recusou/i.test(output) &&
      !/^Bloqueado no modo/i.test(output) &&
      !/^Tool desconhecida:/i.test(output);
    this.onEvent({
      type: "tool_result",
      toolName,
      toolCallId,
      ok,
      summary: summarizeToolResult(toolName, output),
      preview: previewToolOutput(output),
    });
  }

  /** Ask/Plan: só tools de leitura; Agent/Auto: todas. */
  private toolsForMode(): ToolDefinition[] {
    if (this.config.autonomy === "ask" || this.config.autonomy === "plan") {
      return toolDefinitions(this.registry, { risks: ["read"] });
    }
    return toolDefinitions(this.registry);
  }

  private needsApproval(risk: ToolRisk): boolean {
    const mode = this.config.autonomy;

    if (mode === "ask" || mode === "plan") {
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
