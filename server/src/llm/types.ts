import type { ChatRequest, LlmProtocol, ModelCapabilities, StreamEvent } from "../../../shared/src/index";
import type { Fetch, RetryOptions } from "./http";
import type { SseEvent } from "./sse";

export interface LlmConfig {
  protocol: LlmProtocol;
  baseUrl: string;
  apiKey: string | null;
  /** Per-provider extra headers (OpenRouter HTTP-Referer, custom gateways, beta flags …). */
  headers?: Record<string, string>;
  /** OpenAI-compatible only: which API to call. Default "chat". */
  openaiApi?: "chat" | "responses";
  capabilities?: ModelCapabilities;
  /** OpenAI chat only: send `stream_options.include_usage` (default true; some gateways reject it). */
  streamUsage?: boolean;
  /** OpenAI chat only: echo `reasoning_content` back on assistant turns (DeepSeek thinking + tools). Default false. */
  replayReasoningContent?: boolean;
  fetch?: Fetch;
  retry?: RetryOptions;
}

export interface HttpRequestSpec {
  url: string;
  headers: Record<string, string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: Record<string, any>;
}

export interface Adapter {
  /** Translate the unified request to the provider wire format. `req` is already capability-normalized. */
  build(req: ChatRequest, cfg: LlmConfig): HttpRequestSpec;
  /** Translate the provider SSE stream to unified events. Must yield a terminal `finish` (or `error`). */
  parse(events: AsyncIterable<SseEvent>): AsyncGenerator<StreamEvent>;
}

export function trimSlash(u: string) {
  return u.replace(/\/+$/, "");
}

/** Parse tool-call argument JSON; empty string = {}. */
export function parseArgs(raw: string): { args: unknown; argsError?: string } {
  const s = raw.trim();
  if (!s) return { args: {} };
  try {
    return { args: JSON.parse(s) };
  } catch (e) {
    return { args: {}, argsError: `工具參數不是有效的 JSON：${(e as Error).message}（原文：${s.slice(0, 200)}）` };
  }
}

/** Stringify a tool result for providers that only take strings. */
export function resultToString(result: unknown): string {
  if (typeof result === "string") return result;
  if (result === undefined) return "";
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

export function safeJson(data: string): any {
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}
