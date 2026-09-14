export type ProviderId = "openai" | "anthropic" | "openai-compatible";

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface StreamChunk {
  type: "text" | "tool_call_delta" | "tool_calls" | "done" | "error";
  text?: string;
  toolCalls?: ToolCall[];
  toolCallDelta?: { index: number; id?: string; name?: string; arguments?: string };
  error?: string;
}

export interface CompletionRequest {
  model: string;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  temperature: number;
  signal?: AbortSignal;
}

export interface LlmProvider {
  readonly id: ProviderId;
  complete(req: CompletionRequest): Promise<{
    message: ChatMessage;
    finishReason: "stop" | "tool_calls" | "length" | "error";
  }>;
}

export type ToolRisk = "read" | "write" | "terminal" | "network";

export interface ToolResult {
  ok: boolean;
  output: string;
}

export interface AgentEvent {
  type:
    | "status"
    | "assistant_delta"
    | "assistant_done"
    | "tool_request"
    | "tool_result"
    | "error"
    | "done";
  text?: string;
  toolName?: string;
  toolCallId?: string;
  args?: unknown;
  result?: string;
  requiresApproval?: boolean;
}

export interface ForgeConfig {
  provider: ProviderId;
  model: string;
  baseUrl: string;
  maxToolRounds: number;
  autoApproveReads: boolean;
  requireApprovalForWrites: boolean;
  requireApprovalForTerminal: boolean;
  systemPromptExtra: string;
  temperature: number;
}
