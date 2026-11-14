/**
 * Per-dimension HNSW partial indexes over untyped vector columns (see schema.ts header).
 */
import type { Database } from "./client";

const TABLES = ["kb_chunks", "memories"] as const;
export type VectorTable = (typeof TABLES)[number];

export const HNSW_VECTOR_MAX_DIM = 2000;
export const HNSW_HALFVEC_MAX_DIM = 4000;

function assertDim(dim: number) {
  if (!Number.isInteger(dim) || dim < 1 || dim > 16000) throw new Error(`invalid embedding dimension ${dim}`);
}

/** The cast expression used both in the index and in queries, so the planner can match them. */
export function vectorCast(dim: number): string {
  assertDim(dim);
  return dim <= HNSW_VECTOR_MAX_DIM ? `embedding::vector(${dim})` : `embedding::halfvec(${dim})`;
}

export function vectorIndexName(table: VectorTable, dim: number) {
  return `${table}_emb_hnsw_${dim}`;
}

/** Idempotently create the HNSW cosine index for one dimension. Dimensions > 4000 get no ANN index. */
export async function ensureVectorIndex(database: Database, table: VectorTable, dim: number): Promise<boolean> {
  assertDim(dim);
  if (!TABLES.includes(table)) throw new Error("bad table");
  if (dim > HNSW_HALFVEC_MAX_DIM) return false;
  const ops = dim <= HNSW_VECTOR_MAX_DIM ? "vector_cosine_ops" : "halfvec_cosine_ops";
  await database.query(
    `CREATE INDEX IF NOT EXISTS ${vectorIndexName(table, dim)} ON ${table} USING hnsw ((${vectorCast(dim)}) ${ops}) WHERE embedding_dim = ${dim}`,
  );
  return true;
}

/** SQL fragment + params for a cosine nearest-neighbour search on one dimension. */
export function nearestSql(table: VectorTable, dim: number, whereExtra = "TRUE") {
  const cast = vectorCast(dim);
  const qcast = dim <= HNSW_VECTOR_MAX_DIM ? `$1::vector(${dim})` : `$1::halfvec(${dim})`;
  return `SELECT *, (${cast} <=> ${qcast}) AS distance FROM ${table} WHERE embedding_dim = ${dim} AND ${whereExtra} ORDER BY ${cast} <=> ${qcast} LIMIT $2`;
}

export function toVectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}
