// The in-memory S3 mock (server/test/s3-mock.ts) behind a real HTTP port, with permissive CORS for browser presigned PUT/GET.
import http from "node:http";
import { S3Mock } from "../../server/test/s3-mock";

const port = Number(process.env.MOCK_S3_PORT ?? 9000);
const s3 = new S3Mock(`http://127.0.0.1:${port}`, "edgemind");
const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,PUT,POST,HEAD,DELETE", "access-control-allow-headers": "*", "access-control-expose-headers": "etag" };

http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return res.writeHead(204, cors).end();
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks);
  const r = await s3.fetch(`http://127.0.0.1:${port}${req.url}`, { method: req.method, headers, body });
  const out: Record<string, string> = { ...cors };
  r.headers.forEach((v, k) => (out[k] = v));
  res.writeHead(r.status, out);
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(port, "127.0.0.1", () => console.log(`mock S3 on http://127.0.0.1:${port}/edgemind`));
