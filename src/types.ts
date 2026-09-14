export type ProviderId =
  | "openai"
  | "openai-compatible"
  | "ollama"
  | "anthropic"
  | "gemini";

/** ask = só leitura; plan = lê e propõe plano; agent = writes via diff+approve; auto = aplica writes */
export type AutonomyMode = "ask" | "plan" | "agent" | "auto";

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
  /** Called with incremental assistant text when provider streams. */
  onDelta?: (text: string) => void;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd?: number;
}

export interface LlmProvider {
  readonly id: ProviderId;
  complete(req: CompletionRequest): Promise<{
    message: ChatMessage;
    finishReason: "stop" | "tool_calls" | "length" | "error";
    usage?: TokenUsage;
  }>;
}

export type ToolRisk = "read" | "write" | "terminal" | "network";

export interface ToolResult {
  ok: boolean;
  output: string;
}

export interface DiffProposal {
  path: string;
  isNew: boolean;
  oldContent: string;
  newContent: string;
}

export interface AgentEvent {
  type:
    | "status"
    | "assistant_delta"
    | "assistant_done"
    | "tool_request"
    | "tool_result"
    | "diff_proposal"
    | "plan_ready"
    | "usage"
    | "error"
    | "done";
  text?: string;
  toolName?: string;
  toolCallId?: string;
  args?: unknown;
  result?: string;
  requiresApproval?: boolean;
  diff?: DiffProposal;
  usage?: TokenUsage;
  plan?: string;
}

export interface ProviderProfile {
  id: string;
  name: string;
  provider: ProviderId;
  model: string;
  baseUrl: string;
  tlsInsecure: boolean;
}

export interface ForgeConfig {
  provider: ProviderId;
  model: string;
  baseUrl: string;
  tlsInsecure: boolean;
  maxToolRounds: number;
  autonomy: AutonomyMode;
  autoApproveReads: boolean;
  requireApprovalForWrites: boolean;
  requireApprovalForTerminal: boolean;
  systemPromptExtra: string;
  temperature: number;
  /** Active named profile, when profiles are configured. */
  profileId?: string;
  profileName?: string;
}
