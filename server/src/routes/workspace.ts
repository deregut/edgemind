/**
 * Conversations, projects, model picker, tool list, agent settings.
 *   GET    /api/conversations?q=&archived=0|1|all&projectId=<uuid>|none&limit=   (projectId=none: only conversations outside every project)
 *   PATCH  /api/conversations/:id                 { title, pinned, archived, projectId, modelId, permissionMode }
 *   DELETE /api/conversations/:id
 *   PUT    /api/conversations/:id/active-leaf     { leafId }  (branch switcher)
 *   POST   /api/conversations/:id/auto-title      LLM-generated title
 *   GET    /api/conversations/:id/export?format=md|json
 *   GET/POST /api/projects, GET/PATCH/DELETE /api/projects/:id
 *   GET    /api/models                            enabled chat models
 *   GET    /api/tools                             registry (name, description, risk)
 *   GET/PUT /api/settings/agent                   default model, max steps, 全部權限 caps, model prices
 */
import { recordLlmUsage, spendStatus } from "../usage";
import type { Hono } from "hono";
import { buildMcpTools } from "../mcp/service";
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { AgentSettingsDTO, ConversationDTO, ModelOptionDTO, Part, PermissionMode, ProjectDTO, ToolInfoDTO } from "../../../shared/src/index";
import type { AppDeps, Ctx, HonoEnv } from "../context";
import { conversations, messages, models, projects, providers } from "../db/schema";
import { BadInput } from "../lib/errors";
import type { Database } from "../db/client";
import { queryTerms, toTsqueryLiteral, toTsvectorLiteral } from "../lib/textsearch";
import { DEFAULT_FULL_CAPS, DEFAULT_MAX_STEPS, getSetting, normalizeCaps, setSetting } from "../lib/settings";
import { isPermissionMode } from "../agent/permissions";
import { builtinRegistry } from "../agent/tools";
import { loadBranch } from "../agent/context";
import { collect, resolveModel, streamChat, usableModelId } from "../llm";
import { resultToString } from "../llm/types";
import { fileStore } from "./files";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

type ConvRow = typeof conversations.$inferSelect;
type ProjRow = typeof projects.$inferSelect;

export const convDTO = (r: ConvRow, snippet?: string): ConversationDTO => ({
  id: r.id,
  title: r.title,
  projectId: r.projectId,
  modelId: r.modelId,
  permissionMode: (r.permissionMode as PermissionMode | null) ?? null,
  pinned: r.pinned,
  archived: r.archived,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
  ...(snippet !== undefined ? { snippet } : {}),
});

const projDTO = (r: ProjRow, conversationCount?: number): ProjectDTO => ({
  id: r.id,
  name: r.name,
  description: r.description,
  instructions: r.instructions,
  defaultModelId: r.defaultModelId,
  permissionMode: (r.permissionMode as PermissionMode | null) ?? null,
  enabledTools: r.enabledTools ?? null,
  enabledSkills: r.enabledSkills ?? null,
  enabledMcpServers: r.enabledMcpServers ?? null,
  archived: r.archived,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
  ...(conversationCount !== undefined ? { conversationCount } : {}),
});

/** Messages written before search_tsv existed get their tsvector computed lazily (bounded work per search). */
async function backfillMessageTsv(database: Database) {
  for (let round = 0; round < 4; round++) {
    const rows = await database.query<{ id: string; search_text: string }>(
      `SELECT id, search_text FROM messages WHERE search_tsv IS NULL AND search_text IS NOT NULL LIMIT 500`,
    );
    if (!rows.length) return;
    await database.query(
      `UPDATE messages AS m SET search_tsv = v.t::tsvector FROM unnest($1::uuid[], $2::text[]) AS v(id, t) WHERE m.id = v.id`,
      [rows.map((r) => r.id), rows.map((r) => toTsvectorLiteral(r.search_text))],
    );
    if (rows.length < 500) return;
  }
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

function snippetAround(text: string, q: string, radius = 40): string {
  const lower = text.toLowerCase();
  let i = lower.indexOf(q.toLowerCase());
  if (i < 0) {
    // token match (CJK bigrams / words need not be contiguous): centre on the first matching term
    for (const t of queryTerms(q)) {
      i = lower.indexOf(t.term);
      if (i >= 0) {
        q = t.term;
        break;
      }
    }
  }
  if (i < 0) return text.slice(0, radius * 2);
  const s = Math.max(0, i - radius);
  return `${s > 0 ? "…" : ""}${text.slice(s, i + q.length + radius)}${i + q.length + radius < text.length ? "…" : ""}`.replace(/\s+/g, " ");
}

/** Markdown export of one branch. */
export function branchToMarkdown(title: string, rows: { role: string; parts: Part[] }[]): string {
  const out: string[] = [`# ${title}`, ""];
  for (const r of rows) {
    const body: string[] = [];
    for (const p of r.parts) {
      if (p.type === "text") body.push(p.text);
      else if (p.type === "reasoning" && p.text) body.push(`<details><summary>思考過程</summary>\n\n${p.text}\n\n</details>`);
      else if (p.type === "tool_call") body.push(`**🔧 ${p.name}**\n\n\`\`\`json\n${JSON.stringify(p.args, null, 2)}\n\`\`\``);
      else if (p.type === "tool_result") body.push(`**${p.isError ? "⚠️" : "✅"} ${p.name} 結果**\n\n\`\`\`\n${resultToString(p.result).slice(0, 4000)}\n\`\`\``);
      else if (p.type === "image") body.push(`![圖片](${p.url ?? "（內嵌圖片）"})`);
      else if (p.type === "file") body.push(`📎 ${p.name}`);
    }
    if (!body.length) continue;
    const who = r.role === "user" ? "使用者" : r.role === "assistant" ? "助理" : r.role === "tool" ? "工具" : "系統";
    out.push(`## ${who}`, "", body.join("\n\n"), "");
  }
  return out.join("\n");
}

function parseTitle(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new BadInput("title 必須是字串");
  const t = v.trim().slice(0, 200);
  if (!t) throw new BadInput("標題不可為空");
  return t;
}

export function mountWorkspace(app: Hono<HonoEnv>, deps: AppDeps) {
  const registry = deps.tools ?? builtinRegistry();

  async function modelExists(c: Ctx, id: unknown): Promise<string | null> {
    if (id === null) return null;
    if (!isUuid(id)) throw new BadInput("modelId 格式錯誤");
    const [m] = await c.get("database").db.select({ id: models.id }).from(models).where(eq(models.id, id)).limit(1);
    if (!m) throw new BadInput("找不到指定的模型");
    return m.id;
  }

  async function projectExists(c: Ctx, id: unknown): Promise<string | null> {
    if (id === null) return null;
    if (!isUuid(id)) throw new BadInput("projectId 格式錯誤");
    const [p] = await c.get("database").db.select({ id: projects.id }).from(projects).where(eq(projects.id, id)).limit(1);
    if (!p) throw new BadInput("找不到專案");
    return p.id;
  }

  // ---------------- conversations ----------------

  app.get("/conversations", async (c) => {
    const db = c.get("database").db;
    const q = (c.req.query("q") ?? "").trim().slice(0, 200);
    const archived = c.req.query("archived") ?? "0";
    const projectId = c.req.query("projectId");
    const limit = Math.min(500, Math.max(1, Number(c.req.query("limit") ?? 200) || 200));
    const conds: SQL[] = [];
    if (archived === "0") conds.push(eq(conversations.archived, false));
    else if (archived === "1") conds.push(eq(conversations.archived, true));
    if (projectId === "none") conds.push(isNull(conversations.projectId));
    else if (isUuid(projectId)) conds.push(eq(conversations.projectId, projectId));
    else if (projectId !== undefined && projectId !== "") throw new BadInput("projectId 必須是專案 id 或 none"); // never silently list everything

    if (!q) {
      const rows = await db.select().from(conversations).where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(conversations.pinned), desc(conversations.updatedAt)).limit(limit);
      return c.json(rows.map((r) => convDTO(r)));
    }
    // Full-text over messages: app-tokenized tsvector (CJK bigrams + words, all terms must match; Latin words
    // prefix-matched), GIN-indexed. Titles: substring. Queries without searchable terms fall back to ILIKE.
    const like = `%${escapeLike(q)}%`;
    const tsq = toTsqueryLiteral(q, "and");
    let hits: { conversationId: string; text: string | null }[];
    if (tsq) {
      await backfillMessageTsv(c.get("database"));
      hits = await db
        .selectDistinctOn([messages.conversationId], { conversationId: messages.conversationId, text: messages.searchText })
        .from(messages)
        .where(sql`${messages.searchTsv} @@ ${tsq}::tsquery`)
        .orderBy(messages.conversationId, sql`ts_rank_cd(${messages.searchTsv}, ${tsq}::tsquery) DESC`, desc(messages.createdAt))
        .limit(1000);
    } else {
      hits = await db
        .selectDistinctOn([messages.conversationId], { conversationId: messages.conversationId, text: messages.searchText })
        .from(messages)
        .where(ilike(messages.searchText, like))
        .orderBy(messages.conversationId, desc(messages.createdAt))
        .limit(1000);
    }
    const hitText = new Map(hits.map((h) => [h.conversationId, h.text ?? ""]));
    const match = or(ilike(conversations.title, like), hitText.size ? inArray(conversations.id, [...hitText.keys()]) : sql`false`)!;
    const rows = await db.select().from(conversations).where(and(match, ...conds)).orderBy(desc(conversations.pinned), desc(conversations.updatedAt)).limit(limit);
    return c.json(rows.map((r) => convDTO(r, hitText.has(r.id) ? snippetAround(hitText.get(r.id)!, q) : (r.title ?? ""))));
  });

  app.get("/conversations/:id", async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) return c.json({ error: "not_found" }, 404);
    const [r] = await c.get("database").db.select().from(conversations).where(eq(conversations.id, id)).limit(1);
    if (!r) return c.json({ error: "not_found", message: "找不到對話" }, 404);
    return c.json(convDTO(r));
  });

  app.patch("/conversations/:id", async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") throw new BadInput("請求格式錯誤");
    const patch: Partial<typeof conversations.$inferInsert> = {};
    const title = parseTitle(body.title);
    if (title !== undefined) patch.title = title;
    if (body.pinned !== undefined) patch.pinned = !!body.pinned;
    if (body.archived !== undefined) patch.archived = !!body.archived;
    if (body.projectId !== undefined) patch.projectId = await projectExists(c, body.projectId);
    if (body.modelId !== undefined) patch.modelId = await modelExists(c, body.modelId);
    if (body.permissionMode !== undefined) {
      if (body.permissionMode !== null && !isPermissionMode(body.permissionMode)) throw new BadInput("未知的權限模式");
      patch.permissionMode = body.permissionMode;
    }
    if (!Object.keys(patch).length) throw new BadInput("沒有要更新的欄位");
    // pin/archive/rename should not reorder the list: keep updatedAt unless it is a move.
    const [r] = await c.get("database").db.update(conversations).set(patch).where(eq(conversations.id, id)).returning();
    if (!r) return c.json({ error: "not_found", message: "找不到對話" }, 404);
    return c.json(convDTO(r));
  });

  app.delete("/conversations/:id", async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) return c.json({ error: "not_found" }, 404);
    const r = await c.get("database").db.delete(conversations).where(eq(conversations.id, id)).returning({ id: conversations.id });
    if (!r.length) return c.json({ error: "not_found", message: "找不到對話" }, 404);
    return c.json({ ok: true });
  });

  app.put("/conversations/:id/active-leaf", async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    if (!isUuid(body?.leafId)) throw new BadInput("leafId 格式錯誤");
    const db = c.get("database").db;
    const [m] = await db.select({ id: messages.id }).from(messages).where(and(eq(messages.id, body.leafId), eq(messages.conversationId, id))).limit(1);
    if (!m) return c.json({ error: "not_found", message: "找不到訊息" }, 404);
    await db.update(conversations).set({ activeLeafId: m.id }).where(eq(conversations.id, id));
    return c.json({ ok: true, activeLeafId: m.id });
  });

  app.post("/conversations/:id/auto-title", async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) return c.json({ error: "not_found" }, 404);
    const database = c.get("database");
    const [conv] = await database.db.select().from(conversations).where(eq(conversations.id, id)).limit(1);
    if (!conv) return c.json({ error: "not_found", message: "找不到對話" }, 404);
    const branch = await loadBranch(database, id, conv.activeLeafId);
    const textOf = (role: string) =>
      branch.filter((m) => m.role === role).flatMap((m) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : []))).join("\n").slice(0, 1500);
    const userText = textOf("user");
    if (!userText.trim()) throw new BadInput("對話沒有內容可以命名");
    const assistantText = textOf("assistant");
    let modelId: string | null = null;
    for (const cand of [await getSetting(database, "title_model_id"), conv.modelId, branch.find((m) => m.modelId)?.modelId, await getSetting(database, "default_model_id")]) {
      modelId = await usableModelId(database, cand);
      if (modelId) break;
    }
    if (!modelId) return c.json({ error: "no_model", message: "沒有可用的模型" }, 400);
    const model = await resolveModel(database, c.get("encKey"), modelId, deps.fetch);
    const spend = await spendStatus(database);
    if (spend.daily === "blocked" || spend.monthly === "blocked") return c.json({ error: "spend_cap", message: spend.message }, 429);
    const b = await collect(
      streamChat(model.cfg, {
        model: model.model,
        system: "你負責替對話取標題。只輸出標題本身：不超過 20 個字、不加引號或句號；使用者用中文時用正體中文。",
        messages: [{ role: "user", parts: [{ type: "text", text: `使用者：${userText}\n\n助理：${assistantText.slice(0, 800)}\n\n請為這段對話取一個簡短標題。` }] }],
        maxTokens: 60,
      }),
    );
    if (b.usage) await recordLlmUsage(database, { providerId: model.providerId, model: model.model, modelRowId: model.modelRowId, conversationId: id, usage: b.usage }).catch(() => {});
    const raw = b.message().parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("").trim();
    const title = raw.split("\n").map((l) => l.trim()).find(Boolean)?.replace(/^["'「『《#*\s]+|["'」』》*。.\s]+$/g, "").slice(0, 60);
    if (b.error || !title) return c.json({ error: "title_failed", message: b.error?.message ?? "模型沒有回傳標題" }, 502);
    const [r] = await database.db.update(conversations).set({ title }).where(eq(conversations.id, id)).returning();
    return c.json(convDTO(r));
  });

  app.get("/conversations/:id/export", async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) return c.json({ error: "not_found" }, 404);
    const database = c.get("database");
    const [conv] = await database.db.select().from(conversations).where(eq(conversations.id, id)).limit(1);
    if (!conv) return c.json({ error: "not_found", message: "找不到對話" }, 404);
    const format = c.req.query("format") === "json" ? "json" : "md";
    const branch = await loadBranch(database, id, conv.activeLeafId);
    const title = conv.title ?? "對話";
    const safe = encodeURIComponent(title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 80));
    if (format === "json") {
      const body = JSON.stringify({
        conversation: convDTO(conv),
        exportedAt: new Date().toISOString(),
        messages: branch.map((m) => ({ id: m.id, parentId: m.parentId, role: m.role, parts: m.parts, createdAt: m.createdAt.toISOString() })),
      }, null, 2);
      return c.body(body, 200, { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename*=UTF-8''${safe}.json` });
    }
    return c.body(branchToMarkdown(title, branch), 200, { "content-type": "text/markdown; charset=utf-8", "content-disposition": `attachment; filename*=UTF-8''${safe}.md` });
  });

  // ---------------- projects ----------------

  async function parseProject(c: Ctx, body: any, create: boolean): Promise<Partial<typeof projects.$inferInsert>> {
    if (!body || typeof body !== "object") throw new BadInput("請求格式錯誤");
    const out: Partial<typeof projects.$inferInsert> = {};
    if (body.name !== undefined || create) {
      if (typeof body.name !== "string" || !body.name.trim()) throw new BadInput("請輸入專案名稱");
      out.name = body.name.trim().slice(0, 100);
    }
    for (const k of ["description", "instructions"] as const) {
      if (body[k] === undefined) continue;
      if (body[k] !== null && typeof body[k] !== "string") throw new BadInput(`${k} 必須是字串`);
      if (typeof body[k] === "string" && body[k].length > 50_000) throw new BadInput(`${k} 過長`);
      out[k] = body[k] === null ? null : body[k];
    }
    if (body.defaultModelId !== undefined) out.defaultModelId = await modelExists(c, body.defaultModelId);
    if (body.permissionMode !== undefined) {
      if (body.permissionMode !== null && !isPermissionMode(body.permissionMode)) throw new BadInput("未知的權限模式");
      out.permissionMode = body.permissionMode;
    }
    if (body.enabledTools !== undefined) {
      if (body.enabledTools !== null && (!Array.isArray(body.enabledTools) || body.enabledTools.some((t: unknown) => typeof t !== "string" || t.length > 200)))
        throw new BadInput("enabledTools 必須是工具名稱陣列或 null");
      out.enabledTools = body.enabledTools === null ? null : [...new Set<string>(body.enabledTools)];
    }
    if (body.enabledSkills !== undefined) {
      if (body.enabledSkills !== null && (!Array.isArray(body.enabledSkills) || body.enabledSkills.some((t: unknown) => typeof t !== "string" || t.length > 100)))
        throw new BadInput("enabledSkills 必須是 Skill id 陣列或 null");
      out.enabledSkills = body.enabledSkills === null ? null : [...new Set<string>(body.enabledSkills)];
    }
    if (body.enabledMcpServers !== undefined) {
      if (body.enabledMcpServers !== null && (!Array.isArray(body.enabledMcpServers) || body.enabledMcpServers.some((t: unknown) => typeof t !== "string" || t.length > 100)))
        throw new BadInput("enabledMcpServers 必須是 MCP 伺服器 id 陣列或 null");
      out.enabledMcpServers = body.enabledMcpServers === null ? null : [...new Set<string>(body.enabledMcpServers)];
    }
    if (body.archived !== undefined) out.archived = !!body.archived;
    return out;
  }

  app.get("/projects", async (c) => {
    const db = c.get("database").db;
    const includeArchived = c.req.query("archived") === "all";
    const rows = await db.select().from(projects).where(includeArchived ? undefined : eq(projects.archived, false)).orderBy(desc(projects.updatedAt));
    const counts = await db.select({ p: conversations.projectId, n: sql<number>`count(*)::int` }).from(conversations).where(eq(conversations.archived, false)).groupBy(conversations.projectId);
    const byId = new Map(counts.map((r) => [r.p, Number(r.n)]));
    return c.json(rows.map((r) => projDTO(r, byId.get(r.id) ?? 0)));
  });

  app.post("/projects", async (c) => {
    const body = await c.req.json().catch(() => null);
    const v = await parseProject(c, body, true);
    const [r] = await c.get("database").db.insert(projects).values(v as typeof projects.$inferInsert).returning();
    return c.json(projDTO(r, 0), 201);
  });

  app.get("/projects/:id", async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) return c.json({ error: "not_found" }, 404);
    const [r] = await c.get("database").db.select().from(projects).where(eq(projects.id, id)).limit(1);
    if (!r) return c.json({ error: "not_found", message: "找不到專案" }, 404);
    return c.json(projDTO(r));
  });

  app.patch("/projects/:id", async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    const v = await parseProject(c, body, false);
    if (!Object.keys(v).length) throw new BadInput("沒有要更新的欄位");
    const [r] = await c.get("database").db.update(projects).set({ ...v, updatedAt: new Date() }).where(eq(projects.id, id)).returning();
    if (!r) return c.json({ error: "not_found", message: "找不到專案" }, 404);
    return c.json(projDTO(r));
  });

  app.delete("/projects/:id", async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) return c.json({ error: "not_found" }, 404);
    // Conversations are kept (project_id → null); project file objects are purged from S3, rows cascade.
    await fileStore(c, deps).purgeProject(id).catch((e) => console.error("[edgemind] purge project files failed", e));
    const r = await c.get("database").db.delete(projects).where(eq(projects.id, id)).returning({ id: projects.id });
    if (!r.length) return c.json({ error: "not_found", message: "找不到專案" }, 404);
    return c.json({ ok: true });
  });

  // ---------------- models / tools / agent settings ----------------

  app.get("/models", async (c) => {
    const rows = await c.get("database").db
      .select({ m: models, p: { id: providers.id, name: providers.name } })
      .from(models)
      .innerJoin(providers, eq(providers.id, models.providerId))
      .where(and(eq(providers.type, "llm"), eq(providers.enabled, true), eq(models.enabled, true)))
      .orderBy(asc(providers.priority), asc(providers.name), asc(models.modelId));
    const out: ModelOptionDTO[] = rows.map(({ m, p }) => ({
      id: m.id, modelId: m.modelId, displayName: m.displayName, providerId: p.id, providerName: p.name,
      capabilities: m.capabilities ?? {}, contextLength: m.contextLength,
    }));
    return c.json(out);
  });

  app.get("/tools", async (c) => {
    const mcp = await buildMcpTools(c.get("database"), null).catch(() => []);
    const out: ToolInfoDTO[] = registry.withTools(mcp).list().map((t) => ({
      name: t.name, description: t.description, risk: t.risk,
      ...(t.interactive ? { interactive: true } : {}), ...(t.projectOnly ? { projectOnly: true } : {}),
    }));
    return c.json(out);
  });

  app.get("/settings/agent", async (c) => {
    const database = c.get("database");
    const out: AgentSettingsDTO = {
      // stale references (model removed / disabled since) read as "not set", so pickers and new chats never use them
      defaultModelId: await usableModelId(database, await getSetting(database, "default_model_id")),
      maxSteps: (await getSetting<number>(database, "max_steps")) ?? DEFAULT_MAX_STEPS,
      fullModeCaps: normalizeCaps((await getSetting(database, "full_mode_caps")) ?? DEFAULT_FULL_CAPS),
      modelPrices: (await getSetting(database, "model_prices")) ?? {},
      titleModelId: await usableModelId(database, await getSetting(database, "title_model_id")),
    };
    return c.json(out);
  });

  app.put("/settings/agent", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") throw new BadInput("請求格式錯誤");
    const database = c.get("database");
    if (body.defaultModelId !== undefined) await setSetting(database, "default_model_id", await modelExists(c, body.defaultModelId));
    if (body.titleModelId !== undefined) await setSetting(database, "title_model_id", await modelExists(c, body.titleModelId));
    if (body.maxSteps !== undefined) {
      if (!Number.isInteger(body.maxSteps) || body.maxSteps < 1 || body.maxSteps > 200) throw new BadInput("步數上限必須是 1–200 的整數");
      await setSetting(database, "max_steps", body.maxSteps);
    }
    if (body.fullModeCaps !== undefined) await setSetting(database, "full_mode_caps", normalizeCaps(body.fullModeCaps));
    if (body.modelPrices !== undefined) {
      if (!body.modelPrices || typeof body.modelPrices !== "object") throw new BadInput("modelPrices 格式錯誤");
      const prices: AgentSettingsDTO["modelPrices"] = {};
      for (const [k, v] of Object.entries(body.modelPrices as Record<string, any>)) {
        if (!isUuid(k)) continue;
        const input = Number(v?.input ?? 0), output = Number(v?.output ?? 0);
        const cached = v?.cachedInput === undefined || v?.cachedInput === null || v?.cachedInput === "" ? undefined : Number(v.cachedInput);
        if (!(input >= 0) || !(output >= 0) || (cached !== undefined && !(cached >= 0))) throw new BadInput("價格必須是非負數");
        if (input || output || cached) prices[k] = { input, output, ...(cached !== undefined ? { cachedInput: cached } : {}) };
      }
      await setSetting(database, "model_prices", prices);
    }
    return c.json({ ok: true });
  });
}
