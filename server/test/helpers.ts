import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../src/db/schema";
import type { AppDb, Database } from "../src/db/client";
import type { AppEnv } from "../src/env";

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
