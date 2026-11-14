/**
 * Project files on S3 (`projects/{pid}/files/{path}`) with history in `file_versions`
 * (previous contents copied to `projects/{pid}/versions/{fileId}/v{n}` before every overwrite / delete),
 * chat attachments (`users/1/uploads/{uuid}/{name}`), and resolution of `fileId` message parts for the model.
 */
import { and, asc, desc, eq, like } from "drizzle-orm";
import type { FileDTO, Part } from "@edgemind/shared";
import type { Database } from "../db/client";
import { files, fileVersions } from "../db/schema";
import { BadInput } from "../lib/errors";
import { b64encode } from "../lib/crypto";
import { S3 } from "./s3";

export type FileRow = typeof files.$inferSelect;

export const MAX_FILE_WRITE_BYTES = 5 * 1024 * 1024;
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|ya?ml|toml|xml|html?|css|scss|js|jsx|ts|tsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|sh|bash|sql|ini|cfg|conf|log|env|vue|svelte|tex|r|lua|dart|scala|graphql|proto|svg)$/i;

export function isTextMime(mime: string | null | undefined, path = ""): boolean {
  if (mime && (/^text\//.test(mime) || /(json|xml|yaml|javascript|typescript|csv|sql|x-sh|toml|svg)/.test(mime))) return true;
  return TEXT_EXT.test(path);
}

const MIME_BY_EXT: Record<string, string> = {
  md: "text/markdown", markdown: "text/markdown", txt: "text/plain", csv: "text/csv", json: "application/json", html: "text/html", htm: "text/html",
  css: "text/css", js: "text/javascript", mjs: "text/javascript", ts: "text/plain", tsx: "text/plain", py: "text/x-python", xml: "application/xml",
  yaml: "application/yaml", yml: "application/yaml", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", pdf: "application/pdf", sql: "application/sql", sh: "application/x-sh", toml: "application/toml",
};
export function guessMime(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? (TEXT_EXT.test(path) ? "text/plain" : "application/octet-stream");
}

/** Normalize a project-relative path: no leading slash, no `.`/`..` segments, no control characters. */
export function normalizePath(p: unknown, opts: { allowEmpty?: boolean } = {}): string {
  if (typeof p !== "string") throw new BadInput("path 必須是字串");
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\\]/.test(p)) throw new BadInput("路徑含有不允許的字元");
  const segs = p.split("/").filter((s) => s && s !== ".");
  if (segs.some((s) => s === "..")) throw new BadInput("路徑不可包含 ..");
  const out = segs.join("/");
  if (!out && !opts.allowEmpty) throw new BadInput("路徑不可為空");
  if (out.length > 500) throw new BadInput("路徑過長");
  return out;
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const projectFileKey = (pid: string, path: string) => `projects/${pid}/files/${path}`;
export const versionKey = (pid: string, fileId: string, v: number) => `projects/${pid}/versions/${fileId}/v${v}`;

export function toFileDTO(r: FileRow): FileDTO {
  return {
    id: r.id, projectId: r.projectId, conversationId: r.conversationId, scope: r.scope, path: r.path, mime: r.mime, size: r.size,
    version: r.version, status: r.status, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
  };
}

/** Decode a UTF-8 byte window, never splitting a multi-byte character. Returns text + bytes consumed. */
export function decodeUtf8Window(bytes: Uint8Array, isLastWindow: boolean): { text: string; used: number; skipped: number } {
  let start = 0;
  while (start < bytes.length && start < 3 && (bytes[start] & 0xc0) === 0x80) start++; // began mid-character
  let end = bytes.length;
  if (!isLastWindow) {
    // back off an incomplete trailing sequence
    let i = end - 1;
    let cont = 0;
    while (i >= start && (bytes[i] & 0xc0) === 0x80 && cont < 3) {
      i--;
      cont++;
    }
    if (i >= start) {
      const lead = bytes[i];
      const need = lead >= 0xf0 ? 3 : lead >= 0xe0 ? 2 : lead >= 0xc0 ? 1 : 0;
      if (need > cont) end = i;
    }
  }
  return { text: new TextDecoder().decode(bytes.subarray(start, end)), used: end, skipped: start };
}

export class FileStore {
  constructor(public database: Database, public s3: S3) {}

  private get db() {
    return this.database.db;
  }

  async find(pid: string, path: string): Promise<FileRow | undefined> {
    const [r] = await this.db.select().from(files).where(and(eq(files.projectId, pid), eq(files.scope, "project"), eq(files.path, path))).limit(1);
    return r;
  }

  async get(pid: string, path: string): Promise<FileRow> {
    const r = await this.find(pid, path);
    if (!r || r.status !== "ready") throw new BadInput(`找不到檔案：${path}`);
    return r;
  }

  async byId(id: string): Promise<FileRow | undefined> {
    const [r] = await this.db.select().from(files).where(eq(files.id, id)).limit(1);
    return r;
  }

  async list(pid: string, dir = "", recursive = true): Promise<FileRow[]> {
    const prefix = dir ? `${dir.replace(/\/+$/, "")}/` : "";
    const rows = await this.db.select().from(files)
      .where(and(eq(files.projectId, pid), eq(files.scope, "project"), eq(files.status, "ready"), prefix ? like(files.path, `${prefix.replace(/[\\%_]/g, (m) => `\\${m}`)}%`) : undefined))
      .orderBy(asc(files.path));
    return recursive ? rows : rows.filter((r) => !r.path.slice(prefix.length).includes("/"));
  }

  /** Copy the current object to its version key and record it (before overwrite / delete). */
  async snapshot(r: FileRow): Promise<void> {
    if (r.status !== "ready" || !r.projectId) return;
    const key = versionKey(r.projectId, r.id, r.version);
    await this.s3.copy(r.s3Key, key);
    await this.db.insert(fileVersions).values({ fileId: r.id, version: r.version, s3Key: key, size: r.size, sha256: r.sha256 }).onConflictDoNothing();
  }

  async write(pid: string, rawPath: string, data: Uint8Array, mime?: string, conversationId?: string | null): Promise<FileRow> {
    const path = normalizePath(rawPath);
    if (data.length > MAX_FILE_WRITE_BYTES) throw new BadInput(`檔案超過 ${MAX_FILE_WRITE_BYTES / 1024 / 1024} MB`);
    const key = projectFileKey(pid, path);
    const sha = await sha256Hex(data);
    const ct = mime ?? guessMime(path);
    const existing = await this.find(pid, path);
    if (existing) {
      if (existing.status === "ready") {
        if (existing.sha256 === sha) return existing; // unchanged
        await this.snapshot(existing);
      }
      await this.s3.put(key, data, ct);
      const [r] = await this.db.update(files)
        .set({ size: data.length, sha256: sha, mime: ct, version: existing.status === "ready" || existing.status === "deleted" ? existing.version + 1 : existing.version, status: "ready", uploadId: null, updatedAt: new Date() })
        .where(eq(files.id, existing.id)).returning();
      return r;
    }
    await this.s3.put(key, data, ct);
    const [r] = await this.db.insert(files).values({ projectId: pid, conversationId: conversationId ?? null, scope: "project", path, s3Key: key, mime: ct, size: data.length, sha256: sha }).returning();
    return r;
  }

  async readBytes(r: FileRow, range?: { start: number; end?: number }): Promise<Uint8Array> {
    const b = await this.s3.getBytes(r.s3Key, range);
    if (!b) throw new BadInput(`儲存空間中找不到檔案：${r.path}`);
    return b;
  }

  async delete(pid: string, rawPath: string): Promise<FileRow> {
    const r = await this.get(pid, normalizePath(rawPath));
    await this.snapshot(r);
    await this.s3.delete(r.s3Key);
    const [d] = await this.db.update(files).set({ status: "deleted", updatedAt: new Date() }).where(eq(files.id, r.id)).returning();
    return d;
  }

  async versions(fileId: string) {
    return this.db.select().from(fileVersions).where(eq(fileVersions.fileId, fileId)).orderBy(desc(fileVersions.version));
  }

  async restore(fileId: string, version: number): Promise<FileRow> {
    const r = await this.byId(fileId);
    if (!r || !r.projectId) throw new BadInput("找不到檔案");
    const [v] = await this.db.select().from(fileVersions).where(and(eq(fileVersions.fileId, fileId), eq(fileVersions.version, version))).limit(1);
    if (!v) throw new BadInput("找不到此版本");
    await this.snapshot(r);
    await this.s3.copy(v.s3Key, r.s3Key);
    const [n] = await this.db.update(files)
      .set({ size: v.size, sha256: v.sha256, version: r.version + 1, status: "ready", updatedAt: new Date() })
      .where(eq(files.id, r.id)).returning();
    return n;
  }

  /** Remove every object of a project (current files + versions). */
  async purgeProject(pid: string): Promise<void> {
    const rows = await this.db.select().from(files).where(eq(files.projectId, pid));
    for (const r of rows) {
      if (r.uploadId) await this.s3.abortMultipart(r.s3Key, r.uploadId).catch(() => {});
      await this.s3.delete(r.s3Key).catch(() => {});
      for (const v of await this.versions(r.id)) await this.s3.delete(v.s3Key).catch(() => {});
    }
  }
}

// ---------------- fileId → model-ready part ----------------

const MAX_TEXT_CHARS = 200_000;
const MAX_INLINE_BINARY = 15 * 1024 * 1024;

/** Turn a `{type:"file", fileId}` part into inline text / base64 (image → image part) for the provider. */
export async function resolveFilePart(store: FileStore, part: Extract<Part, { type: "file" }>): Promise<Part> {
  if (!part.fileId || part.data || part.text !== undefined || part.url) return part;
  const r = await store.byId(part.fileId);
  if (!r || r.status !== "ready") return { type: "text", text: `[附件：${part.name}（檔案已不存在）]` };
  const mime = r.mime ?? part.mime;
  if (isTextMime(mime, r.path)) {
    const bytes = await store.readBytes(r, { start: 0, end: MAX_TEXT_CHARS * 4 - 1 });
    let text = decodeUtf8Window(bytes, bytes.length >= r.size).text;
    if (text.length > MAX_TEXT_CHARS || bytes.length < r.size) text = `${text.slice(0, MAX_TEXT_CHARS)}\n…[檔案過長，只提供前段；完整內容約 ${r.size} 位元組]`;
    return { type: "file", fileId: r.id, name: part.name, mime, text };
  }
  if (r.size > MAX_INLINE_BINARY) return { type: "text", text: `[附件：${part.name}（${mime}，${r.size} 位元組，過大無法直接提供給模型）]` };
  const data = b64encode(await store.readBytes(r));
  if (mime.startsWith("image/")) return { type: "image", mime, data };
  return { type: "file", fileId: r.id, name: part.name, mime, data };
}
