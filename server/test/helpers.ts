import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../src/db/schema";
import type { AppDb, Database } from "../src/db/client";
import type { AppEnv } from "../src/env";
import { useNodeQuickJS } from "../src/sandbox/quickjs-node";

useNodeQuickJS();

export const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:54329/postgres";

/** Creates an isolated throwaway database (real Postgres + pgvector). */
export async function createTestDatabase(): Promise<{ database: Database; url: string; drop(): Promise<void> }> {
  const name = `edgemind_t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = ADMIN_URL.replace(/\/[^/]*$/, `/${name}`);
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  const database: Database = {
    db: drizzle({ client: pool, schema }) as unknown as AppDb,
    async execTransaction(statements) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        for (const s of statements) await client.query(s);
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    },
    async query<T>(text: string, params: unknown[] = []) {
      return (await pool.query(text, params)).rows as T[];
    },
  };
  return {
    database,
    url,
    async drop() {
      await pool.end();
      const a = new pg.Client({ connectionString: ADMIN_URL });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}

export function testEnv(url: string): AppEnv & Record<string, string> {
  return {
    DATABASE_URL: url,
    S3_ENDPOINT: "http://127.0.0.1:9000",
    S3_BUCKET: "edgemind",
    S3_REGION: "us-east-1",
    S3_ACCESS_KEY_ID: "test",
    S3_SECRET_ACCESS_KEY: "testsecret",
    ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    JWT_SECRET: "x".repeat(40),
  };
}

/** Minimal browser-like client: cookie jar + automatic CSRF header, against app.request(). */
export class TestClient {
  cookies = new Map<string, string>();
  constructor(private app: { request: (path: string, init: RequestInit, env: Record<string, unknown>) => Response | Promise<Response> }, private env: Record<string, unknown>, public ip = "1.2.3.4") {}
  async req(method: string, path: string, body?: unknown, opts: { csrf?: boolean; headers?: Record<string, string>; bytes?: boolean } = {}) {
    const headers: Record<string, string> = { "x-forwarded-for": this.ip, ...opts.headers };
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    if (opts.csrf !== false && this.cookies.has("em_csrf")) headers["x-csrf-token"] = this.cookies.get("em_csrf")!;
    const raw = body instanceof Uint8Array;
    if (body !== undefined && !raw) headers["content-type"] = "application/json";
    if (raw) headers["content-length"] = String((body as Uint8Array).byteLength);
    const res = await this.app.request(`http://localhost/api${path}`, { method, headers, body: raw ? (body as BodyInit) : body !== undefined ? JSON.stringify(body) : undefined }, this.env);
    for (const sc of res.headers.getSetCookie()) {
      const [pair, ...attrs] = sc.split(";");
      const i = pair.indexOf("=");
      const k = pair.slice(0, i).trim();
      const v = pair.slice(i + 1).trim();
      if (!v || attrs.some((a) => /max-age=0/i.test(a))) this.cookies.delete(k);
      else this.cookies.set(k, v);
    }
    if (opts.bytes && res.ok) return { status: res.status, body: new Uint8Array(await res.arrayBuffer()) as any, headers: res.headers };
    const text = await res.text();
    let json: any;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json, headers: res.headers };
  }
  get = (p: string) => this.req("GET", p);
  post = (p: string, b?: unknown, o?: { csrf?: boolean; headers?: Record<string, string> }) => this.req("POST", p, b ?? {}, o);
}
