/**
 * Memory management + settings (M10):
 *   GET    /api/memories?scope=&projectId=&conversationId=&q=&source=&limit=&offset=
 *   POST   /api/memories                      { content, scope, projectId? }   (source = user)
 *   PATCH  /api/memories/:id                  { content?, scope?, projectId? }
 *   DELETE /api/memories/:id
 *   POST   /api/memories/bulk-delete          { ids } | { all: true, scope?, projectId? }
 *   POST   /api/memories/reembed              re-embed rows with a different / missing embedding model (≤ 50 per call)
 *   GET/PUT /api/settings/memory              MemorySettingsDTO
 *   POST   /api/conversations/:id/compact     force-summarize older turns of the active branch
 */
import type { Hono } from "hono";
import { and, desc, eq, ilike, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import type { MemoryDTO, MemorySettingsDTO } from "@edgemind/shared";
import type { AppDeps, Ctx, HonoEnv } from "../context";
import { conversations, memories, messages, models, projects } from "../db/schema";
import { BadInput } from "../lib/errors";
import { getSetting, setSetting } from "../lib/settings";
import { getMemorySettings, helperModel, maybeCompact, normalizeMemorySettings } from "../memory";
import { embedFields, resolveEmbedder } from "../tools/memory";
import { resolveModel } from "../llm";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
type MemRow = typeof memories.$inferSelect;

const toDTO = (m: MemRow): MemoryDTO => ({
  id: m.id, scope: m.scope as MemoryDTO["scope"], projectId: m.projectId, conversationId: m.conversationId, content: m.content,
  source: m.source as MemoryDTO["source"], embeddingModel: m.embeddingModel, createdAt: m.createdAt.toISOString(), updatedAt: m.updatedAt.toISOString(),
});

export function mountMemory(app: Hono<HonoEnv>, deps: AppDeps) {
  const fetchFn = (): typeof fetch => deps.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const embedCtx = (c: Ctx) => ({ database: c.get("database"), encKey: c.get("encKey"), fetch: fetchFn(), runId: null });

  async function scopeFields(c: Ctx, body: any, current?: MemRow): Promise<Partial<typeof memories.$inferInsert>> {
    const scope = body?.scope ?? current?.scope ?? "global";
    if (!["global", "project", "conversation"].includes(scope)) throw new BadInput("scope 只能是 global、project 或 conversation");
    if (scope === "global") return { scope, projectId: null, conversationId: null };
    if (scope === "project") {
      const pid = body?.projectId ?? current?.projectId;
      if (!isUuid(pid)) throw new BadInput("專案記憶需要 projectId");
      const [p] = await c.get("database").db.select({ id: projects.id }).from(projects).where(eq(projects.id, pid)).limit(1);
      if (!p) throw new BadInput("找不到專案");
      return { scope, projectId: pid, conversationId: null };
    }
    const cid = body?.conversationId ?? current?.conversationId;
    if (!isUuid(cid)) throw new BadInput("對話記憶需要 conversationId");
    return { scope, projectId: null, conversationId: cid };
  }

  function filters(c: Ctx): SQL | undefined {
    const conds: SQL[] = [];
    const scope = c.req.query("scope");
    if (scope && ["global", "project", "conversation"].includes(scope)) conds.push(eq(memories.scope, scope));
    const pid = c.req.query("projectId");
    if (isUuid(pid)) conds.push(eq(memories.projectId, pid));
    const cid = c.req.query("conversationId");
    if (isUuid(cid)) conds.push(eq(memories.conversationId, cid));
    const source = c.req.query("source");
    if (source && ["tool", "auto", "user"].includes(source)) conds.push(eq(memories.source, source));
    const q = c.req.query("q")?.trim();
    if (q) conds.push(ilike(memories.content, `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`));
    return conds.length ? and(...conds) : undefined;
  }

  app.get("/memories", async (c) => {
    const limit = Math.min(200, Math.max(1, Number(c.req.query("limit") ?? 50) || 50));
    const offset = Math.max(0, Number(c.req.query("offset") ?? 0) || 0);
    const db = c.get("database").db;
    const where = filters(c);
    const rows = await db.select().from(memories).where(where).orderBy(desc(memories.updatedAt)).limit(limit).offset(offset);
    const [n] = await db.select({ n: sql<number>`count(*)::int` }).from(memories).where(where);
    return c.json({ items: rows.map(toDTO), total: Number(n?.n ?? 0) });
  });

  app.post("/memories", async (c) => {
    const body = await c.req.json().catch(() => null);
    const content = typeof body?.content === "string" ? body.content.trim() : "";
    if (!content) throw new BadInput("請輸入記憶內容");
    if (content.length > 4000) throw new BadInput("記憶內容上限 4000 字");
    const sf = await scopeFields(c, body);
    const { fields, note } = await embedFields(embedCtx(c), content);
    const [m] = await c.get("database").db.insert(memories).values({ ...sf, scope: sf.scope!, content, source: "user", ...fields }).returning();
    return c.json({ ...toDTO(m), ...(note ? { note } : {}) }, 201);
  });

  app.patch("/memories/:id", async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) return c.json({ error: "not_found" }, 404);
    const db = c.get("database").db;
    const [cur] = await db.select().from(memories).where(eq(memories.id, id)).limit(1);
    if (!cur) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    const patch: Partial<typeof memories.$inferInsert> = { updatedAt: new Date() };
    if (body?.content !== undefined) {
      const content = typeof body.content === "string" ? body.content.trim() : "";
      if (!content || content.length > 4000) throw new BadInput("記憶內容需為 1–4000 字");
      patch.content = content;
      Object.assign(patch, (await embedFields(embedCtx(c), content)).fields);
    }
    if (body?.scope !== undefined || body?.projectId !== undefined) Object.assign(patch, await scopeFields(c, body, cur));
    const [m] = await db.update(memories).set(patch).where(eq(memories.id, id)).returning();
    return c.json(toDTO(m));
  });

  app.delete("/memories/:id", async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) return c.json({ error: "not_found" }, 404);
    const r = await c.get("database").db.delete(memories).where(eq(memories.id, id)).returning({ id: memories.id });
    return r.length ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404);
  });

  app.post("/memories/bulk-delete", async (c) => {
    const body = await c.req.json().catch(() => null);
    const db = c.get("database").db;
    if (Array.isArray(body?.ids)) {
      const ids = body.ids.filter(isUuid).slice(0, 1000);
      if (!ids.length) return c.json({ deleted: 0 });
      const r = await db.delete(memories).where(inArray(memories.id, ids)).returning({ id: memories.id });
      return c.json({ deleted: r.length });
    }
    if (body?.all === true) {
      const conds: SQL[] = [];
      if (body.scope) conds.push(eq(memories.scope, String(body.scope)));
      if (isUuid(body.projectId)) conds.push(eq(memories.projectId, body.projectId));
      const r = await db.delete(memories).where(conds.length ? and(...conds) : undefined).returning({ id: memories.id });
      return c.json({ deleted: r.length });
    }
    throw new BadInput("需要 ids 或 all: true");
  });

  app.post("/memories/reembed", async (c) => {
    const database = c.get("database");
    const e = await resolveEmbedder(database, c.get("encKey"));
    if (!e) throw new BadInput("尚未設定 Embedding 供應商");
    const rows = await database.db.select().from(memories).where(or(isNull(memories.embeddingModel), ne(memories.embeddingModel, e.model))).limit(50);
    let done = 0;
    for (const m of rows) {
      const { fields, note } = await embedFields(embedCtx(c), m.content);
      if (note) return c.json({ done, remaining: null, error: note }, 502);
      await database.db.update(memories).set(fields).where(eq(memories.id, m.id));
      done++;
    }
    const [n] = await database.db.select({ n: sql<number>`count(*)::int` }).from(memories).where(or(isNull(memories.embeddingModel), ne(memories.embeddingModel, e.model)));
    return c.json({ done, remaining: Number(n?.n ?? 0), model: e.model });
  });

  app.get("/settings/memory", async (c) => c.json(await getMemorySettings(c.get("database"))));

  app.put("/settings/memory", async (c) => {
    const body = await c.req.json().catch(() => null);
    const database = c.get("database");
    const v = normalizeMemorySettings(body);
    if (v.helperModelId) {
      const [m] = await database.db.select({ id: models.id }).from(models).where(eq(models.id, v.helperModelId)).limit(1);
      if (!m) throw new BadInput("找不到輔助模型");
    }
    if (body?.embeddingModelId !== undefined) {
      const emb = body.embeddingModelId;
      if (emb !== null && !isUuid(emb)) throw new BadInput("embeddingModelId 格式錯誤");
      await setSetting(database, "embedding_model_id", emb ?? "");
    }
    const { embeddingModelId: _ignored, ...rest } = v as MemorySettingsDTO;
    await setSetting(database, "memory_settings", rest);
    return c.json(await getMemorySettings(database));
  });

  app.post("/conversations/:id/compact", async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) return c.json({ error: "not_found" }, 404);
    const database = c.get("database");
    const [conv] = await database.db.select().from(conversations).where(eq(conversations.id, id)).limit(1);
    if (!conv?.activeLeafId) return c.json({ error: "not_found", message: "找不到對話或對話是空的" }, 404);
    const [lastModel] = await database.db.select({ m: messages.modelId }).from(messages)
      .where(and(eq(messages.conversationId, id), sql`${messages.modelId} IS NOT NULL`)).orderBy(desc(messages.createdAt)).limit(1);
    const modelId = conv.modelId ?? lastModel?.m ?? (await getSetting<string>(database, "default_model_id")) ?? null;
    const helper = await helperModel(database, c.get("encKey"), deps.fetch, modelId);
    if (!helper) throw new BadInput("沒有可用的模型來產生摘要");
    const model = modelId ? await resolveModel(database, c.get("encKey"), modelId, deps.fetch).catch(() => helper) : helper;
    const r = await maybeCompact(database, id, conv.activeLeafId, model, { force: true, helper });
    const [fresh] = await database.db.select({ summary: conversations.summary, upTo: conversations.summaryUpTo }).from(conversations).where(eq(conversations.id, id));
    return c.json({ ...r, summary: fresh?.summary ?? null, summaryUpTo: fresh?.upTo ?? null });
  });
}
