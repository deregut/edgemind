/**
 * Google Gemini generateContent / streamGenerateContent (alt=sse): functionCall / functionResponse,
 * thought parts (includeThoughts), thoughtSignature round-trip on function calls, inline images/PDFs.
 */
import type { ChatRequest, FinishReason, Part, StreamEvent } from "../../../shared/src/index";
import { effortBudget } from "./prepare";
import type { SseEvent } from "./sse";
import { type Adapter, type HttpRequestSpec, safeJson, trimSlash } from "./types";

/** Gemini accepts an OpenAPI 3.0 schema subset; strip keywords it rejects. */
export function sanitizeSchema(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(sanitizeSchema);
  if (!s || typeof s !== "object") return s;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s as Record<string, unknown>)) {
    if (["$schema", "$id", "$ref", "$defs", "definitions", "additionalProperties", "default", "examples", "const", "patternProperties", "unevaluatedProperties"].includes(k)) continue;
    if (k === "type" && Array.isArray(v)) {
      const nonNull = v.filter((t) => t !== "null");
      out.type = nonNull[0] ?? "string";
      if (v.includes("null")) out.nullable = true;
      continue;
    }
    if (k === "properties" && v && typeof v === "object") {
      out.properties = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, sanitizeSchema(pv)]));
      continue;
    }
    out[k] = sanitizeSchema(v);
  }
  return out;
}

function responseObject(p: Extract<Part, { type: "tool_result" }>): Record<string, unknown> {
  const r = p.result;
  if (p.isError) return { error: typeof r === "string" ? r : r };
  if (r && typeof r === "object" && !Array.isArray(r)) return r as Record<string, unknown>;
  return { result: r };
}

function partsFor(p: Part, callNames: Map<string, { name: string; geminiId?: string }>): any[] {
  switch (p.type) {
    case "text":
      return p.text ? [{ text: p.text }] : [];
    case "image":
      return [p.url ? { fileData: { mimeType: p.mime, fileUri: p.url } } : { inlineData: { mimeType: p.mime, data: p.data ?? "" } }];
    case "file":
      return p.data ? [{ inlineData: { mimeType: p.mime, data: p.data } }] : [];
    case "tool_call": {
      const meta = (p.providerMeta ?? {}) as { thoughtSignature?: string; geminiId?: string };
      callNames.set(p.id, { name: p.name, geminiId: meta.geminiId });
      const fc: any = { name: p.name, args: p.args ?? {} };
      if (meta.geminiId) fc.id = meta.geminiId;
      return [{ functionCall: fc, ...(meta.thoughtSignature ? { thoughtSignature: meta.thoughtSignature } : {}) }];
    }
    case "tool_result": {
      const c = callNames.get(p.callId);
      const fr: any = { name: c?.name ?? p.name, response: responseObject(p) };
      if (c?.geminiId) fr.id = c.geminiId;
      return [{ functionResponse: fr }];
    }
    case "reasoning":
      // Thought summaries are not re-sent. Signatures that matter (function calls) ride on the tool_call part;
      // text-part signatures are optional per the Gemini docs and are dropped.
      return [];
  }
}

export function buildGeminiBody(req: ChatRequest): Record<string, unknown> {
  const contents: { role: "user" | "model"; parts: any[] }[] = [];
  const systemExtra: string[] = [];
  const callNames = new Map<string, { name: string; geminiId?: string }>();
  for (const m of req.messages) {
    if (m.role === "system") {
      systemExtra.push(m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n"));
      continue;
    }
    const modelParts: any[] = [];
    const userParts: any[] = [];
    for (const p of m.parts) {
      const parts = partsFor(p, callNames);
      if (m.role === "assistant" && p.type !== "tool_result") modelParts.push(...parts);
      else userParts.push(...parts);
    }
    for (const [role, parts] of [["model", modelParts], ["user", userParts]] as const) {
      if (!parts.length) continue;
      const last = contents[contents.length - 1];
      if (last && last.role === role) last.parts.push(...parts);
      else contents.push({ role, parts: [...parts] });
    }
  }
  const body: Record<string, unknown> = { contents };
  const system = [req.system, ...systemExtra].filter(Boolean).join("\n\n");
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const gen: Record<string, unknown> = {};
  if (req.maxTokens) gen.maxOutputTokens = req.maxTokens;
  if (req.temperature !== undefined) gen.temperature = req.temperature;
  if (req.topP !== undefined) gen.topP = req.topP;
  if (req.stop?.length) gen.stopSequences = req.stop;
  if (req.reasoning) gen.thinkingConfig = { includeThoughts: true, thinkingBudget: effortBudget(req.reasoning.effort, req.reasoning.budgetTokens) };
  if (Object.keys(gen).length) body.generationConfig = gen;
  if (req.tools?.length) {
    body.tools = [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parameters: sanitizeSchema(t.parameters) })) }];
    const tc = req.toolChoice;
    if (tc) {
      const fc: any =
        tc === "required" ? { mode: "ANY" } : tc === "none" ? { mode: "NONE" } : tc === "auto" ? { mode: "AUTO" } : { mode: "ANY", allowedFunctionNames: [tc.name] };
      body.toolConfig = { functionCallingConfig: fc };
    }
  }
  return body;
}

function mapFinish(r: string | undefined): FinishReason {
  switch (r) {
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
    case "RECITATION":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
    case "SPII":
    case "IMAGE_SAFETY":
      return "content_filter";
    case "MALFORMED_FUNCTION_CALL":
    case "UNEXPECTED_TOOL_CALL":
      return "error";
    default:
      return "other";
  }
}

export const geminiAdapter: Adapter = {
  build(req, cfg): HttpRequestSpec {
    const root = trimSlash(cfg.baseUrl).replace(/\/v1(beta|alpha)?$/, "");
    const model = req.model.replace(/^models\//, "");
    return {
      url: `${root}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
      headers: { "x-goog-api-key": cfg.apiKey ?? "", accept: "text/event-stream", ...cfg.headers },
      body: buildGeminiBody(req),
    };
  },

  async *parse(events: AsyncIterable<SseEvent>): AsyncGenerator<StreamEvent> {
    let usage: any;
    let finish: string | undefined;
    let calls = 0;
    let inThought = false;
    let any = false;
    for await (const ev of events) {
      const j = safeJson(ev.data);
      if (!j) continue;
      const chunk = Array.isArray(j) ? j[0] : j;
      if (chunk?.error) {
        const e = chunk.error;
        yield { type: "error", error: { message: String(e.message ?? "未知錯誤"), status: e.code, code: e.status, retryable: e.code === 429 || e.code >= 500 } };
        return;
      }
      any = true;
      if (chunk.usageMetadata) usage = chunk.usageMetadata;
      if (chunk.promptFeedback?.blockReason && !chunk.candidates?.length) {
        finish = "SAFETY";
        continue;
      }
      const cand = chunk.candidates?.[0];
      if (!cand) continue;
      for (const p of cand.content?.parts ?? []) {
        if (p.thought && typeof p.text === "string") {
          inThought = true;
          if (p.text) yield { type: "reasoning-delta", text: p.text };
          if (p.thoughtSignature) {
            inThought = false;
            yield { type: "reasoning-end", providerMeta: { protocol: "gemini", thoughtSignature: p.thoughtSignature } };
          }
          continue;
        }
        if (inThought) {
          inThought = false;
          yield { type: "reasoning-end", providerMeta: { protocol: "gemini" } };
        }
        if (p.functionCall) {
          calls++;
          const fc = p.functionCall;
          const id = fc.id ? String(fc.id) : `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
          const argsStr = JSON.stringify(fc.args ?? {});
          yield { type: "tool-call-start", id, name: fc.name };
          yield { type: "tool-call-delta", id, argsDelta: argsStr };
          const providerMeta: Record<string, unknown> = { protocol: "gemini" };
          if (p.thoughtSignature) providerMeta.thoughtSignature = p.thoughtSignature;
          if (fc.id) providerMeta.geminiId = String(fc.id);
          yield { type: "tool-call-end", id, name: fc.name, args: fc.args ?? {}, providerMeta };
          continue;
        }
        if (typeof p.text === "string") {
          if (p.text) yield { type: "text-delta", text: p.text };
        }
      }
      if (cand.finishReason) finish = cand.finishReason;
    }
    if (inThought) yield { type: "reasoning-end", providerMeta: { protocol: "gemini" } };
    if (!any) {
      yield { type: "error", error: { message: "串流意外結束（沒有收到任何內容）", code: "incomplete_stream", retryable: true } };
      return;
    }
    if (usage) {
      yield {
        type: "usage",
        usage: {
          inputTokens: usage.promptTokenCount ?? 0,
          outputTokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
          cachedInputTokens: usage.cachedContentTokenCount,
          reasoningTokens: usage.thoughtsTokenCount,
        },
      };
    }
    let reason = mapFinish(finish);
    if (calls && (reason === "stop" || reason === "other")) reason = "tool_calls";
    if (!finish && !calls) reason = "stop";
    yield { type: "finish", reason, rawReason: finish };
  },
};
