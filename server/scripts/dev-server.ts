// Local dev API on :8787 (Vite proxies /api here). Uses node-postgres for a local DB,
// or the Neon driver when DATABASE_URL points at Neon.
import { serve } from "@hono/node-server";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { createApp } from "../src/app";
import { createNeonDatabase, type AppDb, type Database } from "../src/db/client";
import * as schema from "../src/db/schema";
import { ENV_KEYS } from "../src/env";

const env = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

function localDatabase(url: string): Database {
  const pool = new pg.Pool({ connectionString: url });
  return {
    db: drizzle({ client: pool, schema }) as unknown as AppDb,
    async execTransaction(statements) {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        for (const s of statements) await c.query(s);
        await c.query("COMMIT");
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      } finally {
        c.release();
      }
    },
    async query<T>(text: string, params: unknown[] = []) {
      return (await pool.query(text, params)).rows as T[];
    },
  };
}

let local: Database | undefined;
const app = createApp({
  getDatabase: (e) => (/neon\.tech/.test(e.DATABASE_URL) ? createNeonDatabase(e.DATABASE_URL) : (local ??= localDatabase(e.DATABASE_URL))),
  platform: { name: "node" },
});

serve({ fetch: (req) => app.fetch(req, env), port: 8787 }, (i) => console.log(`EdgeMind API on http://127.0.0.1:${i.port}`));
