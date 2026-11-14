/**
 * Model listing + connection tests for every provider kind. Real HTTP via an injectable fetch.
 * Kept deliberately cheap: list endpoints or 1-result / 1-token calls; never image generation.
 */
import type { ModelInfo, TestResult } from "@edgemind/shared";
import { getKindSpec } from "@edgemind/shared";

export interface ProbeTarget {
  type: string;
  kind: string;
  baseUrl: string;
  apiKey: string | null;
  config: Record<string, string>;
}

export type Fetch = typeof fetch;

export class ProviderHttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const TIMEOUT_MS = 15_000;
/** Batch embedding / rerank calls. */
const LONG_TIMEOUT_MS = 30_000;

export function trimSlash(u: string) {
  return u.replace(/\/+$/, "");
}
/** Anthropic/Gemini roots: accept base URLs with or without the version suffix. */
function root(base: string, suffix: RegExp) {
  return trimSlash(base).replace(suffix, "");
}

function baseOf(t: ProbeTarget): string {
  const b = trimSlash(t.baseUrl || getKindSpec(t.type, t.kind)?.defaultBaseUrl || "");
  if (!b) throw new ProviderHttpError(0, "未設定 Base URL");
  return b;
}

async function call(f: Fetch, url: string, init: RequestInit, secret: string | null, timeoutMs = TIMEOUT_MS): Promise<any> {
  let res: Response;
  try {
    res = await f(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new ProviderHttpError(0, `無法連線：${(e as Error).message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 300);
    if (secret) msg = msg.split(secret).join("***");
    throw new ProviderHttpError(res.status, `HTTP ${res.status}：${msg || res.statusText}`);
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new ProviderHttpError(res.status, "回應不是有效的 JSON");
  }
}

const json = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});
const bearer = (k: string | null): Record<string, string> => (k ? { authorization: `Bearer ${k}` } : {});
const anthropicHeaders = (k: string | null) => ({ "x-api-key": k ?? "", "anthropic-version": "2023-06-01" });
const geminiHeaders = (k: string | null) => ({ "x-goog-api-key": k ?? "" });

// ---------------- model listing ----------------

async function listOpenAI(f: Fetch, t: ProbeTarget): Promise<ModelInfo[]> {
  const data = await call(f, `${baseOf(t)}/models`, { headers: bearer(t.apiKey) }, t.apiKey);
  const arr: any[] = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
  return arr.map((m) => ({ id: String(m.id), name: m.name, contextLength: m.context_length ?? m.context_window }));
}

async function listAnthropic(f: Fetch, t: ProbeTarget): Promise<ModelInfo[]> {
  const r = root(baseOf(t), /\/v1$/);
  const out: ModelInfo[] = [];
  let after: string | undefined;
  for (let page = 0; page < 10; page++) {
    const q = new URLSearchParams({ limit: "1000" });
    if (after) q.set("after_id", after);
    const data = await call(f, `${r}/v1/models?${q}`, { headers: anthropicHeaders(t.apiKey) }, t.apiKey);
    for (const m of data.data ?? []) out.push({ id: m.id, name: m.display_name });
    if (!data.has_more || !data.last_id) break;
    after = data.last_id;
  }
  return out;
}

async function listGemini(f: Fetch, t: ProbeTarget, method: string): Promise<ModelInfo[]> {
  const r = root(baseOf(t), /\/v1(beta)?$/);
  const out: ModelInfo[] = [];
  let token: string | undefined;
  for (let page = 0; page < 10; page++) {
    const q = new URLSearchParams({ pageSize: "1000" });
    if (token) q.set("pageToken", token);
    const data = await call(f, `${r}/v1beta/models?${q}`, { headers: geminiHeaders(t.apiKey) }, t.apiKey);
    for (const m of data.models ?? []) {
      const methods: string[] = m.supportedGenerationMethods ?? [];
      if (method && !methods.includes(method)) continue;
      out.push({ id: String(m.name).replace(/^models\//, ""), name: m.displayName, contextLength: m.inputTokenLimit });
    }
    token = data.nextPageToken;
    if (!token) break;
  }
  return out;
}

export async function listModels(f: Fetch, t: ProbeTarget): Promise<ModelInfo[]> {
  const spec = getKindSpec(t.type, t.kind);
  if (!spec) throw new ProviderHttpError(0, "未知的供應商類型");
  const suggested = (spec.suggestedModels ?? []).map((id) => ({ id }));
  if (!spec.canListModels) return suggested;
  let models: ModelInfo[];
  if (t.kind === "anthropic") models = await listAnthropic(f, t);
  else if (t.kind === "gemini") {
    models = await listGemini(f, t, t.type === "embedding" ? "embedContent" : "generateContent");
    if (t.type === "image") models = models.filter((m) => /image/i.test(m.id));
  } else models = await listOpenAI(f, t);
  if (t.type === "embedding" && (t.kind === "openai" || t.kind === "openai_compatible")) {
    const emb = models.filter((m) => /embed/i.test(m.id));
    if (emb.length) models = emb;
  }
  models.sort((a, b) => a.id.localeCompare(b.id));
  return models.length ? models : suggested;
}

// ---------------- connection tests ----------------

async function pingLlm(f: Fetch, t: ProbeTarget, model: string): Promise<string> {
  const b = baseOf(t);
  if (t.kind === "anthropic") {
    const d = await call(f, `${root(b, /\/v1$/)}/v1/messages`, json({ model, max_tokens: 8, messages: [{ role: "user", content: "ping" }] }, anthropicHeaders(t.apiKey)), t.apiKey);
    return (d.content ?? []).map((c: any) => c.text ?? "").join("");
  }
  if (t.kind === "gemini") {
    const d = await call(f, `${root(b, /\/v1(beta)?$/)}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      json({ contents: [{ role: "user", parts: [{ text: "ping" }] }], generationConfig: { maxOutputTokens: 8 } }, geminiHeaders(t.apiKey)), t.apiKey);
    return d.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "";
  }
  const d = await call(f, `${b}/chat/completions`, json({ model, max_tokens: 8, messages: [{ role: "user", content: "ping" }] }, bearer(t.apiKey)), t.apiKey);
  return d.choices?.[0]?.message?.content ?? "";
}

async function searchOnce(f: Fetch, t: ProbeTarget, q: string): Promise<number> {
  const b = baseOf(t);
  switch (t.kind) {
    case "tavily": {
      const d = await call(f, `${b}/search`, json({ query: q, max_results: 1 }, bearer(t.apiKey)), t.apiKey);
      return (d.results ?? []).length;
    }
    case "serper": {
      const d = await call(f, `${b}/search`, json({ q, num: 1 }, { "x-api-key": t.apiKey ?? "" }), t.apiKey);
      return (d.organic ?? []).length;
    }
    case "searxng": {
      const d = await call(f, `${b}/search?${new URLSearchParams({ q, format: "json" })}`, { headers: { accept: "application/json", ...bearer(t.apiKey) } }, t.apiKey);
      return (d.results ?? []).length;
    }
    case "jina": {
      const d = await call(f, `${b}/?${new URLSearchParams({ q })}`, { headers: { accept: "application/json", "x-respond-with": "no-content", ...bearer(t.apiKey) } }, t.apiKey);
      return (d.data ?? []).length;
    }
    case "google_pse": {
      if (!t.config.cx) throw new ProviderHttpError(0, "缺少搜尋引擎 ID（cx）");
      const d = await call(f, `${b}?${new URLSearchParams({ key: t.apiKey ?? "", cx: t.config.cx, q, num: "1" })}`, {}, t.apiKey);
      return (d.items ?? []).length;
    }
  }
  throw new ProviderHttpError(0, "未知的搜尋供應商");
}

/** Cloudflare Workers AI binding (`env.AI` on Pages/Workers). */
export interface AiBinding {
  run(model: string, input: Record<string, unknown>): Promise<any>;
}

export interface EmbedOptions {
  /** Requested output dimension (Matryoshka models). Ignored by providers that cannot truncate. */
  dimensions?: number | null;
  /** Workers AI binding: used instead of the REST API for kind workers_ai when present. */
  ai?: AiBinding | null;
}

/** Embed a batch of texts with any supported embedding provider. */
export async function embedTexts(f: Fetch, t: ProbeTarget, model: string, texts: string[], inputType: "document" | "query" = "document", o: EmbedOptions = {}): Promise<number[][]> {
  const dims = o.dimensions && o.dimensions > 0 ? o.dimensions : undefined;
  let vecs: unknown;
  if (t.kind === "workers_ai" && o.ai && (!t.apiKey || t.config.useBinding === "true")) {
    const d = await o.ai.run(model, { text: texts });
    vecs = d?.data;
  } else {
    const b = baseOf(t);
    switch (t.kind) {
      case "gemini": {
        const base = root(b, /\/v1(beta)?$/);
        const name = model.startsWith("models/") ? model : `models/${model}`;
        const taskType = inputType === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT";
        const d = await call(f, `${base}/v1beta/${name}:batchEmbedContents`, json({ requests: texts.map((text) => ({ model: name, content: { parts: [{ text }] }, taskType, ...(dims ? { outputDimensionality: dims } : {}) })) }, geminiHeaders(t.apiKey)), t.apiKey, LONG_TIMEOUT_MS);
        vecs = d.embeddings?.map((e: any) => e.values);
        break;
      }
      case "cohere": {
        const d = await call(f, `${root(b, /\/v[12]$/)}/v2/embed`, json({ model, texts, input_type: inputType === "query" ? "search_query" : "search_document", embedding_types: ["float"], ...(dims ? { output_dimension: dims } : {}) }, bearer(t.apiKey)), t.apiKey, LONG_TIMEOUT_MS);
        vecs = d.embeddings?.float;
        break;
      }
      case "workers_ai": {
        if (!t.config.accountId) throw new ProviderHttpError(0, "缺少 Cloudflare Account ID");
        const d = await call(f, `${b}/accounts/${encodeURIComponent(t.config.accountId)}/ai/run/${model}`, json({ text: texts }, bearer(t.apiKey)), t.apiKey, LONG_TIMEOUT_MS);
        vecs = d.result?.data;
        break;
      }
      case "voyage": {
        const d = await call(f, `${b}/embeddings`, json({ model, input: texts, input_type: inputType, ...(dims ? { output_dimension: dims } : {}) }, bearer(t.apiKey)), t.apiKey, LONG_TIMEOUT_MS);
        vecs = d.data?.map((x: any) => x.embedding);
        break;
      }
      default: {
        // openai, openai_compatible, mistral, jina share the OpenAI embeddings shape
        const extra: Record<string, unknown> = {};
        if (t.kind === "jina") {
          if (/v[34]/.test(model)) extra.task = inputType === "query" ? "retrieval.query" : "retrieval.passage";
          if (dims) extra.dimensions = dims;
        } else if (t.kind === "mistral") {
          if (dims) extra.output_dimension = dims;
        } else if (dims) extra.dimensions = dims;
        const d = await call(f, `${b}/embeddings`, json({ model, input: texts, ...extra }, bearer(t.apiKey)), t.apiKey, LONG_TIMEOUT_MS);
        vecs = (d.data as any[] | undefined)?.slice().sort((x, y) => (x.index ?? 0) - (y.index ?? 0)).map((x) => x.embedding);
      }
    }
  }
  if (!Array.isArray(vecs) || vecs.length !== texts.length || !vecs.every((v) => Array.isArray(v) && v.length)) throw new ProviderHttpError(0, "回應中沒有 embedding 向量");
  return vecs as number[][];
}

export interface RerankResult {
  index: number;
  score: number;
}

/** Rerank documents for a query (Jina / Cohere / Voyage). Returns results sorted by score, best first. */
export async function rerankDocuments(f: Fetch, t: ProbeTarget, model: string, query: string, documents: string[], topN?: number): Promise<RerankResult[]> {
  if (!documents.length) return [];
  const b = baseOf(t);
  const n = Math.min(documents.length, topN ?? documents.length);
  let raw: any[] | undefined;
  if (t.kind === "cohere") {
    raw = (await call(f, `${root(b, /\/v[12]$/)}/v2/rerank`, json({ model, query, documents, top_n: n }, bearer(t.apiKey)), t.apiKey, LONG_TIMEOUT_MS)).results;
  } else if (t.kind === "voyage") {
    raw = (await call(f, `${b}/rerank`, json({ model, query, documents, top_k: n }, bearer(t.apiKey)), t.apiKey, LONG_TIMEOUT_MS)).data;
  } else {
    raw = (await call(f, `${b}/rerank`, json({ model, query, documents, top_n: n, return_documents: false }, bearer(t.apiKey)), t.apiKey, LONG_TIMEOUT_MS)).results;
  }
  if (!Array.isArray(raw)) throw new ProviderHttpError(0, "回應中沒有 rerank 結果");
  return raw
    .map((r) => ({ index: Number(r.index), score: Number(r.relevance_score ?? r.score) }))
    .filter((r) => Number.isInteger(r.index) && r.index >= 0 && r.index < documents.length && Number.isFinite(r.score))
    .sort((a, b) => b.score - a.score);
}

/** Returns the embedding dimension. */
export async function embedOnce(f: Fetch, t: ProbeTarget, model: string, text = "ping"): Promise<number> {
  if (t.kind === "gemini") {
    const d = await call(f, `${root(baseOf(t), /\/v1(beta)?$/)}/v1beta/models/${encodeURIComponent(model)}:embedContent`, json({ content: { parts: [{ text }] } }, geminiHeaders(t.apiKey)), t.apiKey);
    const vec = d.embedding?.values;
    if (!Array.isArray(vec) || !vec.length) throw new ProviderHttpError(0, "回應中沒有 embedding 向量");
    return vec.length;
  }
  return (await embedTexts(f, t, model, [text]))[0].length;
}

async function rerankOnce(f: Fetch, t: ProbeTarget, model: string): Promise<number> {
  const b = baseOf(t);
  const body = { model, query: "ping", documents: ["ping", "pong"], top_n: 2 };
  if (t.kind === "cohere") {
    const d = await call(f, `${root(b, /\/v[12]$/)}/v2/rerank`, json(body, bearer(t.apiKey)), t.apiKey);
    return (d.results ?? []).length;
  }
  if (t.kind === "voyage") {
    const d = await call(f, `${b}/rerank`, json({ model, query: body.query, documents: body.documents, top_k: 2 }, bearer(t.apiKey)), t.apiKey);
    return (d.data ?? []).length;
  }
  const d = await call(f, `${b}/rerank`, json(body, bearer(t.apiKey)), t.apiKey);
  return (d.results ?? []).length;
}

export async function testProvider(f: Fetch, t: ProbeTarget, opts: { model?: string } = {}): Promise<TestResult> {
  const started = Date.now();
  const done = (ok: boolean, message: string, detail?: Record<string, unknown>): TestResult => ({ ok, latencyMs: Date.now() - started, message, detail });
  const spec = getKindSpec(t.type, t.kind);
  if (!spec) return done(false, "未知的供應商類型");
  if (spec.keyRequired && !t.apiKey) return done(false, "此供應商需要 API Key");
  for (const field of spec.configFields ?? []) {
    if (field.required && !t.config[field.key]) return done(false, `缺少必填欄位：${field.label}`);
  }
  const model = opts.model || spec.suggestedModels?.[0];
  try {
    switch (t.type) {
      case "llm": {
        if (opts.model) {
          const reply = await pingLlm(f, t, opts.model);
          return done(true, `連線成功，模型 ${opts.model} 已回應`, { reply: reply.slice(0, 100) });
        }
        const models = await listModels(f, t);
        return done(true, `連線成功，取得 ${models.length} 個模型`, { modelCount: models.length });
      }
      case "search": {
        const n = await searchOnce(f, t, "EdgeMind");
        return done(true, `連線成功，搜尋回傳 ${n} 筆結果`, { results: n });
      }
      case "embedding": {
        if (!model) return done(false, "請指定要測試的 Embedding 模型");
        const dim = await embedOnce(f, t, model);
        return done(true, `連線成功，${model} 向量維度為 ${dim}`, { dimension: dim, model });
      }
      case "rerank": {
        if (!model) return done(false, "請指定要測試的 Rerank 模型");
        const n = await rerankOnce(f, t, model);
        return done(true, `連線成功，重排序回傳 ${n} 筆`, { results: n, model });
      }
      case "image": {
        if (t.kind === "workers_ai") {
          await call(f, `${baseOf(t)}/accounts/${encodeURIComponent(t.config.accountId)}/ai/models/search?per_page=1`, { headers: bearer(t.apiKey) }, t.apiKey);
          return done(true, "連線成功，Workers AI 權杖有效");
        }
        const models = await listModels(f, t);
        return done(true, `連線成功，取得 ${models.length} 個模型`, { modelCount: models.length });
      }
    }
    return done(false, "未知的供應商類型");
  } catch (e) {
    return done(false, e instanceof ProviderHttpError ? e.message : `錯誤：${(e as Error).message}`);
  }
}
