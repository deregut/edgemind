/**
 * HTTP layer for LLM adapters: retries with exponential backoff (+ Retry-After) on 408/409/429/5xx/529 and
 * network errors, abort support, and secret scrubbing in error messages. Retries only happen before any
 * byte of a streamed body has been consumed; mid-stream failures surface as `error` events.
 */
import type { LlmErrorInfo } from "@edgemind/shared";

export type Fetch = typeof fetch;

export class LlmError extends Error {
  constructor(public info: LlmErrorInfo) {
    super(info.message);
  }
}

export interface RetryOptions {
  maxRetries?: number; // default 3
  baseDelayMs?: number; // default 500
  maxDelayMs?: number; // default 20_000
  /** Injectable for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Called before each retry (logging / tests). */
  onRetry?: (attempt: number, delayMs: number, reason: string) => void;
}

export const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 520, 522, 524, 529]);

export function abortError(signal?: AbortSignal): LlmError {
  const r = signal?.reason;
  return new LlmError({ message: r instanceof Error && r.message ? r.message : "已中止", code: "aborted", retryable: false });
}

export function isAbort(e: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return e instanceof DOMException ? e.name === "AbortError" : (e as Error)?.name === "AbortError";
}

export const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

function retryAfterMs(res: Response): number | undefined {
  const ms = res.headers.get("retry-after-ms");
  if (ms && !isNaN(Number(ms))) return Number(ms);
  const h = res.headers.get("retry-after");
  if (!h) return undefined;
  if (!isNaN(Number(h))) return Number(h) * 1000;
  const d = Date.parse(h);
  return isNaN(d) ? undefined : Math.max(0, d - Date.now());
}

export function scrub(text: string, secrets: (string | null | undefined)[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join("***");
  return out;
}

/** Extract a readable message from a provider error body (OpenAI / Anthropic / Gemini shapes). */
export function errorMessageFromBody(text: string): { message: string; code?: string } {
  try {
    const j = JSON.parse(text);
    const e = Array.isArray(j) ? j[0]?.error : j?.error ?? j;
    if (e && typeof e === "object") {
      const message = e.message ?? e.error?.message ?? JSON.stringify(e).slice(0, 300);
      const code = e.code ?? e.type ?? e.status;
      return { message: String(message), code: code !== undefined ? String(code) : undefined };
    }
    if (typeof e === "string") return { message: e };
  } catch {
    /* not JSON */
  }
  return { message: text.slice(0, 300) };
}

/**
 * POST JSON and return the (successful) response, retrying transient failures.
 * Throws LlmError for non-retryable/exhausted failures and aborts.
 */
export async function postWithRetry(
  f: Fetch,
  url: string,
  init: { headers: Record<string, string>; body: unknown },
  opts: RetryOptions & { signal?: AbortSignal; secrets?: (string | null | undefined)[] } = {},
): Promise<Response> {
  const maxRetries = opts.maxRetries ?? 3;
  const base = opts.baseDelayMs ?? 500;
  const maxDelay = opts.maxDelayMs ?? 20_000;
  const sleep = opts.sleep ?? defaultSleep;
  const body = JSON.stringify(init.body);
  for (let attempt = 0; ; attempt++) {
    if (opts.signal?.aborted) throw abortError(opts.signal);
    let res: Response;
    try {
      res = await f(url, { method: "POST", headers: { "content-type": "application/json", ...init.headers }, body, signal: opts.signal });
    } catch (e) {
      if (isAbort(e, opts.signal)) throw abortError(opts.signal);
      const message = `無法連線：${scrub((e as Error).message ?? String(e), opts.secrets ?? [])}`;
      if (attempt >= maxRetries) throw new LlmError({ message, code: "network", retryable: true });
      const delay = Math.min(maxDelay, base * 2 ** attempt * (0.8 + Math.random() * 0.4));
      opts.onRetry?.(attempt + 1, delay, "network");
      await sleep(delay, opts.signal).catch(() => {
        throw abortError(opts.signal);
      });
      continue;
    }
    if (res.ok) return res;
    const text = await res.text().catch(() => "");
    const parsed = errorMessageFromBody(text);
    const retryable = RETRYABLE_STATUS.has(res.status);
    if (!retryable || attempt >= maxRetries) {
      throw new LlmError({
        message: `HTTP ${res.status}：${scrub(parsed.message || res.statusText, opts.secrets ?? [])}`,
        status: res.status,
        code: parsed.code,
        retryable,
      });
    }
    const delay = Math.min(maxDelay, retryAfterMs(res) ?? base * 2 ** attempt * (0.8 + Math.random() * 0.4));
    opts.onRetry?.(attempt + 1, delay, `HTTP ${res.status}`);
    await sleep(delay, opts.signal).catch(() => {
      throw abortError(opts.signal);
    });
  }
}
