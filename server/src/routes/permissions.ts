/**
 * Permission settings: mode per scope (global / project / conversation; null = inherit) and per-tool policies.
 *   GET    /api/permissions?projectId=&conversationId=   effective + per-scope modes, policies, tool list
 *   PUT    /api/permissions/mode        { scope, scopeId?, mode | null }
 *   POST   /api/permissions/policies    { scope, scopeId?, toolName, action, rule? }
 *   DELETE /api/permissions/policies/:id
 */
import type { Hono } from "hono";
import { and, eq, isNull, or } from "drizzle-orm";
import type { PolicyRule, PolicyScope } from "@edgemind/shared";
import type { AppDeps, Ctx, HonoEnv } from "../context";
import { auditLogs, conversations, projects, settings, toolPolicies } from "../db/schema";
import { BadInput } from "../lib/errors";
import { globalMode, isPermissionMode, resolveMode } from "../agent/permissions";
import { builtinRegistry } from "../agent/tools";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCOPES: PolicyScope[] = ["global", "project", "conversation"];

function parseScope(body: any): { scope: PolicyScope; scopeId: string | null } {
  const scope = body?.scope as PolicyScope;
  if (!SCOPES.includes(scope)) throw new BadInput("scope 必須是 global、project 或 conversation");
  if (scope === "global") return { scope, scopeId: null };
  if (typeof body.scopeId !== "string" || !UUID.test(body.scopeId)) throw new BadInput("scopeId 格式錯誤");
  return { scope, scopeId: body.scopeId };
}

function parseRule(v: unknown): PolicyRule | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "object" || Array.isArray(v)) throw new BadInput("rule 格式錯誤");
  const r = v as Record<string, unknown>;
  const out: PolicyRule = {};
  if (r.pathGlob !== undefined) {
    const g = Array.isArray(r.pathGlob) ? r.pathGlob : [r.pathGlob];
    if (!g.length || g.length > 50 || !g.every((x) => typeof x === "string" && x.length > 0 && x.length <= 300)) throw new BadInput("pathGlob 格式錯誤");
    out.pathGlob = g as string[];
  }
  if (r.domains !== undefined) {
    if (!Array.isArray(r.domains) || !r.domains.length || r.domains.length > 100 || !r.domains.every((d) => typeof d === "string" && /^(\*\.)?[a-z0-9.-]+$/i.test(d))) {
      throw new BadInput("domains 格式錯誤（例：api.example.com 或 *.example.com）");
    }
    out.domains = (r.domains as string[]).map((d) => d.toLowerCase());
  }
  return out.pathGlob || out.domains ? out : null;
}

export function mountPermissions(app: Hono<HonoEnv>, deps: AppDeps) {
  const registry = deps.tools ?? builtinRegistry();
  const audit = (c: Ctx, detail: Record<string, unknown>) => c.get("database").db.insert(auditLogs).values({ action: "permissions_change", detail });

  app.get("/permissions", async (c) => {
    const database = c.get("database");
    const db = database.db;
    const projectId = c.req.query("projectId");
    const conversationId = c.req.query("conversationId");
    const out: Record<string, unknown> = { globalMode: await globalMode(database) };
    const conds = [and(eq(toolPolicies.scope, "global"), isNull(toolPolicies.scopeId))];
    if (projectId && UUID.test(projectId)) {
      const [p] = await db.select({ m: projects.permissionMode }).from(projects).where(eq(projects.id, projectId)).limit(1);
      out.projectMode = p?.m ?? null;
      conds.push(and(eq(toolPolicies.scope, "project"), eq(toolPolicies.scopeId, projectId)));
    }
    if (conversationId && UUID.test(conversationId)) {
      const [cv] = await db.select({ m: conversations.permissionMode }).from(conversations).where(eq(conversations.id, conversationId)).limit(1);
      out.conversationMode = cv?.m ?? null;
      out.effectiveMode = (await resolveMode(database, conversationId)).mode;
      conds.push(and(eq(toolPolicies.scope, "conversation"), eq(toolPolicies.scopeId, conversationId)));
    }
    out.policies = await db.select().from(toolPolicies).where(or(...conds));
    out.tools = registry.list().map((t) => ({ name: t.name, description: t.description, risk: t.risk }));
    return c.json(out);
  });

  app.put("/permissions/mode", async (c) => {
    const body = await c.req.json().catch(() => null);
    const { scope, scopeId } = parseScope(body);
    const mode = body?.mode ?? null;
    if (mode !== null && !isPermissionMode(mode)) throw new BadInput("未知的權限模式");
    const db = c.get("database").db;
    if (scope === "global") {
      if (mode === null) throw new BadInput("全域模式不可為空");
      await db.insert(settings).values({ key: "permission_mode", value: mode }).onConflictDoUpdate({ target: settings.key, set: { value: mode, updatedAt: new Date() } });
    } else if (scope === "project") {
      const r = await db.update(projects).set({ permissionMode: mode, updatedAt: new Date() }).where(eq(projects.id, scopeId!)).returning({ id: projects.id });
      if (!r.length) return c.json({ error: "not_found", message: "找不到專案" }, 404);
    } else {
      const r = await db.update(conversations).set({ permissionMode: mode, updatedAt: new Date() }).where(eq(conversations.id, scopeId!)).returning({ id: conversations.id });
      if (!r.length) return c.json({ error: "not_found", message: "找不到對話" }, 404);
    }
    await audit(c, { scope, scopeId, mode });
    return c.json({ ok: true, scope, scopeId, mode });
  });

  app.post("/permissions/policies", async (c) => {
    const body = await c.req.json().catch(() => null);
    const { scope, scopeId } = parseScope(body);
    const toolName = body?.toolName;
    if (typeof toolName !== "string" || !/^[\w:*./-]{1,200}$/.test(toolName)) throw new BadInput("toolName 格式錯誤");
    if (!["allow", "ask", "deny"].includes(body?.action)) throw new BadInput("action 必須是 allow、ask 或 deny");
    const rule = parseRule(body?.rule);
    const [row] = await c.get("database").db.insert(toolPolicies).values({ scope, scopeId, toolName, action: body.action, rule }).returning();
    await audit(c, { op: "policy_create", id: row.id, scope, scopeId, toolName, action: body.action, rule });
    return c.json(row, 201);
  });

  app.delete("/permissions/policies/:id", async (c) => {
    const id = c.req.param("id");
    if (!UUID.test(id)) return c.json({ error: "not_found" }, 404);
    const r = await c.get("database").db.delete(toolPolicies).where(eq(toolPolicies.id, id)).returning({ id: toolPolicies.id });
    if (!r.length) return c.json({ error: "not_found", message: "找不到規則" }, 404);
    await audit(c, { op: "policy_delete", id });
    return c.json({ ok: true });
  });
}
