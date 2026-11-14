/**
 * memory_save / memory_search / memory_update / memory_delete. Vector search (pgvector, cosine) when an
 * embedding provider is configured (setting `embedding_model_id`, else the first enabled embedding provider);
 * otherwise substring/keyword search (CJK-safe). Visible scope: global + this project + this conversation.
 */
import { and, asc, eq, or, sql, type SQL } from "drizzle-orm";
import { getKindSpec } from "@edgemind/shared";
import type { Database } from "../db/client";
import { memories, models, providers, usageLogs } from "../db/schema";
import { ensureVectorIndex, nearestSql, toVectorLiteral } from "../db/vector";
import { decryptSecret } from "../lib/crypto";
import { getSetting } from "../lib/settings";
import { embedTexts, type ProbeTarget } from "../providers/probe";
import type { Tool, ToolContext } from "../agent/tools";

export interface Embedder {
  providerId: string;
  model: string;
  target: ProbeTarget;
}

export async function resolveEmbedder(database: Database, encKey: Uint8Array): Promise<Embedder | null> {
  const preferred = await getSetting<string>(database, "embedding_model_id");
  const q = database.db
    .select({ m: models, p: providers })
    .from(providers)
    .leftJoin(models, and(eq(models.providerId, providers.id), eq(models.enabled, true)))
    .where(and(eq(providers.type, "embedding"), eq(providers.enabled, true)))
    .orderBy(asc(providers.priority), asc(providers.createdAt));
  const rows = await q;
  if (!rows.length) return null;
  const pick = rows.find((r) => r.m?.id === preferred) ?? rows.find((r) => r.m) ?? rows[0];
  const model = pick.m?.modelId ?? getKindSpec("embedding", pick.p.kind)?.suggestedModels?.[0];
  if (!model) return null;
  const apiKey = pick.p.apiKeyEnc ? await decryptSecret(pick.p.apiKeyEnc, encKey, `provider:${pick.p.id}:apiKey`) : null;
  return { providerId: pick.p.id, model, target: { type: "embedding", kind: pick.p.kind, baseUrl: pick.p.baseUrl, apiKey, config: pick.p.config ?? {} } };
}

async function embedOne(ctx: Pick<ToolContext, "database" | "fetch"> & { runId?: string | null }, e: Embedder, text: string, inputType: "document" | "query"): Promise<number[]> {
  const [v] = await embedTexts(ctx.fetch, e.target, e.model, [text], inputType);
  await ctx.database.db.insert(usageLogs).values({ providerId: e.providerId, model: e.model, runId: ctx.runId ?? null, kind: "embedding" }).catch(() => {});
  return v;
}

function visible(ctx: { projectId: string | null; conversationId: string }): SQL {
  return or(
    eq(memories.scope, "global"),
    ctx.projectId ? and(eq(memories.scope, "project"), eq(memories.projectId, ctx.projectId)) : sql`false`,
    and(eq(memories.scope, "conversation"), eq(memories.conversationId, ctx.conversationId)),
  )!;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function findVisible(ctx: ToolContext, id: unknown) {
  if (typeof id !== "string" || !UUID.test(id)) throw new Error("id 格式錯誤");
  const [m] = await ctx.database.db.select().from(memories).where(and(eq(memories.id, id), visible(ctx))).limit(1);
  if (!m) throw new Error("找不到這則記憶");
  return m;
}

const out = (m: typeof memories.$inferSelect, score?: number) => ({
  id: m.id, scope: m.scope, content: m.content, updatedAt: m.updatedAt.toISOString(), ...(score !== undefined ? { score: Math.round(score * 1000) / 1000 } : {}),
});

export async function embedFields(ctx: Pick<ToolContext, "database" | "fetch" | "encKey"> & { runId?: string | null }, content: string): Promise<{ fields: Partial<typeof memories.$inferInsert>; note?: string }> {
  const e = await resolveEmbedder(ctx.database, ctx.encKey).catch(() => null);
  if (!e) return { fields: { embedding: null, embeddingDim: null, embeddingModel: null } };
  try {
    const v = await embedOne(ctx, e, content, "document");
    await ensureVectorIndex(ctx.database, "memories", v.length).catch(() => {});
    return { fields: { embedding: v, embeddingDim: v.length, embeddingModel: e.model } };
  } catch (err) {
    return { fields: { embedding: null, embeddingDim: null, embeddingModel: null }, note: `向量化失敗（${(err as Error).message}），只能以關鍵字搜尋到` };
  }
}

export const memorySaveTool: Tool = {
  name: "memory_save",
  description: "儲存一則長期記憶（使用者偏好、事實、決定）。scope：global（所有對話）、project（本專案，預設於專案內）、conversation（本對話）。",
  risk: "write",
  parameters: {
    type: "object",
    properties: {
      content: { type: "string", description: "要記住的內容（一句完整、可獨立理解的敘述）" },
      scope: { type: "string", enum: ["global", "project", "conversation"] },
    },
    required: ["content"],
  },
  async execute(args, ctx) {
    const content = String(args?.content ?? "").trim();
    if (!content) throw new Error("content 不可為空");
    if (content.length > 4000) throw new Error("記憶內容過長（上限 4000 字）");
    const scope = ["global", "project", "conversation"].includes(args?.scope) ? args.scope : ctx.projectId ? "project" : "global";
    if (scope === "project" && !ctx.projectId) throw new Error("此對話不屬於任何專案，無法存成專案記憶");
    const { fields, note } = await embedFields(ctx, content);
    const [m] = await ctx.database.db.insert(memories).values({
      scope, content, source: "tool",
      projectId: scope === "project" ? ctx.projectId : null,
      conversationId: scope === "conversation" ? ctx.conversationId : null,
      ...fields,
    }).returning();
    return { ok: true, memory: out(m), ...(note ? { note } : {}) };
  },
};

export const memorySearchTool: Tool = {
  name: "memory_search",
  description: "搜尋長期記憶（語意搜尋；未設定 Embedding 時用關鍵字）。回傳 id 以便更新或刪除。",
  risk: "read",
  parameters: {
    type: "object",
    properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 20 } },
    required: ["query"],
  },
  async execute(args, ctx) {
    const query = String(args?.query ?? "").trim();
    if (!query) throw new Error("query 不可為空");
    const limit = Math.min(20, Math.max(1, Number.isInteger(args?.limit) ? args.limit : 5));
    return searchMemories(ctx, query, limit);
  },
};

export interface MemorySearchCtx {
  database: Database;
  encKey: Uint8Array;
  fetch: typeof fetch;
  conversationId: string;
  projectId: string | null;
  runId?: string | null;
}

export interface MemoryHit {
  id: string;
  scope: string;
  content: string;
  updatedAt: string;
  score?: number;
}

/** Vector search over visible memories (global + project + conversation), keyword fallback. */
export async function searchMemories(ctx: MemorySearchCtx, query: string, limit: number, opts: { minScore?: number; queryVector?: number[] | null } = {}): Promise<{ mode: "vector" | "keyword"; results: MemoryHit[] }> {
  const e = await resolveEmbedder(ctx.database, ctx.encKey).catch(() => null);
  if (e) {
    try {
      const v = opts.queryVector ?? (await embedOne(ctx, e, query, "query"));
      const params: unknown[] = [toVectorLiteral(v), limit, ctx.conversationId];
      let where = `embedding_model = $4 AND (scope = 'global' OR (scope = 'conversation' AND conversation_id = $3)`;
      params.push(e.model);
      if (ctx.projectId) {
        params.push(ctx.projectId);
        where += ` OR (scope = 'project' AND project_id = $5)`;
      }
      where += ")";
      const rows = await ctx.database.query<Record<string, any>>(nearestSql("memories", v.length, where), params);
      const hits = rows
        .map((r) => ({ id: r.id, scope: r.scope, content: r.content, updatedAt: new Date(r.updated_at).toISOString(), score: Math.round((1 - Number(r.distance)) * 1000) / 1000 }))
        .filter((h) => opts.minScore === undefined || h.score >= opts.minScore);
      if (rows.length) return { mode: "vector", results: hits };
    } catch {
      /* fall back to keywords */
    }
  }
  // keyword fallback: whole query + individual terms (CJK bigrams for long CJK runs), ranked by matches
  const words = query.split(/[\s,，。、;；:：!！?？「」『』（）()]+/).filter((t) => t.length >= 2);
  const bigrams = words.flatMap((w) => (/[\u3400-\u9fff]/.test(w) && w.length > 4 ? Array.from({ length: w.length - 1 }, (_, i) => w.slice(i, i + 2)) : []));
  const terms = [...new Set([query.slice(0, 200), ...words, ...bigrams])].slice(0, 16);
  const esc = (t: string) => `%${t.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const score = sql.join(terms.map((t) => sql`(CASE WHEN ${memories.content} ILIKE ${esc(t)} THEN 1 ELSE 0 END)`), sql` + `);
  const minMatches = opts.minScore !== undefined ? Math.min(2, terms.length) : 1;
  const rows = await ctx.database.db
    .select({ m: memories, score: sql<number>`(${score})::int` })
    .from(memories)
    .where(and(visible(ctx), or(...terms.map((t) => sql`${memories.content} ILIKE ${esc(t)}`)), sql`(${score}) >= ${minMatches}`))
    .orderBy(sql`(${score}) DESC`, sql`${memories.updatedAt} DESC`)
    .limit(limit);
  return { mode: "keyword", results: rows.map((r) => out(r.m)) };
}

export const memoryUpdateTool: Tool = {
  name: "memory_update",
  description: "更新一則記憶的內容（以 memory_search 取得 id）。",
  risk: "write",
  parameters: { type: "object", properties: { id: { type: "string" }, content: { type: "string" } }, required: ["id", "content"] },
  async execute(args, ctx) {
    const m = await findVisible(ctx, args?.id);
    const content = String(args?.content ?? "").trim();
    if (!content) throw new Error("content 不可為空");
    const { fields, note } = await embedFields(ctx, content);
    const [u] = await ctx.database.db.update(memories).set({ content, ...fields, updatedAt: new Date() }).where(eq(memories.id, m.id)).returning();
    return { ok: true, memory: out(u), ...(note ? { note } : {}) };
  },
};

export const memoryDeleteTool: Tool = {
  name: "memory_delete",
  description: "刪除一則記憶（以 memory_search 取得 id）。",
  risk: "write",
  parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  async execute(args, ctx) {
    const m = await findVisible(ctx, args?.id);
    await ctx.database.db.delete(memories).where(eq(memories.id, m.id));
    return { ok: true, deleted: m.id };
  },
};

export const memoryTools = [memorySaveTool, memorySearchTool, memoryUpdateTool, memoryDeleteTool];
