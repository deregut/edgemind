/**
 * Anthropic Messages API: extended thinking (signatures + redacted_thinking round-trip), tool_use / tool_result,
 * image + PDF input. Consecutive same-role turns are merged (the API requires alternation).
 */
import type { ChatRequest, FinishReason, Part, StreamEvent } from "@edgemind/shared";
import { effortBudget } from "./prepare";
import type { SseEvent } from "./sse";
import { type Adapter, type HttpRequestSpec, parseArgs, resultToString, safeJson, trimSlash } from "./types";

export const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 8192;

function toolResultContent(p: Extract<Part, { type: "tool_result" }>): unknown {
  // Allow tools to return Anthropic-native content blocks, e.g. images: { content: [{type:"image",...}] }
  const r = p.result as any;
  if (r && typeof r === "object" && Array.isArray(r.__blocks)) return r.__blocks;
  return resultToString(p.result);
}

function blocksFor(p: Part): any[] {
  switch (p.type) {
    case "text":
      return p.text ? [{ type: "text", text: p.text }] : [];
    case "image":
      return [p.url ? { type: "image", source: { type: "url", url: p.url } } : { type: "image", source: { type: "base64", media_type: p.mime, data: p.data ?? "" } }];
    case "file":
      if (p.mime === "application/pdf" && p.data) return [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: p.data }, title: p.name }];
      return [];
    case "tool_call":
      return [{ type: "tool_use", id: p.id, name: p.name, input: p.args ?? {} }];
    case "tool_result":
      return [{ type: "tool_result", tool_use_id: p.callId, content: toolResultContent(p), ...(p.isError ? { is_error: true } : {}) }];
    case "reasoning":
      if (p.redacted) return [{ type: "redacted_thinking", data: p.redacted }];
      if (p.signature) return [{ type: "thinking", thinking: p.text, signature: p.signature }];
      return []; // unsigned thinking can't be replayed
  }
}

export function buildAnthropicBody(req: ChatRequest): Record<string, unknown> {
  const msgs: { role: "user" | "assistant"; content: any[] }[] = [];
  const systemExtra: string[] = [];
  for (const m of req.messages) {
    if (m.role === "system") {
      systemExtra.push(m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n"));
      continue;
    }
    // tool_result blocks must live in a user turn; tool_use in assistant.
    const assistantBlocks: any[] = [];
    const userBlocks: any[] = [];
    for (const p of m.parts) {
      const blocks = blocksFor(p);
      if (m.role === "assistant" && p.type !== "tool_result") assistantBlocks.push(...blocks);
      else userBlocks.push(...blocks);
    }
    const push = (role: "user" | "assistant", content: any[]) => {
      if (!content.length) return;
      const last = msgs[msgs.length - 1];
      if (last && last.role === role) {
        // tool_result blocks must come first in a user message
        if (role === "user") {
          const tr = [...last.content, ...content].filter((b) => b.type === "tool_result");
          const rest = [...last.content, ...content].filter((b) => b.type !== "tool_result");
          last.content = [...tr, ...rest];
        } else last.content.push(...content);
      } else msgs.push({ role, content });
    };
    push("assistant", assistantBlocks);
    push("user", userBlocks);
  }
  const system = [req.system, ...systemExtra].filter(Boolean).join("\n\n");
  let maxTokens = req.maxTokens ?? DEFAULT_MAX_TOKENS;
  const body: Record<string, unknown> = { model: req.model, messages: msgs, stream: true };
  if (system) body.system = system;
  if (req.reasoning) {
    const budget = Math.max(1024, effortBudget(req.reasoning.effort, req.reasoning.budgetTokens));
    if (maxTokens <= budget) maxTokens = budget + 4096;
    body.thinking = { type: "enabled", budget_tokens: budget };
  } else {
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.topP !== undefined) body.top_p = req.topP;
  }
  body.max_tokens = maxTokens;
  if (req.stop?.length) body.stop_sequences = req.stop;
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    const tc = req.toolChoice;
    let choice: any;
    if (tc === "required") choice = { type: "any" };
    else if (tc === "none") choice = { type: "none" };
    else if (tc && typeof tc === "object") choice = { type: "tool", name: tc.name };
    else if (req.parallelToolCalls === false) choice = { type: "auto" };
    if (choice && req.parallelToolCalls === false && choice.type !== "none") choice.disable_parallel_tool_use = true;
    if (choice) body.tool_choice = choice;
  }
  return body;
}

function mapStop(r: string | undefined): FinishReason {
  switch (r) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "length";
    case "refusal":
      return "content_filter";
    default:
      return "other";
  }
}

export const anthropicAdapter: Adapter = {
  build(req, cfg): HttpRequestSpec {
    const root = trimSlash(cfg.baseUrl).replace(/\/v1$/, "");
    return {
      url: `${root}/v1/messages`,
      headers: { "x-api-key": cfg.apiKey ?? "", "anthropic-version": ANTHROPIC_VERSION, accept: "text/event-stream", ...cfg.headers },
      body: buildAnthropicBody(req),
    };
  },

  async *parse(events: AsyncIterable<SseEvent>): AsyncGenerator<StreamEvent> {
    const blocks = new Map<number, { type: string; id?: string; name?: string; json: string; signature?: string; data?: string }>();
    let input = 0;
    let cached = 0;
    let output = 0;
    let stop: string | undefined;
    for await (const ev of events) {
      const j = safeJson(ev.data);
      if (!j) continue;
      const type: string = j.type ?? ev.event;
      switch (type) {
        case "message_start": {
          const u = j.message?.usage ?? {};
          cached = u.cache_read_input_tokens ?? 0;
          input = (u.input_tokens ?? 0) + cached + (u.cache_creation_input_tokens ?? 0);
          output = u.output_tokens ?? 0;
          break;
        }
        case "content_block_start": {
          const b = j.content_block ?? {};
          blocks.set(j.index, { type: b.type, id: b.id, name: b.name, json: "", data: b.data, signature: b.signature });
          if (b.type === "tool_use") yield { type: "tool-call-start", id: b.id, name: b.name };
          else if (b.type === "thinking" && b.thinking) yield { type: "reasoning-delta", text: b.thinking };
          else if (b.type === "text" && b.text) yield { type: "text-delta", text: b.text };
          break;
        }
        case "content_block_delta": {
          const b = blocks.get(j.index);
          const d = j.delta ?? {};
          if (d.type === "text_delta") yield { type: "text-delta", text: d.text };
          else if (d.type === "thinking_delta") yield { type: "reasoning-delta", text: d.thinking };
          else if (d.type === "signature_delta" && b) b.signature = (b.signature ?? "") + d.signature;
          else if (d.type === "input_json_delta" && b) {
            b.json += d.partial_json ?? "";
            if (d.partial_json) yield { type: "tool-call-delta", id: b.id!, argsDelta: d.partial_json };
          }
          break;
        }
        case "content_block_stop": {
          const b = blocks.get(j.index);
          if (!b) break;
          if (b.type === "tool_use") {
            const { args, argsError } = parseArgs(b.json);
            yield { type: "tool-call-end", id: b.id!, name: b.name!, args, ...(argsError ? { argsError } : {}) };
          } else if (b.type === "thinking") {
            yield { type: "reasoning-end", signature: b.signature, providerMeta: { protocol: "anthropic" } };
          } else if (b.type === "redacted_thinking") {
            yield { type: "reasoning-end", redacted: b.data, providerMeta: { protocol: "anthropic" } };
          }
          break;
        }
        case "message_delta":
          if (j.delta?.stop_reason) stop = j.delta.stop_reason;
          if (j.usage?.output_tokens !== undefined) output = j.usage.output_tokens;
          if (j.usage?.input_tokens !== undefined) {
            // newer API versions repeat cumulative input usage here
            cached = j.usage.cache_read_input_tokens ?? cached;
            input = j.usage.input_tokens + cached + (j.usage.cache_creation_input_tokens ?? 0);
          }
          break;
        case "message_stop":
          yield { type: "usage", usage: { inputTokens: input, outputTokens: output, cachedInputTokens: cached || undefined } };
          yield { type: "finish", reason: mapStop(stop), rawReason: stop };
          return;
        case "error": {
          const e = j.error ?? {};
          const retryable = e.type === "overloaded_error" || e.type === "api_error" || e.type === "rate_limit_error";
          yield { type: "error", error: { message: String(e.message ?? "未知錯誤"), code: e.type, retryable } };
          return;
        }
        default:
          break; // ping etc.
      }
    }
    yield { type: "error", error: { message: "串流意外結束（未收到 message_stop）", code: "incomplete_stream", retryable: true } };
  },
};
