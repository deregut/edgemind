/**
 * OpenAI Chat Completions (and every OpenAI-compatible endpoint: OpenRouter, DeepSeek, Groq, Mistral, xAI,
 * Ollama, vLLM …). Reasoning deltas are read from `reasoning_content` (DeepSeek/vLLM) or `reasoning`
 * (OpenRouter/Groq); `reasoning_details` text entries are also accepted.
 */
import type { ChatRequest, FinishReason, Message, StreamEvent } from "../../../shared/src/index";
import type { SseEvent } from "./sse";
import { type Adapter, type HttpRequestSpec, type LlmConfig, parseArgs, resultToString, safeJson, trimSlash } from "./types";

function dataUrl(mime: string, data: string) {
  return `data:${mime};base64,${data}`;
}

function toOpenAIMessages(req: ChatRequest, cfg: LlmConfig): any[] {
  const out: any[] = [];
  if (req.system) out.push({ role: "system", content: req.system });
  for (const m of req.messages) out.push(...convert(m, cfg));
  return out;
}

function convert(m: Message, cfg: LlmConfig): any[] {
  if (m.role === "system") {
    return [{ role: "system", content: m.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n") }];
  }
  if (m.role === "tool") {
    return m.parts.flatMap((p) => (p.type === "tool_result" ? [{ role: "tool", tool_call_id: p.callId, content: resultToString(p.result) }] : []));
  }
  if (m.role === "assistant") {
    const text = m.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("");
    const calls = m.parts.flatMap((p) =>
      p.type === "tool_call" ? [{ id: p.id, type: "function", function: { name: p.name, arguments: JSON.stringify(p.args ?? {}) } }] : [],
    );
    const msg: any = { role: "assistant", content: text || (calls.length ? null : "") };
    if (calls.length) msg.tool_calls = calls;
    if (cfg.replayReasoningContent) {
      const r = m.parts.filter((p) => p.type === "reasoning").map((p) => (p as { text: string }).text).join("");
      if (r) msg.reasoning_content = r;
    }
    const results = m.parts.flatMap((p) => (p.type === "tool_result" ? [{ role: "tool", tool_call_id: p.callId, content: resultToString(p.result) }] : []));
    return [msg, ...results];
  }
  // user
  const content: any[] = [];
  const results: any[] = [];
  for (const p of m.parts) {
    if (p.type === "text") content.push({ type: "text", text: p.text });
    else if (p.type === "image") content.push({ type: "image_url", image_url: { url: p.url ?? dataUrl(p.mime, p.data ?? "") } });
    else if (p.type === "file" && p.data) content.push({ type: "file", file: { filename: p.name, file_data: dataUrl(p.mime, p.data) } });
    else if (p.type === "tool_result") results.push({ role: "tool", tool_call_id: p.callId, content: resultToString(p.result) });
  }
  const msgs: any[] = [...results];
  if (content.length) {
    const onlyText = content.every((c) => c.type === "text");
    msgs.push({ role: "user", content: onlyText ? content.map((c) => c.text).join("\n") : content });
  }
  return msgs;
}

export function buildChatBody(req: ChatRequest, cfg: LlmConfig): Record<string, unknown> {
  const isOpenAI = /(^|\.)openai\.com$/.test(safeHost(cfg.baseUrl));
  const body: Record<string, unknown> = { model: req.model, messages: toOpenAIMessages(req, cfg), stream: true };
  if (cfg.streamUsage !== false) body.stream_options = { include_usage: true };
  if (req.maxTokens) body[isOpenAI ? "max_completion_tokens" : "max_tokens"] = req.maxTokens;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.topP !== undefined) body.top_p = req.topP;
  if (req.stop?.length) body.stop = req.stop;
  if (req.reasoning?.effort) body.reasoning_effort = req.reasoning.effort;
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
    if (req.toolChoice) body.tool_choice = typeof req.toolChoice === "string" ? req.toolChoice : { type: "function", function: { name: req.toolChoice.name } };
    if (req.parallelToolCalls !== undefined) body.parallel_tool_calls = req.parallelToolCalls;
  }
  return body;
}

function safeHost(u: string) {
  try {
    return new URL(u).hostname;
  } catch {
    return "";
  }
}

export function mapChatFinish(r: string | null | undefined): FinishReason {
  switch (r) {
    case "stop":
    case "end_turn":
      return "stop";
    case "length":
    case "max_tokens":
      return "length";
    case "tool_calls":
    case "function_call":
      return "tool_calls";
    case "content_filter":
      return "content_filter";
    default:
      return "other";
  }
}

export const openaiChatAdapter: Adapter = {
  build(req, cfg): HttpRequestSpec {
    return {
      url: `${trimSlash(cfg.baseUrl)}/chat/completions`,
      headers: { ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}), accept: "text/event-stream", ...cfg.headers },
      body: buildChatBody(req, cfg),
    };
  },

  async *parse(events: AsyncIterable<SseEvent>): AsyncGenerator<StreamEvent> {
    // Tool calls are keyed by `index` (fallback: id, then arrival order).
    const calls = new Map<number, { id: string; name: string; args: string; started: boolean }>();
    let finish: string | null | undefined;
    let sawContent = false;
    let usageSent = false;
    let inReasoning = false;

    const endReasoning = function* (): Generator<StreamEvent> {
      if (inReasoning) {
        inReasoning = false;
        yield { type: "reasoning-end", providerMeta: { protocol: "openai" } };
      }
    };

    for await (const ev of events) {
      if (ev.data === "[DONE]") break;
      const j = safeJson(ev.data);
      if (!j) continue;
      if (j.error) {
        yield* endReasoning();
        yield { type: "error", error: { message: String(j.error.message ?? JSON.stringify(j.error)), code: j.error.code ? String(j.error.code) : j.error.type, retryable: false } };
        return;
      }
      if (j.usage && (j.usage.prompt_tokens !== undefined || j.usage.completion_tokens !== undefined)) {
        usageSent = true;
        yield {
          type: "usage",
          usage: {
            inputTokens: j.usage.prompt_tokens ?? 0,
            outputTokens: j.usage.completion_tokens ?? 0,
            cachedInputTokens: j.usage.prompt_tokens_details?.cached_tokens ?? j.usage.prompt_cache_hit_tokens ?? undefined,
            reasoningTokens: j.usage.completion_tokens_details?.reasoning_tokens ?? undefined,
          },
        };
      }
      const choice = j.choices?.[0];
      if (!choice) continue;
      const d = choice.delta ?? choice.message ?? {};
      const reasoning: string | undefined =
        (typeof d.reasoning_content === "string" && d.reasoning_content) ||
        (typeof d.reasoning === "string" && d.reasoning) ||
        (Array.isArray(d.reasoning_details) ? d.reasoning_details.map((x: any) => x?.text ?? x?.summary ?? "").join("") : "") ||
        undefined;
      if (reasoning) {
        inReasoning = true;
        yield { type: "reasoning-delta", text: reasoning };
      }
      if (typeof d.content === "string" && d.content) {
        yield* endReasoning();
        sawContent = true;
        yield { type: "text-delta", text: d.content };
      }
      if (Array.isArray(d.tool_calls)) {
        yield* endReasoning();
        for (const tc of d.tool_calls) {
          let idx: number = typeof tc.index === "number" ? tc.index : -1;
          if (idx < 0) {
            const byId = [...calls.entries()].find(([, c]) => tc.id && c.id === tc.id);
            idx = byId ? byId[0] : calls.size;
          }
          let c = calls.get(idx);
          if (!c) {
            c = { id: tc.id ?? `call_${idx}_${Math.random().toString(36).slice(2, 8)}`, name: "", args: "", started: false };
            calls.set(idx, c);
          }
          if (tc.id && !c.started) c.id = tc.id;
          if (tc.function?.name) c.name += c.started ? "" : tc.function.name;
          if (!c.started && c.name) {
            c.started = true;
            yield { type: "tool-call-start", id: c.id, name: c.name };
          }
          const a = tc.function?.arguments;
          if (a !== undefined && a !== null) {
            const s = typeof a === "string" ? a : JSON.stringify(a);
            c.args += s;
            if (c.started && s) yield { type: "tool-call-delta", id: c.id, argsDelta: s };
          }
        }
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
    yield* endReasoning();
    for (const [, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
      if (!c.started) yield { type: "tool-call-start", id: c.id, name: c.name };
      const { args, argsError } = parseArgs(c.args);
      yield { type: "tool-call-end", id: c.id, name: c.name, args, ...(argsError ? { argsError } : {}) };
    }
    if (!finish && !sawContent && !calls.size && !usageSent) {
      yield { type: "error", error: { message: "串流意外結束（沒有收到任何內容）", code: "incomplete_stream", retryable: true } };
      return;
    }
    let reason = mapChatFinish(finish ?? "stop");
    if (calls.size && (reason === "stop" || reason === "other")) reason = "tool_calls";
    yield { type: "finish", reason, rawReason: finish ?? undefined };
  },
};
