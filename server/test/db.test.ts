import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "./helpers";
import { migrate, pendingMigrations } from "../src/db/migrate";
import { ensureVectorIndex, nearestSql, toVectorLiteral, vectorIndexName } from "../src/db/vector";
import { kbCollections, kbChunks } from "../src/db/schema";
import type { Database } from "../src/db/client";

let t: Awaited<ReturnType<typeof createTestDatabase>>;
let database: Database;

beforeAll(async () => {
  t = await createTestDatabase();
  database = t.database;
});
afterAll(async () => t?.drop());

describe("migrations + schema", () => {
  it("applies all migrations, idempotently", async () => {
    const first = await migrate(database);
    expect(first.applied.length).toBeGreaterThanOrEqual(2);
    expect(await pendingMigrations(database)).toEqual([]);
    expect((await migrate(database)).applied).toEqual([]);
    const tables = await database.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public'");
    const names = tables.map((r) => r.tablename);
    for (const n of ["users", "sessions", "providers", "models", "projects", "conversations", "messages", "runs", "run_steps",
      "tool_approvals", "files", "file_versions", "kb_collections", "kb_chunks", "memories", "skills", "mcp_servers", "mcp_tools",
      "tool_policies", "usage_logs", "audit_logs", "settings", "login_attempts"]) expect(names).toContain(n);
  });

  it("stores mixed-dimension vectors and searches per-dimension with HNSW + tsvector", async () => {
    const [col] = await database.db.insert(kbCollections).values({ name: "c" }).returning();
    await database.db.insert(kbChunks).values([
      { collectionId: col.id, chunkIndex: 0, content: "apple banana", embedding: [1, 0, 0], embeddingDim: 3, embeddingModel: "m3" },
      { collectionId: col.id, chunkIndex: 1, content: "cherry", embedding: [0, 1, 0], embeddingDim: 3, embeddingModel: "m3" },
      { collectionId: col.id, chunkIndex: 2, content: "durian", embedding: [0, 0, 0, 1], embeddingDim: 4, embeddingModel: "m4" },
    ]);
    expect(await ensureVectorIndex(database, "kb_chunks", 3)).toBe(true);
    expect(await ensureVectorIndex(database, "kb_chunks", 3)).toBe(true); // idempotent
    expect(await ensureVectorIndex(database, "kb_chunks", 3072)).toBe(true); // halfvec path
    const idx = await database.query<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE tablename='kb_chunks'");
    expect(idx.map((r) => r.indexname)).toEqual(expect.arrayContaining([vectorIndexName("kb_chunks", 3), vectorIndexName("kb_chunks", 3072)]));
    const rows = await database.query<{ content: string }>(nearestSql("kb_chunks", 3), [toVectorLiteral([0.9, 0.1, 0]), 2]);
    expect(rows.map((r) => r.content)).toEqual(["apple banana", "cherry"]);
    const fts = await database.query<{ content: string }>("SELECT content FROM kb_chunks WHERE tsv @@ plainto_tsquery('simple', $1)", ["banana"]);
    expect(fts).toHaveLength(1);
  });
});
