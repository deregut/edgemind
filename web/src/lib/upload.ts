/** Browser-direct uploads to S3 via presigned URLs (single PUT or multipart). The server never proxies bytes. */
import type { FileDTO, UploadTicket } from "@edgemind/shared";
import { api } from "./api";

export interface UploadTarget {
  scope: "project" | "upload";
  projectId?: string | null;
  conversationId?: string | null;
  /** project-relative path (scope = project) */
  path?: string;
}

function putWithProgress(url: string, body: Blob, headers: Record<string, string>, onProgress?: (loaded: number) => void, signal?: AbortSignal): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => onProgress?.(e.loaded);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve(xhr.getResponseHeader("etag")) : reject(new Error(`上傳失敗（HTTP ${xhr.status}）`)));
    xhr.onerror = () => reject(new TypeError("network"));
    xhr.onabort = () => reject(new DOMException("aborted", "AbortError"));
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(body);
  });
}

async function sha256Hex(file: Blob): Promise<string | undefined> {
  if (file.size > 64 * 1024 * 1024 || !crypto.subtle) return undefined;
  const d = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type TicketSource = () => Promise<UploadTicket>;

async function attempt(file: File, getTicket: TicketSource, onProgress?: (fraction: number) => void, signal?: AbortSignal): Promise<FileDTO> {
  const ticket = await getTicket();
  try {
    if (ticket.method === "put") {
      await putWithProgress(ticket.url, file, ticket.headers, (l) => onProgress?.(l / Math.max(1, file.size)), signal);
      return await api<FileDTO>(`/uploads/${ticket.fileId}/complete`, { method: "POST", body: { sha256: await sha256Hex(file) } });
    }
    const loaded = new Map<number, number>();
    const report = () => onProgress?.([...loaded.values()].reduce((a, b) => a + b, 0) / Math.max(1, file.size));
    const etags: { partNumber: number; etag: string }[] = [];
    const queue = [...ticket.parts];
    const worker = async () => {
      for (let p = queue.shift(); p; p = queue.shift()) {
        const blob = file.slice((p.partNumber - 1) * ticket.partSize, p.partNumber * ticket.partSize);
        let etag: string | null = null;
        for (let tries = 0; ; tries++) {
          try {
            etag = await putWithProgress(p.url, blob, {}, (l) => { loaded.set(p!.partNumber, l); report(); }, signal);
            break;
          } catch (e) {
            if (tries >= 2 || signal?.aborted) throw e;
          }
        }
        if (!etag) throw new Error("無法讀取 ETag：請確認 Bucket CORS 有 ExposeHeaders: ETag");
        etags.push({ partNumber: p.partNumber, etag });
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, ticket.parts.length) }, worker));
    return await api<FileDTO>(`/uploads/${ticket.fileId}/complete`, { method: "POST", body: { parts: etags } });
  } catch (e) {
    await api(`/uploads/${ticket.fileId}/abort`, { method: "POST", body: {} }).catch(() => {});
    throw e;
  }
}

/** Upload one file; on a CORS/network failure re-applies bucket CORS for this origin and retries once. */
export async function uploadFile(file: File, target: UploadTarget, onProgress?: (fraction: number) => void, signal?: AbortSignal): Promise<FileDTO> {
  const getTicket: TicketSource = () =>
    api<UploadTicket>("/uploads", { method: "POST", body: { ...target, name: file.name, size: file.size, mime: file.type || undefined } });
  return uploadWithTicket(file, getTicket, onProgress, signal);
}

/** Same as uploadFile, with the presigned ticket coming from any endpoint (e.g. knowledge-base documents). */
export async function uploadWithTicket(file: File, getTicket: TicketSource, onProgress?: (fraction: number) => void, signal?: AbortSignal): Promise<FileDTO> {
  try {
    return await attempt(file, getTicket, onProgress, signal);
  } catch (e) {
    if (!(e instanceof TypeError) || signal?.aborted) throw e;
    await api("/storage/cors", { method: "POST", body: { origin: location.origin } }).catch(() => {});
    try {
      return await attempt(file, getTicket, onProgress, signal);
    } catch (e2) {
      if (e2 instanceof TypeError) throw new Error("無法直接上傳到物件儲存（可能是 Bucket CORS 未設定），請到 設定 → 儲存空間 檢查。");
      throw e2;
    }
  }
}
