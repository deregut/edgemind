/**
 * OpenAI Responses API (stateless: store=false, encrypted reasoning items round-tripped via providerMeta).
 */
import type { ChatRequest, StreamEvent } from "../../../shared/src/index";
import type { SseEvent } from "./sse";
import { type Adapter, type HttpRequestSpec, parseArgs, resultToString, safeJson, trimSlash } from "./types";

const dataUrl = (mime: string, data: string) => `data:${mime};base64,${data}`;

export function buildResponsesBody(req: ChatRequest): Record<string, unknown> {
  const input: any[] = [];
  for (const m of req.messages) {
    if (m.role === "system") {
      const text = m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
      if (text) input.push({ role: "developer", content: text });
      continue;
    }
    if (m.role === "assistant") {
      let textBuf = "";
      const flush = () => {
        if (textBuf) input.push({ role: "assistant", content: [{ type: "output_text", text: textBuf }] });
        textBuf = "";
      };
      for (const p of m.parts) {
        if (p.type === "text") textBuf += p.text;
        else if (p.type === "reasoning") {
          const meta = p.providerMeta as { itemId?: string; encrypted?: string } | undefined;
          if (meta?.encrypted) {
            flush();
            input.push({ type: "reasoning", id: meta.itemId, encrypted_content: meta.encrypted, summary: p.text ? [{ type: "summary_text", text: p.text }] : [] });
          }
        } else if (p.type === "tool_call") {
          flush();
          input.push({ type: "function_call", call_id: p.id, name: p.name, arguments: JSON.stringify(p.args ?? {}) });
        } else if (p.type === "tool_result") {
          flush();
          input.push({ type: "function_call_output", call_id: p.callId, output: resultToString(p.result) });
        }
      }
      flush();
      continue;
    }
    // user / tool
    const content: any[] = [];
    for (const p of m.parts) {
      if (p.type === "tool_result") input.push({ type: "function_call_output", call_id: p.callId, output: resultToString(p.result) });
      else if (p.type === "text") content.push({ type: "input_text", text: p.text });
      else if (p.type === "image") content.push({ type: "input_image", image_url: p.url ?? dataUrl(p.mime, p.data ?? "") });
      else if (p.type === "file" && p.data) content.push({ type: "input_file", filename: p.name, file_data: dataUrl(p.mime, p.data) });
    }
    if (content.length) input.push({ role: "user", content });
  }
  const body: Record<string, unknown> = { model: req.model, input, stream: true, store: false };
  if (req.system) body.instructions = req.system;
  if (req.maxTokens) body.max_output_tokens = req.maxTokens;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.topP !== undefined) body.top_p = req.topP;
  if (req.reasoning) {
    body.reasoning = { effort: req.reasoning.effort ?? "medium", summary: "auto" };
    body.include = ["reasoning.encrypted_content"];
  }
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters, strict: false }));
    if (req.toolChoice) body.tool_choice = typeof req.toolChoice === "string" ? req.toolChoice : { type: "function", name: req.toolChoice.name };
    if (req.parallelToolCalls !== undefined) body.parallel_tool_calls = req.parallelToolCalls;
  }
  return body;
}

export const openaiResponsesAdapter: Adapter = {
  build(req, cfg): HttpRequestSpec {
    return {
      url: `${trimSlash(cfg.baseUrl)}/responses`,
      headers: { ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}), accept: "text/event-stream", ...cfg.headers },
      body: buildResponsesBody(req),
    };
  },

  async *parse(events: AsyncIterable<SseEvent>): AsyncGenerator<StreamEvent> {
    const calls = new Map<string, { callId: string; name: string; args: string }>(); // keyed by item id
    let sawCall = false;
    let reasoningOpen = false;
    for await (const ev of events) {
      if (ev.data === "[DONE]") break;
      const j = safeJson(ev.data);
      if (!j) continue;
      const type: string = j.type ?? ev.event;
      switch (type) {
        case "response.output_text.delta":
          if (j.delta) yield { type: "text-delta", text: j.delta };
          break;
        case "response.reasoning_summary_text.delta":
        case "response.reasoning_text.delta":
          reasoningOpen = true;
          if (j.delta) yield { type: "reasoning-delta", text: j.delta };
          break;
        case "response.reasoning_summary_part.done":
          // separate multiple summary parts with a blank line
          yield { type: "reasoning-delta", text: "\n\n" };
          break;
        case "response.output_item.added": {
          const it = j.item;
          if (it?.type === "function_call") {
            calls.set(it.id, { callId: it.call_id, name: it.name, args: it.arguments ?? "" });
            sawCall = true;
            yield { type: "tool-call-start", id: it.call_id, name: it.name };
          }
          break;
        }
        case "response.function_call_arguments.delta": {
          const c = calls.get(j.item_id);
          if (c && j.delta) {
            c.args += j.delta;
            yield { type: "tool-call-delta", id: c.callId, argsDelta: j.delta };
          }
          break;
        }
        case "response.output_item.done": {
          const it = j.item;
          if (it?.type === "function_call") {
            const c = calls.get(it.id) ?? { callId: it.call_id, name: it.name, args: "" };
            const raw = typeof it.arguments === "string" ? it.arguments : c.args;
            const { args, argsError } = parseArgs(raw);
            if (!calls.has(it.id)) yield { type: "tool-call-start", id: c.callId, name: c.name };
            sawCall = true;
            yield { type: "tool-call-end", id: c.callId, name: c.name, args, ...(argsError ? { argsError } : {}) };
          } else if (it?.type === "reasoning") {
            if (!reasoningOpen) {
              const text = (it.summary ?? []).map((s: any) => s.text ?? "").join("\n\n");
              if (text) yield { type: "reasoning-delta", text };
            }
            reasoningOpen = false;
            yield { type: "reasoning-end", providerMeta: { protocol: "openai", api: "responses", itemId: it.id, encrypted: it.encrypted_content } };
          }
          break;
        }
        case "response.completed":
        case "response.incomplete": {
          const r = j.response ?? {};
          const u = r.usage;
          if (u) {
            yield {
              type: "usage",
              usage: {
                inputTokens: u.input_tokens ?? 0,
                outputTokens: u.output_tokens ?? 0,
                cachedInputTokens: u.input_tokens_details?.cached_tokens,
                reasoningTokens: u.output_tokens_details?.reasoning_tokens,
              },
            };
          }
          if (type === "response.incomplete") {
            const why = r.incomplete_details?.reason;
            yield { type: "finish", reason: why === "content_filter" ? "content_filter" : "length", rawReason: why };
          } else yield { type: "finish", reason: sawCall ? "tool_calls" : "stop", rawReason: r.status };
          return;
        }
        case "response.failed": {
          const e = j.response?.error ?? {};
          yield { type: "error", error: { message: String(e.message ?? "回應失敗"), code: e.code, retryable: e.code === "server_error" || e.code === "rate_limit_exceeded" } };
          return;
        }
        case "error":
          yield { type: "error", error: { message: String(j.message ?? j.error?.message ?? "未知錯誤"), code: j.code ?? j.error?.code, retryable: false } };
          return;
        default:
          break;
      }
    }
    yield { type: "error", error: { message: "串流意外結束（未收到 response.completed）", code: "incomplete_stream", retryable: true } };
  },
};
