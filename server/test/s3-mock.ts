/** In-memory path-style S3 for tests: objects, ranges, copy, multipart, bucket CORS. Requires SigV4 auth (header or query). */
import { createHash } from "node:crypto";

export class S3Mock {
  objects = new Map<string, { body: Uint8Array; contentType: string }>();
  uploads = new Map<string, { key: string; parts: Map<number, Uint8Array>; contentType: string }>();
  cors: string | null = null;
  corsCalls = 0;
  requests: { method: string; url: string }[] = [];
  constructor(public endpoint = "http://127.0.0.1:9000", public bucket = "edgemind") {}

  private etag(b: Uint8Array) {
    return `"${createHash("md5").update(b).digest("hex")}"`;
  }

  fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(req.url);
    const method = req.method.toUpperCase();
    this.requests.push({ method, url: url.toString() });
    if (!url.href.startsWith(`${this.endpoint}/${this.bucket}`)) return new Response("wrong bucket", { status: 404 });
    const signed = (req.headers.get("authorization") ?? "").startsWith("AWS4-HMAC-SHA256") || url.searchParams.has("X-Amz-Signature");
    if (!signed) return new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 });
    const key = decodeURIComponent(url.pathname.slice(`/${this.bucket}/`.length));
    const q = url.searchParams;
    const body = method === "GET" || method === "HEAD" ? new Uint8Array(0) : new Uint8Array(await req.arrayBuffer());

    if (url.pathname === `/${this.bucket}` || url.pathname === `/${this.bucket}/`) {
      if (q.has("cors") && method === "PUT") {
        const md5 = createHash("md5").update(body).digest("base64");
        if (req.headers.get("content-md5") !== md5) return new Response("<Error><Code>BadDigest</Code></Error>", { status: 400 });
        this.cors = new TextDecoder().decode(body);
        this.corsCalls++;
        return new Response(null, { status: 200 });
      }
      return new Response("unsupported", { status: 400 });
    }

    if (method === "POST" && q.has("uploads")) {
      const id = `up-${Math.random().toString(36).slice(2)}`;
      this.uploads.set(id, { key, parts: new Map(), contentType: req.headers.get("content-type") ?? "application/octet-stream" });
      return new Response(`<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`, { status: 200 });
    }
    if (method === "PUT" && q.has("partNumber") && q.has("uploadId")) {
      const up = this.uploads.get(q.get("uploadId")!);
      if (!up) return new Response("<Error><Code>NoSuchUpload</Code></Error>", { status: 404 });
      up.parts.set(Number(q.get("partNumber")), body);
      return new Response(null, { status: 200, headers: { etag: this.etag(body) } });
    }
    if (method === "POST" && q.has("uploadId")) {
      const up = this.uploads.get(q.get("uploadId")!);
      if (!up) return new Response("<Error><Code>NoSuchUpload</Code></Error>", { status: 404 });
      const xml = new TextDecoder().decode(body);
      const listed = [...xml.matchAll(/<PartNumber>(\d+)<\/PartNumber><ETag>([^<]+)<\/ETag>/g)].map((m) => ({ n: Number(m[1]), etag: m[2].replace(/&quot;/g, '"') }));
      const chunks: Uint8Array[] = [];
      for (const p of listed) {
        const b = up.parts.get(p.n);
        if (!b || this.etag(b) !== p.etag) return new Response("<Error><Code>InvalidPart</Code><Message>bad etag</Message></Error>", { status: 400 });
        chunks.push(b);
      }
      const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
      let o = 0;
      for (const c of chunks) {
        all.set(c, o);
        o += c.length;
      }
      this.objects.set(up.key, { body: all, contentType: up.contentType });
      this.uploads.delete(q.get("uploadId")!);
      return new Response("<CompleteMultipartUploadResult><ETag>x</ETag></CompleteMultipartUploadResult>", { status: 200 });
    }
    if (method === "DELETE" && q.has("uploadId")) {
      this.uploads.delete(q.get("uploadId")!);
      return new Response(null, { status: 204 });
    }
    if (method === "PUT") {
      const src = req.headers.get("x-amz-copy-source");
      if (src) {
        const srcKey = decodeURIComponent(src.replace(new RegExp(`^/${this.bucket}/`), ""));
        const o = this.objects.get(srcKey);
        if (!o) return new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
        this.objects.set(key, { body: o.body.slice(), contentType: o.contentType });
        return new Response("<CopyObjectResult/>", { status: 200 });
      }
      this.objects.set(key, { body, contentType: req.headers.get("content-type") ?? "application/octet-stream" });
      return new Response(null, { status: 200, headers: { etag: this.etag(body) } });
    }
    const o = this.objects.get(key);
    if (method === "DELETE") {
      this.objects.delete(key);
      return new Response(null, { status: 204 });
    }
    if (!o) return new Response("<Error><Code>NoSuchKey</Code><Message>missing</Message></Error>", { status: 404 });
    if (method === "HEAD") return new Response(null, { status: 200, headers: { "content-length": String(o.body.length), etag: this.etag(o.body), "content-type": o.contentType } });
    const range = req.headers.get("range")?.match(/bytes=(\d+)-(\d*)/);
    if (range) {
      const start = Number(range[1]);
      if (start >= o.body.length) return new Response("<Error><Code>InvalidRange</Code></Error>", { status: 416 });
      const end = range[2] ? Math.min(Number(range[2]), o.body.length - 1) : o.body.length - 1;
      return new Response(o.body.slice(start, end + 1) as BodyInit, { status: 206, headers: { "content-type": o.contentType } });
    }
    return new Response(o.body as BodyInit, { status: 200, headers: { "content-type": o.contentType } });
  }) as typeof fetch;

  text(key: string) {
    const o = this.objects.get(key);
    return o ? new TextDecoder().decode(o.body) : undefined;
  }
}
