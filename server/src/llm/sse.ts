/**
 * Server-Sent Events parser (WHATWG spec semantics) over a byte stream.
 * - Handles LF, CRLF and lone CR line endings, chunks split anywhere (incl. inside UTF-8 sequences),
 *   a leading BOM, comments (`:`), multi-line `data:`, and a final event without a trailing blank line
 *   (some providers end the body without one).
 */
export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

export async function* parseSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  let first = true;
  let eventName = "";
  let data: string[] = [];
  let id: string | undefined;
  let sawField = false;
  let finished = false;

  const onAbort = () => void reader.cancel().catch(() => {});
  signal?.addEventListener("abort", onAbort, { once: true });

  function* processLine(line: string): Generator<SseEvent> {
    if (line === "") {
      if (sawField && data.length) yield { event: eventName || "message", data: data.join("\n"), id };
      eventName = "";
      data = [];
      sawField = false;
      return;
    }
    if (line.startsWith(":")) return;
    const i = line.indexOf(":");
    const field = i === -1 ? line : line.slice(0, i);
    let value = i === -1 ? "" : line.slice(i + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    sawField = true;
    if (field === "data") data.push(value);
    else if (field === "event") eventName = value;
    else if (field === "id") id = value;
  }

  try {
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        break;
      }
      buf += decoder.decode(value, { stream: true });
      if (first && buf.length) {
        if (buf.charCodeAt(0) === 0xfeff) buf = buf.slice(1);
        first = false;
      }
      // Split on any line terminator; keep a trailing partial line (and a trailing lone CR, which may be half of CRLF).
      let start = 0;
      for (let j = 0; j < buf.length; j++) {
        const ch = buf.charCodeAt(j);
        if (ch === 10 || ch === 13) {
          if (ch === 13 && j === buf.length - 1) break; // wait for possible LF
          const line = buf.slice(start, j);
          if (ch === 13 && buf.charCodeAt(j + 1) === 10) j++;
          start = j + 1;
          yield* processLine(line);
        }
      }
      buf = buf.slice(start);
    }
    buf += decoder.decode();
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    // Flush remaining lines + a final unterminated event.
    for (const line of buf.split(/\r\n|\r|\n/)) yield* processLine(line);
    yield* processLine("");
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (!finished) await reader.cancel().catch(() => {});
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}
