import type { Database } from "./client";
import { MIGRATIONS } from "./migrations.generated";

const TABLE = "__edgemind_migrations";

export interface MigrationResult {
  applied: string[];
  pending: number;
}

async function appliedTags(database: Database): Promise<Map<string, string>> {
  await database.query(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (tag text PRIMARY KEY, hash text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`,
  );
  const rows = await database.query<{ tag: string; hash: string }>(`SELECT tag, hash FROM ${TABLE}`);
  return new Map(rows.map((r) => [r.tag, r.hash]));
}

export async function pendingMigrations(database: Database): Promise<string[]> {
  const done = await appliedTags(database);
  return MIGRATIONS.filter((m) => !done.has(m.tag)).map((m) => m.tag);
}

/**
 * Applies embedded migrations in order, each in its own transaction together with its bookkeeping
 * row. Concurrent first requests are safe: the INSERT into the bookkeeping table conflicts on the
 * primary key and rolls the duplicate transaction back.
 */
export async function migrate(database: Database): Promise<MigrationResult> {
  const done = await appliedTags(database);
  const applied: string[] = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.tag)) continue;
    const tag = m.tag.replace(/'/g, "''");
    try {
      await database.execTransaction([
        `INSERT INTO ${TABLE} (tag, hash) VALUES ('${tag}', '${m.hash}')`,
        ...m.statements,
      ]);
      applied.push(m.tag);
    } catch (e) {
      // Another instance may have applied it meanwhile.
      const now = await appliedTags(database);
      if (!now.has(m.tag)) throw e;
    }
  }
  return { applied, pending: 0 };
}
