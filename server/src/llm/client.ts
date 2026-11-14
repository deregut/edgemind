/**
 * Entry point of the LLM layer. `streamChat` never throws: every failure (HTTP, network, abort, malformed
 * stream) ends the stream with an `error` event; success ends with `finish`.
 */
import type { ChatRequest, FinishReason, LlmErrorInfo, Message, Part, StreamEvent, Usage } from "@edgemind/shared";
import { anthropicAdapter } from "./anthropic";
import { geminiAdapter } from "./gemini";
import { LlmError, abortError, isAbort, postWithRetry, scrub } from "./http";
import { openaiChatAdapter } from "./openai-chat";
import { openaiResponsesAdapter } from "./openai-responses";
import { prepareRequest } from "./prepare";
import { parseSse } from "./sse";
import type { Adapter, LlmConfig } from "./types";

export function adapterFor(cfg: LlmConfig): Adapter {
  switch (cfg.protocol) {
    case "anthropic":
      return anthropicAdapter;
    case "gemini":
      return geminiAdapter;
    case "openai":
      return cfg.openaiApi === "responses" ? openaiResponsesAdapter : openaiChatAdapter;
    default:
      throw new LlmError({ message: `不支援的協定：${String(cfg.protocol)}` });
  }
}

/** Builds the wire request without sending it (debugging / tests). */
export function buildHttpRequest(cfg: LlmConfig, req: ChatRequest) {
  return adapterFor(cfg).build(prepareRequest(req, cfg.capabilities ?? {}, cfg.protocol), cfg);
}

export async function* streamChat(cfg: LlmConfig, req: ChatRequest, opts: { signal?: AbortSignal } = {}): AsyncGenerator<StreamEvent> {
  const signal = opts.signal;
  const secrets = [cfg.apiKey];
  let terminal = false;
  try {
    const adapter = adapterFor(cfg);
    const spec = adapter.build(prepareRequest(req, cfg.capabilities ?? {}, cfg.protocol), cfg);
    const f = cfg.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    const res = await postWithRetry(f, spec.url, { headers: spec.headers, body: spec.body }, { ...cfg.retry, signal, secrets });
    if (!res.body) throw new LlmError({ message: "回應沒有內容", code: "empty_body", retryable: true });
    const ctype = res.headers.get("content-type") ?? "";
    if (ctype.includes("application/json")) {
      // Some gateways answer an error (or a non-stream body) with 200 + JSON.
      const text = await res.text();
      throw new LlmError({ message: `預期串流回應，卻收到 JSON：${scrub(text.slice(0, 300), secrets)}`, code: "not_stream", retryable: false });
    }
    for await (const ev of adapter.parse(parseSse(res.body, signal))) {
      if (ev.type === "error") ev.error.message = scrub(ev.error.message, secrets);
      if (ev.type === "finish" || ev.type === "error") terminal = true;
      yield ev;
      if (terminal) return;
    }
    if (signal?.aborted) throw abortError(signal);
  } catch (e) {
    if (terminal) return;
    let info: LlmErrorInfo;
    if (e instanceof LlmError) info = e.info;
    else if (isAbort(e, signal)) info = abortError(signal).info;
    else info = { message: scrub((e as Error)?.message ?? String(e), secrets), code: "internal", retryable: false };
    terminal = true;
    yield { type: "error", error: info };
  }
}

/**
 * Accumulates stream events into an assistant message, preserving part order
 * (reasoning → text → tool calls as they arrive). Usable incrementally for checkpointing partial output.
 */
export class AssistantBuilder {
  parts: Part[] = [];
  usage: Usage | undefined;
  finish: FinishReason | undefined;
  rawFinish: string | undefined;
  error: LlmErrorInfo | undefined;
  /** Raw JSON fragments of tool calls still streaming. */
  private pending = new Map<string, { name: string; args: string }>();
  private openReasoning: Extract<Part, { type: "reasoning" }> | undefined;
  private openText: Extract<Part, { type: "text" }> | undefined;

  push(ev: StreamEvent): void {
    switch (ev.type) {
      case "text-delta":
        this.openReasoning = undefined;
        if (!this.openText) {
          this.openText = { type: "text", text: "" };
          this.parts.push(this.openText);
        }
        this.openText.text += ev.text;
        break;
      case "reasoning-delta":
        this.openText = undefined;
        if (!this.openReasoning) {
          this.openReasoning = { type: "reasoning", text: "" };
          this.parts.push(this.openReasoning);
        }
        this.openReasoning.text += ev.text;
        break;
      case "reasoning-end": {
        let r = this.openReasoning;
        if (!r) {
          r = { type: "reasoning", text: "" };
          this.parts.push(r);
        }
        r.text = r.text.replace(/\s+$/, "");
        if (ev.signature) r.signature = ev.signature;
        if (ev.redacted) r.redacted = ev.redacted;
        if (ev.providerMeta) r.providerMeta = ev.providerMeta;
        this.openReasoning = undefined;
        break;
      }
      case "tool-call-start":
        this.openText = undefined;
        this.openReasoning = undefined;
        this.pending.set(ev.id, { name: ev.name, args: "" });
        break;
      case "tool-call-delta": {
        const p = this.pending.get(ev.id);
        if (p) p.args += ev.argsDelta;
        break;
      }
      case "tool-call-end":
        this.openText = undefined;
        this.openReasoning = undefined;
        this.pending.delete(ev.id);
        this.parts.push({ type: "tool_call", id: ev.id, name: ev.name, args: ev.args, ...(ev.providerMeta ? { providerMeta: ev.providerMeta } : {}) });
        if (ev.argsError) this.argErrors.set(ev.id, ev.argsError);
        break;
      case "usage":
        this.usage = ev.usage;
        break;
      case "finish":
        this.finish = ev.reason;
        this.rawFinish = ev.rawReason;
        break;
      case "error":
        this.error = ev.error;
        this.finish = ev.error.code === "aborted" ? "aborted" : "error";
        break;
    }
  }

  /** Tool calls whose argument JSON could not be parsed (id → message). */
  argErrors = new Map<string, string>();

  get toolCalls() {
    return this.parts.filter((p): p is Extract<Part, { type: "tool_call" }> => p.type === "tool_call");
  }

  get text() {
    return this.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
  }

  message(): Message {
    return { role: "assistant", parts: this.parts.filter((p) => !(p.type === "text" && !p.text) && !(p.type === "reasoning" && !p.text && !p.signature && !p.redacted && !p.providerMeta?.encrypted)) };
  }
}

/** Convenience: run a full request and return the accumulated result. */
export async function collect(stream: AsyncIterable<StreamEvent>): Promise<AssistantBuilder> {
  const b = new AssistantBuilder();
  for await (const ev of stream) b.push(ev);
  return b;
}
