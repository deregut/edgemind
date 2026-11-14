import { CSRF_COOKIE, CSRF_HEADER, type AgentEvent } from "@edgemind/shared";
import { ApiError } from "./api";

function csrf(): Record<string, string> {
  const t = document.cookie.split("; ").find((c) => c.startsWith(`${CSRF_COOKIE}=`))?.slice(CSRF_COOKIE.length + 1);
  return t ? { [CSRF_HEADER]: decodeURIComponent(t) } : {};
}

export type ChatPostResult = { kind: "stream" } | { kind: "accepted"; body: { runId: string; conversationId: string; userMessageId?: string; status: string } };

/**
 * POST /api/chat. SSE responses are parsed and handed to `onEvent` until the stream ends;
 * 202 (background mode) returns the JSON body.
 */
export async function postChat(body: unknown, onEvent: (e: AgentEvent) => void, signal?: AbortSignal): Promise<ChatPostResult> {
  const res = await fetch("/api/chat", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", accept: "text/event-stream", ...csrf() },
    body: JSON.stringify(body),
    signal,
  });
  const ct = res.headers.get("content-type") ?? "";
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) window.dispatchEvent(new Event("em:unauthorized"));
    throw new ApiError(res.status, data?.error ?? "http_error", data?.message ?? `請求失敗（HTTP ${res.status}）`, data);
  }
  if (!ct.includes("text/event-stream")) return { kind: "accepted", body: await res.json() };
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += value.replace(/\r\n?/g, "\n");
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n");
      if (!data) continue;
      try {
        onEvent(JSON.parse(data) as AgentEvent);
      } catch {
        /* malformed event */
      }
    }
  }
  return { kind: "stream" };
}

export function download(filename: string, content: Blob) {
  const url = URL.createObjectURL(content);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
