/**
 * web_search: configured search providers (Tavily, Serper, SearXNG, Jina, Google PSE) in priority order with
 * fallback; results are always capped (title + url + snippet ≤ 300 chars, total ≤ ~4000 chars).
 * web_fetch: SSRF-guarded fetch → Readability → Markdown, read in chunks via `offset`; Jina Reader fallback.
 */
import { and, asc, eq } from "drizzle-orm";
import { getKindSpec } from "../../../shared/src/index";
import type { Database } from "../db/client";
import { providers, usageLogs } from "../db/schema";
import { decryptSecret } from "../lib/crypto";
import type { Tool, ToolContext } from "../agent/tools";
import { htmlToMarkdown } from "./html";
import { BlockedUrlError, checkUrlShape, safeFetch, type Fetch } from "./ssrf";

export const SNIPPET_MAX = 300;
export const SEARCH_TOTAL_MAX = 4000;

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

interface SearchProvider {
  id: string;
  kind: string;
  name: string;
  baseUrl: string;
  apiKey: string | null;
  config: Record<string, string>;
}

const clip = (s: unknown, n: number) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

async function loadProviders(database: Database, encKey: Uint8Array, kind?: string): Promise<SearchProvider[]> {
  const rows = await database.db.select().from(providers)
    .where(and(eq(providers.type, "search"), eq(providers.enabled, true), kind ? eq(providers.kind, kind) : undefined))
    .orderBy(asc(providers.priority), asc(providers.createdAt));
  const out: SearchProvider[] = [];
  for (const r of rows) {
    const apiKey = r.apiKeyEnc ? await decryptSecret(r.apiKeyEnc, encKey, `provider:${r.id}:apiKey`).catch(() => null) : null;
    out.push({ id: r.id, kind: r.kind, name: r.name, baseUrl: (r.baseUrl || getKindSpec("search", r.kind)?.defaultBaseUrl || "").replace(/\/+$/, ""), apiKey, config: r.config ?? {} });
  }
  return out;
}

async function getJson(f: Fetch, url: string, init: RequestInit, signal: AbortSignal): Promise<any> {
  const res = await f(url, { ...init, signal });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}${text ? `：${text.slice(0, 200)}` : ""}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("回應不是 JSON");
  }
}

const bearer = (k: string | null): Record<string, string> => (k ? { authorization: `Bearer ${k}` } : {});

export async function searchWith(f: Fetch, p: SearchProvider, query: string, n: number, signal: AbortSignal): Promise<SearchResult[]> {
  const b = p.baseUrl;
  const json = (body: unknown, headers: Record<string, string>): RequestInit => ({ method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  let raw: { title?: unknown; url?: unknown; snippet?: unknown }[] = [];
  switch (p.kind) {
    case "tavily": {
      const d = await getJson(f, `${b}/search`, json({ query, max_results: n, search_depth: "basic", include_answer: false }, bearer(p.apiKey)), signal);
      raw = (d.results ?? []).map((r: any) => ({ title: r.title, url: r.url, snippet: r.content }));
      break;
    }
    case "serper": {
      const d = await getJson(f, `${b}/search`, json({ q: query, num: n }, { "x-api-key": p.apiKey ?? "" }), signal);
      raw = (d.organic ?? []).map((r: any) => ({ title: r.title, url: r.link, snippet: r.snippet }));
      break;
    }
    case "searxng": {
      const d = await getJson(f, `${b}/search?${new URLSearchParams({ q: query, format: "json" })}`, { headers: { accept: "application/json", ...bearer(p.apiKey) } }, signal);
      raw = (d.results ?? []).map((r: any) => ({ title: r.title, url: r.url, snippet: r.content }));
      break;
    }
    case "jina": {
      const d = await getJson(f, `${b}/?${new URLSearchParams({ q: query })}`, { headers: { accept: "application/json", "x-respond-with": "no-content", ...bearer(p.apiKey) } }, signal);
      raw = (d.data ?? []).map((r: any) => ({ title: r.title, url: r.url, snippet: r.description ?? r.content }));
      break;
    }
    case "google_pse": {
      if (!p.config.cx) throw new Error("缺少搜尋引擎 ID（cx）");
      const d = await getJson(f, `${b}?${new URLSearchParams({ key: p.apiKey ?? "", cx: p.config.cx, q: query, num: String(Math.min(n, 10)) })}`, {}, signal);
      raw = (d.items ?? []).map((r: any) => ({ title: r.title, url: r.link, snippet: r.snippet }));
      break;
    }
    default:
      throw new Error(`不支援的搜尋供應商：${p.kind}`);
  }
  return raw
    .filter((r) => typeof r.url === "string" && /^https?:\/\//.test(r.url))
    .slice(0, n)
    .map((r) => ({ title: clip(r.title, 200), url: String(r.url).slice(0, 500), snippet: clip(r.snippet, SNIPPET_MAX) }));
}

/** Keep whole results while under the total budget. */
export function capResults(results: SearchResult[], total = SEARCH_TOTAL_MAX): SearchResult[] {
  const out: SearchResult[] = [];
  let used = 0;
  for (const r of results) {
    const size = r.title.length + r.url.length + r.snippet.length;
    if (out.length && used + size > total) break;
    out.push(r);
    used += size;
  }
  return out;
}

export const webSearchTool: Tool = {
  name: "web_search",
  description: "搜尋網路。每筆結果只有標題、網址與摘要（≤300 字）；需要全文時再用 web_fetch 讀取網址。",
  risk: "read",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "搜尋關鍵字" },
      max_results: { type: "integer", minimum: 1, maximum: 10, description: "結果數量（預設 5）" },
    },
    required: ["query"],
  },
  targets: () => ({}),
  async execute(args, ctx: ToolContext) {
    const query = String(args?.query ?? "").trim().slice(0, 400);
    if (!query) throw new Error("query 不可為空");
    const n = Math.min(10, Math.max(1, Number.isInteger(args?.max_results) ? args.max_results : 5));
    const list = await loadProviders(ctx.database, ctx.encKey);
    if (!list.length) throw new Error("尚未設定任何網頁搜尋供應商，請到 設定 → 供應商 → 網頁搜尋 新增。");
    const errors: string[] = [];
    for (const p of list) {
      try {
        const results = await searchWith(ctx.fetch, p, query, n, ctx.signal);
        await ctx.database.db.insert(usageLogs).values({ providerId: p.id, kind: "search", runId: ctx.runId, model: p.kind }).catch(() => {});
        if (!results.length && list.indexOf(p) < list.length - 1) {
          errors.push(`${p.name}：沒有結果`);
          continue;
        }
        return { query, provider: p.name, results: capResults(results), ...(errors.length ? { fallbackFrom: errors } : {}) };
      } catch (e) {
        if (ctx.signal.aborted) throw e;
        errors.push(`${p.name}：${(e as Error).message}`);
      }
    }
    throw new Error(`所有搜尋供應商都失敗：${errors.join("；")}`);
  },
};

// ---------------- web_fetch ----------------

export const FETCH_DEFAULT_CHARS = 8000;
export const FETCH_MAX_CHARS = 20000;
const MAX_DOWNLOAD = 5 * 1024 * 1024;
const UA = "Mozilla/5.0 (compatible; EdgeMind/0.1; +https://github.com/edgemind)";

async function readCapped(res: Response, max: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(0), truncated: false };
  const chunks: Uint8Array[] = [];
  let n = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    n += value.length;
    if (n >= max) {
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
  }
  const out = new Uint8Array(Math.min(n, max));
  let o = 0;
  for (const c of chunks) {
    const take = Math.min(c.length, out.length - o);
    out.set(c.subarray(0, take), o);
    o += take;
    if (o >= out.length) break;
  }
  return { bytes: out, truncated };
}

function charsetOf(ct: string): string {
  return ct.match(/charset=([\w-]+)/i)?.[1]?.toLowerCase() ?? "utf-8";
}

function decode(bytes: Uint8Array, ct: string, sniff = true): string {
  let cs = charsetOf(ct);
  if (sniff && !/charset=/i.test(ct)) {
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 2048));
    cs = head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1]?.toLowerCase() ?? cs;
  }
  try {
    return new TextDecoder(cs).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

async function jinaReader(ctx: ToolContext, url: string): Promise<{ title: string; markdown: string }> {
  const [jina] = await loadProviders(ctx.database, ctx.encKey, "jina");
  const res = await ctx.fetch(`https://r.jina.ai/${url}`, {
    headers: { accept: "text/plain", "x-return-format": "markdown", ...bearer(jina?.apiKey ?? null) },
    signal: ctx.signal,
  });
  if (!res.ok) throw new Error(`Jina Reader HTTP ${res.status}`);
  const { bytes } = await readCapped(res, MAX_DOWNLOAD);
  let text = new TextDecoder().decode(bytes);
  const title = text.match(/^Title:\s*(.+)$/m)?.[1]?.trim() ?? "";
  const i = text.indexOf("Markdown Content:");
  if (i >= 0) text = text.slice(i + "Markdown Content:".length);
  return { title, markdown: text.trim() };
}

export async function fetchReadable(ctx: ToolContext, url: string): Promise<{ title: string; markdown: string; finalUrl: string; source: "direct" | "jina"; note?: string }> {
  checkUrlShape(url);
  let directError = "";
  try {
    const timeout = AbortSignal.timeout(20_000);
    const signal = AbortSignal.any ? AbortSignal.any([ctx.signal, timeout]) : ctx.signal;
    const { res, url: finalUrl } = await safeFetch(ctx.fetch, url, {
      headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5", "accept-language": "zh-TW,zh;q=0.9,en;q=0.8" },
      signal,
    });
    const ct = res.headers.get("content-type") ?? "";
    if (res.ok) {
      const { bytes, truncated } = await readCapped(res, MAX_DOWNLOAD);
      const note = truncated ? "內容超過 5 MB，只處理前段" : undefined;
      if (/html|xml/.test(ct) || (!ct && /^\s*</.test(new TextDecoder().decode(bytes.subarray(0, 100))))) {
        const { title, markdown } = htmlToMarkdown(decode(bytes, ct), finalUrl);
        if (markdown.trim().length >= 50) return { title, markdown, finalUrl, source: "direct", note };
        directError = "頁面沒有可讀內容（可能需要 JavaScript）";
      } else if (/^text\/|json|javascript|csv|yaml/.test(ct)) {
        return { title: "", markdown: decode(bytes, ct, false), finalUrl, source: "direct", note };
      } else directError = `不支援直接解析的內容類型：${ct || "未知"}`;
    } else {
      await res.body?.cancel().catch(() => {});
      directError = `HTTP ${res.status}`;
    }
  } catch (e) {
    if (e instanceof BlockedUrlError) throw e;
    if (ctx.signal.aborted) throw e;
    directError = (e as Error).message;
  }
  try {
    const j = await jinaReader(ctx, url);
    if (!j.markdown) throw new Error("沒有內容");
    return { ...j, finalUrl: url, source: "jina", note: `直接讀取失敗（${directError}），改用 Jina Reader` };
  } catch (e) {
    if (ctx.signal.aborted) throw e;
    throw new Error(`無法讀取網頁：${directError}；Jina Reader：${(e as Error).message}`);
  }
}

export const webFetchTool: Tool = {
  name: "web_fetch",
  description: "讀取網頁並轉成 Markdown（主要內容）。內容很長時分段回傳：用 offset 讀取下一段（見 nextOffset）。",
  risk: "read",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "http(s) 網址" },
      offset: { type: "integer", minimum: 0, description: "從第幾個字元開始（預設 0）" },
      max_chars: { type: "integer", minimum: 500, maximum: FETCH_MAX_CHARS, description: `本次最多回傳的字元數（預設 ${FETCH_DEFAULT_CHARS}）` },
    },
    required: ["url"],
  },
  async execute(args, ctx: ToolContext) {
    const url = String(args?.url ?? "").trim();
    const offset = Math.max(0, Number.isInteger(args?.offset) ? args.offset : 0);
    const max = Math.min(FETCH_MAX_CHARS, Math.max(500, Number.isInteger(args?.max_chars) ? args.max_chars : FETCH_DEFAULT_CHARS));
    const page = await fetchReadable(ctx, url);
    const total = page.markdown.length;
    const content = page.markdown.slice(offset, offset + max);
    const next = offset + max < total ? offset + max : null;
    return {
      url, ...(page.finalUrl !== url ? { finalUrl: page.finalUrl } : {}), title: page.title, source: page.source,
      totalChars: total, offset, nextOffset: next, ...(page.note ? { note: page.note } : {}),
      content: offset >= total && total > 0 ? "" : content,
    };
  },
};
