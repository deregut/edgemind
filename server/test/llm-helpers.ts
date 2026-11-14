import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/llm/${name}`, import.meta.url)), "utf8");

/** Byte stream that delivers `text` in pieces of `size` bytes (splits UTF-8 sequences and CRLF pairs). */
export function chunkedStream(text: string, size = 7, opts: { delayMs?: number; signal?: AbortSignal } = {}): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let i = 0;
  return new ReadableStream({
    async pull(ctrl) {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (i >= bytes.length) return ctrl.close();
      ctrl.enqueue(bytes.slice(i, i + size));
      i += size;
    },
  });
}

export function sseResponse(text: string, size = 7, opts: { delayMs?: number; status?: number } = {}) {
  return new Response(chunkedStream(text, size, opts), { status: opts.status ?? 200, headers: { "content-type": "text/event-stream" } });
}

export type Captured = { url: string; headers: Record<string, string>; body: any };

/** fetch mock: returns queued responses in order; records requests. Honors AbortSignal. */
export function queueFetch(responses: (Response | (() => Response) | Error)[]) {
  const calls: Captured[] = [];
  const f = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    if (init.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    calls.push({ url: String(input), headers: Object.fromEntries(new Headers(init.headers).entries()), body: init.body ? JSON.parse(String(init.body)) : undefined });
    const next = responses.shift();
    if (!next) throw new Error("no more mocked responses");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next() : next;
  }) as typeof fetch;
  return { fetch: f, calls };
}

export const noSleep = { sleep: async () => {}, baseDelayMs: 1 };
