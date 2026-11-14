/**
 * http_request [dangerous]: arbitrary HTTP call with server-side `{{secret:NAME}}` substitution.
 *  - Secrets are resolved only here; a secret may only be sent to a host matching its allowedDomains, and redirects
 *    are followed only while the new host still satisfies every secret used (otherwise the 3xx is returned as is).
 *  - SSRF guard (tools/ssrf.ts) on every hop; no secret in the hostname.
 *  - Response: status, selected headers, body capped (JSON pretty-printed); every secret value used is redacted from
 *    the response, the final URL and error messages, so neither the model nor run_steps / audit logs ever hold it.
 *  - bodyFromFile / saveResponseTo move raw bytes between project files and the request (e.g. E2B file upload/download).
 */
import { ToolDeferred, type Tool, type ToolContext } from "../agent/tools";
import { assertPublicUrl, BlockedUrlError, checkUrlShape } from "./ssrf";
import { hostAllowed, loadSecrets, makeRedactor, referencedNames, type LoadedSecret } from "../secrets";
import { normalizePath } from "../storage/files";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
export const HTTP_BODY_CAP = 20_000;
const MAX_DOWNLOAD = 5 * 1024 * 1024;
const MAX_SAVE = 10 * 1024 * 1024;
const MAX_REQUEST_BODY = 10 * 1024 * 1024;
const FORBIDDEN_HEADERS = new Set(["host", "content-length", "connection", "transfer-encoding", "keep-alive", "upgrade", "te", "trailer", "proxy-authorization", "proxy-connection"]);
const KEEP_HEADERS = /^(content-type|content-length|content-encoding|content-disposition|location|retry-after|etag|last-modified|cache-control|date|link|www-authenticate|x-request-id|request-id|x-ratelimit-[\w-]+|ratelimit[\w-]*)$/i;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function readStream(res: Response, max: number, signal: AbortSignal): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  return (async () => {
    if (!res.body) return { bytes: new Uint8Array(), truncated: false };
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let n = 0;
    let truncated = false;
    for (;;) {
      if (signal.aborted) {
        await reader.cancel().catch(() => {});
        throw signal.reason ?? new Error("aborted");
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (n + value.length > max) {
        chunks.push(value.subarray(0, max - n));
        n = max;
        truncated = true;
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(value);
      n += value.length;
    }
    const out = new Uint8Array(n);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.length;
    }
    return { bytes: out, truncated };
  })();
}

const isTextual = (ct: string) => /^(text\/|application\/(json|[\w.+-]*\+json|xml|[\w.+-]*\+xml|javascript|x-www-form-urlencoded|x-ndjson|ndjson|yaml|x-yaml|graphql))/i.test(ct) || ct === "";

function substitute(s: string, secrets: Map<string, LoadedSecret>, mode: "raw" | "url" | "json"): string {
  return s.replace(/\{\{\s*secret:([A-Za-z_][A-Za-z0-9_]{0,63})\s*\}\}/g, (_, name: string) => {
    const v = secrets.get(name)!.value;
    return mode === "url" ? encodeURIComponent(v) : mode === "json" ? JSON.stringify(v).slice(1, -1) : v;
  });
}

function stringMap(v: unknown, what: string): Record<string, string> {
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) throw new Error(`${what} 必須是物件（鍵值對）`);
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (val === undefined || val === null) continue;
    out[k] = typeof val === "string" ? val : typeof val === "object" ? JSON.stringify(val) : String(val);
  }
  return out;
}

async function execute(args: any, ctx: ToolContext) {
  const method = String(args?.method ?? "GET").toUpperCase();
  if (!METHODS.includes(method)) throw new Error(`不支援的 method：${method}`);
  const rawUrl = String(args?.url ?? "");
  const headersIn = stringMap(args?.headers, "headers");
  const queryIn = stringMap(args?.query, "query");
  let timeoutMs = Math.min(60, Math.max(1, Number(args?.timeoutSec) || 30)) * 1000;
  if (ctx.deadline !== undefined) {
    const left = ctx.deadline - Date.now() - 1500;
    if (left < Math.min(timeoutMs, 8000)) throw new ToolDeferred(); // run it at the start of the next segment instead
    timeoutMs = Math.min(timeoutMs, left);
  }
  const bodyType = args?.bodyType === "text" ? "text" : args?.bodyType === "json" ? "json" : typeof args?.body === "string" ? "text" : "json";

  // Collect references everywhere they may appear.
  const bodyTemplate = args?.body === undefined || args?.body === null ? undefined : typeof args.body === "string" ? args.body : JSON.stringify(args.body);
  const haystack = [rawUrl, ...Object.entries(headersIn).flat(), ...Object.entries(queryIn).flat(), bodyTemplate ?? ""].join("\n");
  const names = referencedNames(haystack);
  const secrets = await loadSecrets(ctx.database, ctx.encKey, names);
  const missing = names.filter((n) => !secrets.has(n));
  if (missing.length) throw new Error(`找不到密鑰：${missing.join("、")}（請到 設定 → 密鑰 新增）`);
  const used = [...secrets.values()];
  const redact = makeRedactor(used);
  const safe = (s: string) => redact(s);

  try {
    // URL: no secret in scheme/host; substitute URL-encoded elsewhere.
    // A secret may hold a whole base URL (self-hosted services) when it starts the url; elsewhere it is URL-encoded.
    let urlTemplate = rawUrl.trim();
    const prefix = /^\{\{\s*secret:([A-Za-z_][A-Za-z0-9_]{0,63})\s*\}\}/.exec(urlTemplate);
    if (prefix) urlTemplate = secrets.get(prefix[1])!.value.trim().replace(/\/+$/, "") + urlTemplate.slice(prefix[0].length);
    const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(urlTemplate)?.[1] ?? "";
    if (/\{\{\s*secret:/.test(authority)) throw new Error("主機名稱（與帳密部分）中不可使用密鑰（要用密鑰存整個基底網址時，請把它放在 url 最開頭）");
    checkUrlShape(urlTemplate.replace(/\{\{\s*secret:[^}]*\}\}/g, "x"));
    const url = new URL(substitute(urlTemplate, secrets, "url"));
    for (const [k, v] of Object.entries(queryIn)) url.searchParams.append(substitute(k, secrets, "raw"), substitute(v, secrets, "raw"));

    const checkSecretsFor = (host: string) => {
      for (const s of used) {
        if (!s.allowedDomains.length) throw new Error(`密鑰 ${s.name} 沒有設定允許網域，無法使用（設定 → 密鑰）`);
        if (!hostAllowed(host, s.allowedDomains)) throw new Error(`密鑰 ${s.name} 不允許送往 ${host}（允許：${s.allowedDomains.join("、")}）`);
      }
    };
    checkSecretsFor(url.hostname);

    const headers = new Headers();
    for (const [k, v] of Object.entries(headersIn)) {
      if (FORBIDDEN_HEADERS.has(k.toLowerCase())) continue;
      if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(k)) throw new Error(`無效的標頭名稱：${k}`);
      headers.set(k, substitute(v, secrets, "raw"));
    }

    let body: BodyInit | undefined;
    if (args?.bodyFromFile) {
      if (!ctx.projectId || !ctx.storage) throw new Error("bodyFromFile 只能在專案內的對話使用");
      const r = await ctx.storage.get(ctx.projectId, normalizePath(args.bodyFromFile));
      if (r.size > MAX_REQUEST_BODY) throw new Error("檔案超過 10 MB，無法作為請求內容");
      body = (await ctx.storage.readBytes(r)) as BodyInit;
      if (!headers.has("content-type")) headers.set("content-type", r.mime ?? "application/octet-stream");
    } else if (bodyTemplate !== undefined && method !== "GET" && method !== "HEAD") {
      body = substitute(bodyTemplate, secrets, bodyType === "json" && typeof args.body !== "string" ? "json" : "raw");
      if (!headers.has("content-type")) headers.set("content-type", bodyType === "json" ? "application/json" : "text/plain; charset=utf-8");
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error(`請求逾時（${Math.round(timeoutMs / 1000)} 秒）`)), timeoutMs);
    const onAbort = () => ac.abort(ctx.signal.reason);
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    const started = Date.now();
    try {
      let cur = url;
      let res: Response | undefined;
      let curMethod = method;
      let curBody = body;
      const redirects: string[] = [];
      for (let hop = 0; hop <= 5; hop++) {
        await assertPublicUrl(ctx.fetch, cur.toString(), ac.signal);
        res = await ctx.fetch(cur.toString(), { method: curMethod, headers, body: curBody, redirect: "manual", signal: ac.signal });
        const loc = res.headers.get("location");
        if (res.status >= 300 && res.status < 400 && loc && hop < 5) {
          const next = new URL(loc, cur);
          if (used.length && !used.every((s) => hostAllowed(next.hostname, s.allowedDomains))) break; // keep secrets on allowed hosts
          await res.body?.cancel().catch(() => {});
          redirects.push(next.toString());
          if (res.status === 303 || ((res.status === 301 || res.status === 302) && curMethod === "POST")) {
            curMethod = "GET";
            curBody = undefined;
            headers.delete("content-type");
          }
          cur = next;
          continue;
        }
        break;
      }
      res = res!;
      const ct = (res.headers.get("content-type") ?? "").toLowerCase();
      const outHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        if (KEEP_HEADERS.test(k)) outHeaders[k] = safe(v);
      });
      const base = {
        status: res.status,
        statusText: res.statusText,
        url: safe(cur.toString()),
        ...(redirects.length ? { redirects: redirects.map(safe) } : {}),
        headers: outHeaders,
        durationMs: 0,
      };

      if (args?.saveResponseTo) {
        if (!ctx.projectId || !ctx.storage) throw new Error("saveResponseTo 只能在專案內的對話使用");
        const { bytes, truncated } = await readStream(res, MAX_SAVE, ac.signal);
        if (truncated) throw new Error(`回應超過 ${MAX_SAVE / 1024 / 1024} MB，未保存`);
        const isText = isTextual(ct);
        // Never persist a secret: textual bodies are redacted before saving.
        const data = isText && used.length ? new TextEncoder().encode(safe(new TextDecoder().decode(bytes))) : bytes;
        const row = await ctx.storage.write(ctx.projectId, normalizePath(args.saveResponseTo), data, ct || undefined, ctx.conversationId);
        return { ...base, durationMs: Date.now() - started, savedTo: { path: row.path, fileId: row.id, size: row.size, version: row.version } };
      }

      if (method === "HEAD") return { ...base, durationMs: Date.now() - started, body: null };
      const { bytes, truncated: dlTruncated } = await readStream(res, MAX_DOWNLOAD, ac.signal);
      if (!isTextual(ct)) {
        return { ...base, durationMs: Date.now() - started, body: null, binary: { bytes: bytes.length, contentType: ct, ...(dlTruncated ? { truncated: true } : {}) }, note: "二進位內容未顯示；需要時用 saveResponseTo 存成專案檔。" };
      }
      let text = safe(new TextDecoder().decode(bytes));
      if (/json/.test(ct) && !dlTruncated) {
        try {
          text = JSON.stringify(JSON.parse(text), null, 2);
        } catch {
          /* not valid JSON: keep text */
        }
      }
      const cut = text.length > HTTP_BODY_CAP;
      return {
        ...base,
        durationMs: Date.now() - started,
        body: cut ? `${text.slice(0, HTTP_BODY_CAP)}\n…[已截斷，原長 ${text.length} 字元]` : text,
        ...(cut || dlTruncated ? { truncated: true, note: "回應過長已截斷；完整內容可用 saveResponseTo 存成專案檔後分段讀取。" } : {}),
      };
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
    }
  } catch (e) {
    if (e instanceof BlockedUrlError) throw new Error(safe(`已封鎖：${e.message}`));
    throw new Error(safe(errMsg(e)));
  }
}

export const httpRequestTool: Tool = {
  name: "http_request",
  description:
    "發送任意 HTTP 請求（呼叫 API）。url/headers/query/body 中可寫 {{secret:名稱}}，由伺服器端替換成密鑰值（你看不到真值；可用的密鑰名稱與允許網域列在系統提示「密鑰」段落），" +
    "密鑰只能送往其允許網域。內網位址一律封鎖。回應包含 status、部分標頭與內容（最多 20,000 字元，JSON 會排版）。" +
    "body 可傳 JSON 物件或字串（bodyType=json|text）；bodyFromFile 以專案檔原始位元組作為內容（上傳檔案）；saveResponseTo 把回應存成專案檔（下載檔案、或內容很長時）。",
  risk: "dangerous",
  nonIdempotent: true,
  parameters: {
    type: "object",
    properties: {
      method: { type: "string", enum: METHODS, description: "預設 GET" },
      url: { type: "string" },
      headers: { type: "object", additionalProperties: { type: "string" } },
      query: { type: "object", additionalProperties: { type: "string" }, description: "附加到網址的查詢參數" },
      body: { description: "請求內容：JSON 物件或字串" },
      bodyType: { type: "string", enum: ["json", "text"] },
      bodyFromFile: { type: "string", description: "以此專案檔的內容作為請求本文（僅限專案內對話）" },
      saveResponseTo: { type: "string", description: "把回應內容存到此專案檔路徑（僅限專案內對話）" },
      timeoutSec: { type: "number", minimum: 1, maximum: 60, description: "逾時秒數，預設 30" },
    },
    required: ["url"],
  },
  targets(args: any) {
    const t: { domains?: string[]; paths?: string[] } = {};
    try {
      const host = new URL(String(args?.url ?? "").replace(/\{\{\s*secret:[^}]*\}\}/g, "x")).hostname.toLowerCase();
      if (host) t.domains = [host];
    } catch {
      /* invalid url: no targets */
    }
    const paths = [args?.bodyFromFile, args?.saveResponseTo].filter((p) => typeof p === "string");
    if (paths.length) t.paths = paths;
    return t;
  },
  execute,
};
