/**
 * Knowledge base core: collection embedders, the resumable batch indexer, and hybrid retrieval.
 *
 * Indexing model (resumable by construction): a chunk is "pending" when its stored embedding was not produced
 * by the collection's CURRENT provider model + dimension. New uploads insert chunks without vectors; changing a
 * collection's model makes every chunk pending again (old vectors stay until replaced, and are ignored by search
 * because it filters on the current model + dim). `indexStep` embeds pending chunks in batches until its time
 * budget runs out, holding a per-collection lease so only one worker (browser-driven step, Netlify background
 * function, CF waitUntil chain) embeds at a time. Any worker can resume where another stopped.
 *
 * Retrieval: vector (pgvector cosine, per-dimension HNSW) + full-text (app-tokenized CJK bigram tsvector),
 * fused with Reciprocal Rank Fusion (k = 60); optional rerank with the collection's rerank provider.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { KbIndexProgress, KbSearchHit } from "../../../shared/src/index";
import { getKindSpec } from "../../../shared/src/index";
import type { Database } from "../db/client";
import { kbChunks, kbCollections, kbDocuments, providers, usageLogs } from "../db/schema";
import { ensureVectorIndex, nearestSql, toVectorLiteral } from "../db/vector";
import { decryptSecret } from "../lib/crypto";
import { toTsqueryLiteral } from "../lib/textsearch";
import { embedTexts, rerankDocuments, type AiBinding, type ProbeTarget } from "../providers/probe";

export type Collection = typeof kbCollections.$inferSelect;

export interface KbDeps {
  database: Database;
  encKey: Uint8Array;
  fetch: typeof fetch;
  ai?: AiBinding | null;
}

export interface ProviderTarget {
  providerId: string;
  target: ProbeTarget;
}

export async function providerTarget(d: KbDeps, providerId: string | null, type: "embedding" | "rerank"): Promise<ProviderTarget | null> {
  if (!providerId) return null;
  const [p] = await d.database.db.select().from(providers).where(and(eq(providers.id, providerId), eq(providers.type, type))).limit(1);
  if (!p || !p.enabled) return null;
  const apiKey = p.apiKeyEnc ? await decryptSecret(p.apiKeyEnc, d.encKey, `provider:${p.id}:apiKey`) : null;
  return { providerId: p.id, target: { type, kind: p.kind, baseUrl: p.baseUrl, apiKey, config: p.config ?? {} } };
}

/** Is the collection able to produce vectors right now? */
export const hasEmbedding = (c: Collection) => !!(c.embeddingProviderId && c.embeddingModel && c.embeddingDim);

export async function embedWith(d: KbDeps, pt: ProviderTarget, model: string, texts: string[], inputType: "document" | "query", dims: number | null) {
  const vecs = await embedTexts(d.fetch, pt.target, model, texts, inputType, { dimensions: dims, ai: d.ai });
  await d.database.db.insert(usageLogs).values({ providerId: pt.providerId, model, kind: "embedding", inputTokens: Math.ceil(texts.reduce((a, t) => a + t.length, 0) / 3) }).catch(() => {});
  return vecs;
}

/** Probe the real output dimension of provider/model (and validate that `requested` is honoured). */
export async function probeDimension(d: KbDeps, providerId: string, model: string, requested: number | null): Promise<number> {
  const pt = await providerTarget(d, providerId, "embedding");
  if (!pt) throw new Error("找不到啟用中的 Embedding 供應商");
  const [v] = await embedWith(d, pt, model, ["dimension probe"], "document", requested);
  if (requested && v.length !== requested) throw new Error(`模型回傳 ${v.length} 維，與指定的 ${requested} 維不符（此模型可能不支援自訂維度）`);
  if (v.length > 16000) throw new Error(`維度 ${v.length} 過大`);
  return v.length;
}

// ---------- progress / lease ----------

const PENDING = `(embedding IS NULL OR embedding_model IS DISTINCT FROM $2 OR embedding_dim IS DISTINCT FROM $3)`;

export async function progressOf(database: Database, c: Collection): Promise<KbIndexProgress> {
  const [r] = await database.query<{ total: number; done: number }>(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE NOT ${PENDING})::int AS done FROM kb_chunks WHERE collection_id = $1`,
    [c.id, c.embeddingModel ?? "", c.embeddingDim ?? 0],
  );
  const done = hasEmbedding(c) ? r.done : 0;
  return {
    collectionId: c.id,
    status: c.indexStatus as KbIndexProgress["status"],
    total: r.total,
    done,
    remaining: hasEmbedding(c) ? r.total - done : 0,
    busy: !!c.indexLeaseUntil && c.indexLeaseUntil.getTime() > Date.now(),
    error: c.indexError,
  };
}

const LEASE_MS = 90_000;

async function takeLease(database: Database, id: string): Promise<Collection | null> {
  const [row] = await database.db
    .update(kbCollections)
    .set({ indexLeaseUntil: new Date(Date.now() + LEASE_MS) })
    .where(and(eq(kbCollections.id, id), sql`(${kbCollections.indexLeaseUntil} IS NULL OR ${kbCollections.indexLeaseUntil} < now())`))
    .returning();
  return row ?? null;
}

type PendingRow = { id: string; content: string };

const BATCH_TEXTS = 32;
const BATCH_CHARS = 48_000;

export interface StepResult extends KbIndexProgress {
  /** Chunks embedded by this call. */
  embedded: number;
  /** Lease held by another worker: nothing was done. */
  skipped?: boolean;
}

/**
 * Embed pending chunks of one collection until `budgetMs` is (nearly) spent. Safe to call concurrently:
 * a second caller gets `skipped`. On provider failure the collection goes to status `error` (resume = call again).
 */
export async function indexStep(d: KbDeps, collectionId: string, budgetMs: number): Promise<StepResult> {
  const started = Date.now();
  const database = d.database;
  const c = await takeLease(database, collectionId);
  if (!c) {
    const [cur] = await database.db.select().from(kbCollections).where(eq(kbCollections.id, collectionId)).limit(1);
    if (!cur) throw new Error("找不到知識庫");
    return { ...(await progressOf(database, cur)), embedded: 0, skipped: true };
  }
  let embedded = 0;
  let status = c.indexStatus;
  let error: string | null = null;
  try {
    if (hasEmbedding(c)) {
      const pt = await providerTarget(d, c.embeddingProviderId, "embedding");
      if (!pt) throw new Error("知識庫綁定的 Embedding 供應商已停用或被刪除");
      await ensureVectorIndex(database, "kb_chunks", c.embeddingDim!).catch(() => {});
      let lastBatchMs = 0;
      for (;;) {
        const elapsed = Date.now() - started;
        if (elapsed + Math.max(lastBatchMs * 1.5, 1000) > budgetMs) break;
        const rows: PendingRow[] = await database.query<PendingRow>(
          `SELECT id, content FROM kb_chunks WHERE collection_id = $1 AND ${PENDING} ORDER BY document_id, chunk_index LIMIT ${BATCH_TEXTS}`,
          [c.id, c.embeddingModel, c.embeddingDim],
        );
        if (!rows.length) break;
        const batch: PendingRow[] = [];
        let chars = 0;
        for (const r of rows) {
          if (batch.length && chars + r.content.length > BATCH_CHARS) break;
          batch.push(r);
          chars += r.content.length;
        }
        const t0 = Date.now();
        let vecs: number[][];
        try {
          vecs = await embedWith(d, pt, c.embeddingModel!, batch.map((r) => r.content), "document", c.requestedDim);
        } catch (e) {
          // one retry for transient failures (429 / 5xx / network)
          await new Promise<void>((res) => setTimeout(res, 1500));
          vecs = await embedWith(d, pt, c.embeddingModel!, batch.map((r) => r.content), "document", c.requestedDim);
        }
        if (vecs.some((v) => v.length !== c.embeddingDim)) throw new Error(`模型回傳的維度（${vecs[0]?.length}）與知識庫設定（${c.embeddingDim}）不符，請重新設定模型`);
        await database.query(
          `UPDATE kb_chunks AS k SET embedding = v.e::vector, embedding_dim = $3, embedding_model = $4
             FROM unnest($1::uuid[], $2::text[]) AS v(id, e) WHERE k.id = v.id`,
          [batch.map((r) => r.id), vecs.map(toVectorLiteral), c.embeddingDim, c.embeddingModel],
        );
        embedded += batch.length;
        lastBatchMs = Date.now() - t0;
        await database.db.update(kbCollections).set({ indexLeaseUntil: new Date(Date.now() + LEASE_MS) }).where(eq(kbCollections.id, c.id));
      }
    }
  } catch (e) {
    error = (e as Error).message.slice(0, 500);
    status = "error";
  }
  const [fresh] = await database.db.select().from(kbCollections).where(eq(kbCollections.id, c.id)).limit(1);
  const prog = await progressOf(database, fresh);
  if (!error && prog.remaining === 0) status = "idle";
  else if (!error && status === "error") status = "indexing";
  else if (!error && status === "idle" && prog.remaining > 0) status = "indexing";
  const [after] = await database.db
    .update(kbCollections)
    .set({ indexLeaseUntil: null, indexStatus: status, indexError: error })
    .where(eq(kbCollections.id, c.id))
    .returning();
  return { ...prog, status: after.indexStatus as StepResult["status"], error, busy: false, embedded };
}

// ---------- retrieval ----------

export interface SearchOptions {
  topK?: number;
  /** Disable rerank even when configured. */
  rerank?: boolean;
}

export interface SearchResult {
  hits: KbSearchHit[];
  /** Human-readable notes (embedding failed → text-only, rerank failed …). */
  notes: string[];
  modes: string[];
}

const RRF_K = 60;

/** Hybrid search across collections (vector per embedding config + full text), RRF-fused, optional rerank. */
export async function searchCollections(d: KbDeps, cols: Collection[], query: string, o: SearchOptions = {}): Promise<SearchResult> {
  const topK = Math.min(50, Math.max(1, o.topK ?? 8));
  const cand = Math.min(100, Math.max(20, topK * 4));
  const notes: string[] = [];
  const modes = new Set<string>();
  const ids = cols.map((c) => c.id);
  if (!ids.length || !query.trim()) return { hits: [], notes, modes: [] };
  const lists: { kind: string; ids: string[] }[] = [];

  // vector: one query embedding per distinct (provider, model, dim, requestedDim)
  const groups = new Map<string, Collection[]>();
  for (const c of cols.filter(hasEmbedding)) {
    const k = `${c.embeddingProviderId}|${c.embeddingModel}|${c.embeddingDim}|${c.requestedDim ?? ""}`;
    groups.set(k, [...(groups.get(k) ?? []), c]);
  }
  const vecHits: { id: string; distance: number }[] = [];
  for (const g of groups.values()) {
    const c = g[0];
    try {
      const pt = await providerTarget(d, c.embeddingProviderId, "embedding");
      if (!pt) throw new Error("Embedding 供應商已停用");
      const [v] = await embedWith(d, pt, c.embeddingModel!, [query], "query", c.requestedDim);
      if (v.length !== c.embeddingDim) throw new Error("維度不符");
      const rows = await d.database.query<{ id: string; distance: number }>(
        nearestSql("kb_chunks", v.length, `embedding_model = $3 AND collection_id = ANY($4::uuid[])`).replace("SELECT *,", "SELECT id,"),
        [toVectorLiteral(v), cand, c.embeddingModel, g.map((x) => x.id)],
      );
      vecHits.push(...rows.map((r) => ({ id: r.id, distance: Number(r.distance) })));
      modes.add("vector");
    } catch (e) {
      notes.push(`向量檢索失敗（${g.map((x) => x.name).join("、")}）：${(e as Error).message}；改用全文檢索`);
    }
  }
  if (vecHits.length) lists.push({ kind: "vector", ids: vecHits.sort((a, b) => a.distance - b.distance).slice(0, cand).map((h) => h.id) });

  // full text: OR of CJK bigrams / words, ranked by cover density
  const tsq = toTsqueryLiteral(query, "or");
  if (tsq) {
    const rows = await d.database.query<{ id: string }>(
      `SELECT id FROM kb_chunks WHERE collection_id = ANY($1::uuid[]) AND tsv @@ $2::tsquery ORDER BY ts_rank_cd(tsv, $2::tsquery, 1) DESC, chunk_index LIMIT $3`,
      [ids, tsq, cand],
    );
    if (rows.length) lists.push({ kind: "text", ids: rows.map((r) => r.id) });
    modes.add("text");
  }

  // RRF
  const fused = new Map<string, { score: number; via: string[] }>();
  for (const l of lists) {
    l.ids.forEach((id, i) => {
      const f = fused.get(id) ?? { score: 0, via: [] };
      f.score += 1 / (RRF_K + i + 1);
      if (!f.via.includes(l.kind)) f.via.push(l.kind);
      fused.set(id, f);
    });
  }
  let ranked = [...fused.entries()].sort((a, b) => b[1].score - a[1].score).map(([id, f]) => ({ id, ...f }));
  if (!ranked.length) return { hits: [], notes, modes: [...modes] };

  const rerankCol = o.rerank === false ? undefined : cols.find((c) => c.rerankProviderId && c.rerankModel);
  const pool = ranked.slice(0, rerankCol ? Math.min(50, topK * 3) : topK);
  const rows = await d.database.db
    .select({ c: kbChunks, docName: kbDocuments.name })
    .from(kbChunks)
    .leftJoin(kbDocuments, eq(kbDocuments.id, kbChunks.documentId))
    .where(inArray(kbChunks.id, pool.map((p) => p.id)));
  const byId = new Map(rows.map((r) => [r.c.id, r]));
  let final = pool.filter((p) => byId.has(p.id));

  if (rerankCol) {
    try {
      const pt = await providerTarget(d, rerankCol.rerankProviderId, "rerank");
      if (!pt) throw new Error("Rerank 供應商已停用");
      const rr = await rerankDocuments(d.fetch, pt.target, rerankCol.rerankModel!, query, final.map((p) => byId.get(p.id)!.c.content.slice(0, 4000)), topK);
      await d.database.db.insert(usageLogs).values({ providerId: pt.providerId, model: rerankCol.rerankModel, kind: "rerank" }).catch(() => {});
      final = rr.map((r) => ({ ...final[r.index], score: r.score, via: [...final[r.index].via, "rerank"] }));
      modes.add("rerank");
    } catch (e) {
      notes.push(`重排序失敗：${(e as Error).message}`);
    }
  }
  const colName = new Map(cols.map((c) => [c.id, c.name]));
  const hits: KbSearchHit[] = final.slice(0, topK).map((p) => {
    const r = byId.get(p.id)!;
    return {
      chunkId: r.c.id,
      documentId: r.c.documentId,
      collectionId: r.c.collectionId,
      collection: colName.get(r.c.collectionId) ?? "",
      source: r.docName ?? "（未知文件）",
      chunkIndex: r.c.chunkIndex,
      content: r.c.content,
      metadata: r.c.metadata ?? null,
      score: Math.round(p.score * 10000) / 10000,
      via: p.via,
    };
  });
  return { hits, notes, modes: [...modes] };
}

/** Collections visible to a conversation: global ones + the project's own. */
export async function attachedCollections(database: Database, projectId: string | null): Promise<Collection[]> {
  return database.db
    .select()
    .from(kbCollections)
    .where(projectId ? sql`(${kbCollections.projectId} IS NULL OR ${kbCollections.projectId} = ${projectId})` : sql`${kbCollections.projectId} IS NULL`)
    .orderBy(kbCollections.createdAt);
}

export function defaultEmbeddingModel(kind: string): string | undefined {
  return getKindSpec("embedding", kind)?.suggestedModels?.[0];
}
