/**
 * DB abstraction. Production uses the Neon serverless HTTP driver (works on Netlify Functions and
 * Cloudflare Workers, no TCP/pool). Tests inject a node-postgres backed Database (see test/helpers).
 */
import { neon } from "@neondatabase/serverless";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-http";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema";

export type AppDb = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface Database {
  db: AppDb;
  /** Run raw SQL statements atomically (used by the migrator). */
  execTransaction(statements: string[]): Promise<void>;
  /** Run one raw query and return rows. */
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
}

const cache = new Map<string, Database>();

export function createNeonDatabase(url: string): Database {
  const hit = cache.get(url);
  if (hit) return hit;
  const sql = neon(url);
  const database: Database = {
    db: drizzleNeon({ client: sql, schema }) as unknown as AppDb,
    async execTransaction(statements) {
      await sql.transaction(statements.map((s) => sql.query(s)));
    },
    async query<T>(text: string, params: unknown[] = []) {
      return (await sql.query(text, params)) as T[];
    },
  };
  cache.set(url, database);
  return database;
}

export { schema };
