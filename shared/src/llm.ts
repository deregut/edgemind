// Unified LLM message format + stream events, shared by server (adapters, agent loop, DB `messages.parts`)
// and web (rendering). Every provider protocol is translated to/from these shapes.

/** Opaque provider round-trip data (Anthropic thinking signature, Gemini thoughtSignature, OpenAI Responses item ids …). */
export type ProviderMeta = Record<string, unknown>;

export type Part =
  | { type: "text"; text: string }
  /** Inline image (base64 `data`) or remote `url`. */
  | { type: "image"; mime: string; data?: string; url?: string }
  /**
   * File reference. `fileId` points at the `files` table; the agent loop may resolve it into `data`
   * (base64) or `text` (already-extracted text) before calling a provider.
   */
  | { type: "file"; fileId?: string; name: string; mime: string; data?: string; url?: string; text?: string }
  | { type: "tool_call"; id: string; name: string; args: unknown; providerMeta?: ProviderMeta }
  | { type: "tool_result"; callId: string; name: string; result: unknown; isError?: boolean }
  /** Model reasoning. `redacted` = Anthropic redacted_thinking data (no readable text). */
  | { type: "reasoning"; text: string; signature?: string; redacted?: string; providerMeta?: ProviderMeta };

export type Role = "system" | "user" | "assistant" | "tool";

export interface Message {
  role: Role;
  parts: Part[];
}

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema (object). */
  parameters: Record<string, unknown>;
}

export type ToolChoice = "auto" | "none" | "required" | { name: string };

export type ReasoningEffort = "minimal" | "low" | "medium" | "high";

export interface ChatRequest {
  model: string;
  system?: string;
  messages: Message[];
  tools?: ToolDef[];
  toolChoice?: ToolChoice;
  parallelToolCalls?: boolean;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
  /** Only applied when the model has the `reasoning` capability. */
  reasoning?: { effort?: ReasoningEffort; budgetTokens?: number };
}

/** Manually marked / detected capability flags (models.capabilities). Missing = sensible default. */
export interface ModelCapabilities {
  vision?: boolean;
  tools?: boolean;
  reasoning?: boolean;
  /** PDF / document input. */
  pdf?: boolean;
  parallelTools?: boolean;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
}

export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter" | "error" | "aborted" | "other";

export interface LlmErrorInfo {
  message: string;
  status?: number;
  code?: string;
  retryable?: boolean;
}

export type StreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  /** Closes the current reasoning block with its round-trip data. */
  | { type: "reasoning-end"; signature?: string; redacted?: string; providerMeta?: ProviderMeta }
  | { type: "tool-call-start"; id: string; name: string }
  | { type: "tool-call-delta"; id: string; argsDelta: string }
  | { type: "tool-call-end"; id: string; name: string; args: unknown; argsError?: string; providerMeta?: ProviderMeta }
  | { type: "usage"; usage: Usage }
  | { type: "finish"; reason: FinishReason; rawReason?: string }
  | { type: "error"; error: LlmErrorInfo };
