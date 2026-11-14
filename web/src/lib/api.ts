import { CSRF_COOKIE, CSRF_HEADER } from "@edgemind/shared";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public body?: unknown) {
    super(message);
  }
}

function readCookie(name: string): string | undefined {
  return document.cookie.split("; ").find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1);
}

/** fetch wrapper: JSON in/out, same-origin cookies, CSRF double-submit header on mutations. */
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? "GET";
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET" && method !== "HEAD") {
    const token = readCookie(CSRF_COOKIE);
    if (token) headers[CSRF_HEADER] = decodeURIComponent(token);
  }
  const res = await fetch(`/api${path}`, {
    method,
    headers,
    credentials: "same-origin",
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let data: any = undefined;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    if (res.status === 401 && path !== "/auth/login") window.dispatchEvent(new Event("em:unauthorized"));
    throw new ApiError(res.status, data?.error ?? "http_error", data?.message ?? `請求失敗（HTTP ${res.status}）`, data);
  }
  return data as T;
}

/** Raw-body POST (e.g. a zip upload) with the CSRF header; JSON response. */
export async function apiUpload<T>(path: string, body: Blob, contentType: string): Promise<T> {
  const token = readCookie(CSRF_COOKIE);
  const headers: Record<string, string> = { "content-type": contentType };
  if (token) headers[CSRF_HEADER] = decodeURIComponent(token);
  const res = await fetch(`/api${path}`, { method: "POST", headers, credentials: "same-origin", body });
  const data: any = await res.json().catch(() => undefined);
  if (!res.ok) throw new ApiError(res.status, data?.error ?? "http_error", data?.message ?? `請求失敗（HTTP ${res.status}）`, data);
  return data as T;
}
