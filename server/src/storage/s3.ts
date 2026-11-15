/**
 * Minimal S3 client on aws4fetch (SigV4, edge-compatible): object CRUD, ranged reads, server-side copy,
 * presigned URLs (browser-direct PUT / multipart parts / GET), multipart lifecycle, bucket CORS.
 * Path-style addressing (`{endpoint}/{bucket}/{key}`) by default — supported by R2, MinIO, B2, Neon Object Storage and AWS;
 * S3_FORCE_PATH_STYLE=false switches to virtual-hosted style (`{scheme}://{bucket}.{endpoint host}/{key}`).
 */
import { AwsClient } from "aws4fetch";
import type { AppEnv } from "../env";
import { md5Base64 } from "../lib/md5";

export type Fetch = typeof fetch;

export class S3Error extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

const xmlTag = (xml: string, tag: string) => xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1];
const xmlEscape = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);

export function encodeKey(key: string): string {
  return key.split("/").map((s) => encodeURIComponent(s)).join("/");
}

export class S3 {
  private aws: AwsClient;
  private base: string;
  private bucket: string;
  private pathStyle: boolean;

  constructor(env: Pick<AppEnv, "S3_ENDPOINT" | "S3_BUCKET" | "S3_REGION" | "S3_ACCESS_KEY_ID" | "S3_SECRET_ACCESS_KEY" | "S3_FORCE_PATH_STYLE">, private f: Fetch = (...a) => fetch(...a)) {
    this.aws = new AwsClient({ accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY, service: "s3", region: env.S3_REGION || "auto", retries: 0 });
    this.bucket = env.S3_BUCKET;
    const endpoint = env.S3_ENDPOINT.replace(/\/+$/, "");
    const pathStyle = (this.pathStyle = !["false", "0"].includes((env.S3_FORCE_PATH_STYLE ?? "").trim().toLowerCase()));
    if (pathStyle) {
      this.base = `${endpoint}/${encodeURIComponent(env.S3_BUCKET)}`;
    } else {
      const u = new URL(endpoint);
      u.hostname = `${env.S3_BUCKET}.${u.hostname}`;
      this.base = u.toString().replace(/\/+$/, "");
    }
  }

  url(key: string, query?: Record<string, string>): string {
    const u = `${this.base}/${encodeKey(key)}`;
    return query && Object.keys(query).length ? `${u}?${new URLSearchParams(query)}` : u;
  }

  private async send(url: string, init: RequestInit, okStatuses = [200, 204, 206]): Promise<Response> {
    const req = await this.aws.sign(url, init);
    const res = await this.f(req);
    if (!okStatuses.includes(res.status)) {
      const text = await res.text().catch(() => "");
      throw new S3Error(res.status, xmlTag(text, "Code") ?? "S3Error", `S3 ${init.method ?? "GET"} 失敗（HTTP ${res.status}${xmlTag(text, "Message") ? `：${xmlTag(text, "Message")}` : ""}）`);
    }
    return res;
  }

  async put(key: string, body: Uint8Array | string, contentType = "application/octet-stream"): Promise<{ etag: string | null }> {
    const res = await this.send(this.url(key), { method: "PUT", body: body as BodyInit, headers: { "content-type": contentType } });
    return { etag: res.headers.get("etag") };
  }

  /** GET (optionally a byte range, inclusive end). Returns null for 404. */
  async get(key: string, range?: { start: number; end?: number }): Promise<Response | null> {
    const headers: Record<string, string> = {};
    if (range) headers.range = `bytes=${range.start}-${range.end ?? ""}`;
    try {
      return await this.send(this.url(key), { method: "GET", headers });
    } catch (e) {
      if (e instanceof S3Error && (e.status === 404 || e.code === "NoSuchKey")) return null;
      if (e instanceof S3Error && e.status === 416) return new Response(new Uint8Array(0), { status: 206 });
      throw e;
    }
  }

  async getBytes(key: string, range?: { start: number; end?: number }): Promise<Uint8Array | null> {
    const res = await this.get(key, range);
    return res ? new Uint8Array(await res.arrayBuffer()) : null;
  }

  async head(key: string): Promise<{ size: number; etag: string | null; contentType: string | null } | null> {
    const req = await this.aws.sign(this.url(key), { method: "HEAD" });
    const res = await this.f(req);
    if (res.status === 404) return null;
    if (!res.ok) throw new S3Error(res.status, "S3Error", `S3 HEAD 失敗（HTTP ${res.status}）`);
    return { size: Number(res.headers.get("content-length") ?? 0), etag: res.headers.get("etag"), contentType: res.headers.get("content-type") };
  }

  async delete(key: string): Promise<void> {
    await this.send(this.url(key), { method: "DELETE" }, [200, 204, 404]);
  }

  async copy(srcKey: string, dstKey: string): Promise<void> {
    await this.send(this.url(dstKey), { method: "PUT", headers: { "x-amz-copy-source": `/${encodeURIComponent(this.bucket)}/${encodeKey(srcKey)}` } });
  }

  /** Presigned URL (query-string SigV4) for browser-direct access. */
  async presign(method: "GET" | "PUT", key: string, expiresSec = 3600, query: Record<string, string> = {}, headers: Record<string, string> = {}): Promise<string> {
    const req = await this.aws.sign(this.url(key, { ...query, "X-Amz-Expires": String(expiresSec) }), { method, headers, aws: { signQuery: true } });
    return req.url;
  }

  async createMultipart(key: string, contentType: string): Promise<string> {
    const res = await this.send(this.url(key, { uploads: "" }), { method: "POST", headers: { "content-type": contentType } });
    const id = xmlTag(await res.text(), "UploadId");
    if (!id) throw new S3Error(500, "NoUploadId", "S3 沒有回傳 UploadId");
    return id;
  }

  presignPart(key: string, uploadId: string, partNumber: number, expiresSec = 6 * 3600): Promise<string> {
    return this.presign("PUT", key, expiresSec, { partNumber: String(partNumber), uploadId });
  }

  async completeMultipart(key: string, uploadId: string, parts: { partNumber: number; etag: string }[]): Promise<void> {
    const body = `<CompleteMultipartUpload>${parts
      .sort((a, b) => a.partNumber - b.partNumber)
      .map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${xmlEscape(p.etag)}</ETag></Part>`)
      .join("")}</CompleteMultipartUpload>`;
    const res = await this.send(this.url(key, { uploadId }), { method: "POST", body, headers: { "content-type": "application/xml" } });
    // S3 may return 200 with an <Error> body.
    const text = await res.text();
    if (text.includes("<Error>")) throw new S3Error(500, xmlTag(text, "Code") ?? "S3Error", `完成分段上傳失敗：${xmlTag(text, "Message") ?? ""}`);
  }

  async abortMultipart(key: string, uploadId: string): Promise<void> {
    await this.send(this.url(key, { uploadId }), { method: "DELETE" }, [200, 204, 404]);
  }

  /** Replace the bucket CORS config so browsers on `origins` can PUT/GET directly (ETag exposed for multipart). */
  async putBucketCors(origins: string[]): Promise<void> {
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?><CORSConfiguration><CORSRule>` +
      origins.map((o) => `<AllowedOrigin>${xmlEscape(o)}</AllowedOrigin>`).join("") +
      `<AllowedMethod>GET</AllowedMethod><AllowedMethod>PUT</AllowedMethod><AllowedMethod>HEAD</AllowedMethod>` +
      `<AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader><MaxAgeSeconds>3600</MaxAgeSeconds></CORSRule></CORSConfiguration>`;
    await this.send(`${this.base}${this.pathStyle ? "" : "/"}?cors=`, { method: "PUT", body: xml, headers: { "content-type": "application/xml", "content-md5": md5Base64(new TextEncoder().encode(xml)) } });
  }
}
