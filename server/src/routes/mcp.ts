/**
 * MCP API (remote servers only):
 *   GET    /api/mcp/servers                      list (auth status, tool counts; never secrets)
 *   POST   /api/mcp/servers                      McpServerInput → create + try to sync tools
 *   PATCH  /api/mcp/servers/:id                  McpServerInput (secrets replaced only when given)
 *   DELETE /api/mcp/servers/:id
 *   POST   /api/mcp/servers/:id/sync             initialize + tools/list
 *   GET    /api/mcp/servers/:id/tools
 *   PATCH  /api/mcp/tools/:id                    { enabled?, riskLevel? }
 *   POST   /api/mcp/servers/:id/oauth/start      → { authorizeUrl }  (browser navigates there)
 *   GET    /api/mcp/oauth/callback?code&state     public; single-use state; redirects to /settings?tab=mcp
 *   POST   /api/mcp/servers/:id/oauth/logout     forget tokens
 */
import type { Hono } from "hono";
import { and, asc, eq, sql } from "drizzle-orm";
import { RISK_LEVELS, type McpServerDTO, type McpServerInput, type McpSyncResponse, type McpToolDTO, type RiskLevel } from "@edgemind/shared";
import type { AppDeps, Ctx, HonoEnv } from "../context";
import { mcpServers, mcpTools, projects } from "../db/schema";
import { BadInput } from "../lib/errors";
import { McpAuthRequired } from "../mcp/client";
import { exchangeCode, startAuthorization } from "../mcp/oauth";
import { authStatus, loadAuth, mcpToolName, saveAuth, syncServer, uniquePrefix, type McpAuth, type McpServerRow, type McpToolRow } from "../mcp/service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRANSPORTS = ["streamable_http", "sse"];
const AUTH_TYPES = ["none", "bearer", "headers", "oauth"];
const FORBIDDEN_HEADERS = /^(host|content-length|content-type|accept|connection|transfer-encoding|mcp-session-id|mcp-protocol-version|cookie)$/i;

export function toToolDTO(server: Pick<McpServerRow, "toolPrefix">, t: McpToolRow): McpToolDTO {
  return {
    id: t.id, serverId: t.serverId, name: t.name, qualifiedName: mcpToolName(server.toolPrefix ?? "server", t.name), title: t.title, description: t.description,
    inputSchema: t.inputSchema, annotations: t.annotations ?? null, enabled: t.enabled, riskLevel: t.riskLevel as RiskLevel, riskCustomized: t.riskCustomized,
  };
}

async function toServerDTO(c: Ctx, r: McpServerRow): Promise<McpServerDTO> {
  const auth = await loadAuth(r, c.get("encKey"));
  const [n] = await c.get("database").db
    .select({ total: sql<number>`count(*)::int`, on: sql<number>`count(*) filter (where ${mcpTools.enabled})::int` })
    .from(mcpTools).where(eq(mcpTools.serverId, r.id));
  return {
    id: r.id, name: r.name, url: r.url, transport: r.transport as McpServerDTO["transport"], authType: r.authType as McpServerDTO["authType"],
    authStatus: authStatus(r, auth), headerNames: Object.keys(auth.headers ?? {}), oauthClientId: auth.oauth?.clientId ?? null, oauthScope: auth.oauth?.scope ?? null,
    enabled: r.enabled, toolPrefix: r.toolPrefix ?? "", serverInfo: r.serverInfo ?? null, instructions: r.instructions, lastError: r.lastError,
    lastSyncedAt: r.lastSyncedAt?.toISOString() ?? null, toolCount: Number(n?.total ?? 0), enabledToolCount: Number(n?.on ?? 0), createdAt: r.createdAt.toISOString(),
  };
}

function checkUrl(v: unknown): string {
  if (typeof v !== "string") throw new BadInput("請輸入 MCP 伺服器網址");
  let u: URL;
  try {
    u = new URL(v.trim());
  } catch {
    throw new BadInput("網址格式錯誤");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new BadInput("只支援 http(s) 遠端 MCP 伺服器（Serverless 無法執行 stdio）");
  if (u.username || u.password) throw new BadInput("網址不可包含帳號密碼，請改用 Bearer 或自訂 Header");
  return u.toString();
}

/** Validate input; returns the row patch and the auth patch (undefined = keep). */
function parseInput(body: any, create: boolean): { row: Partial<typeof mcpServers.$inferInsert>; auth: (a: McpAuth) => McpAuth } {
  if (!body || typeof body !== "object") throw new BadInput("請求格式錯誤");
  const row: Partial<typeof mcpServers.$inferInsert> = {};
  if (body.name !== undefined || create) {
    if (typeof body.name !== "string" || !body.name.trim()) throw new BadInput("請輸入名稱");
    row.name = body.name.trim().slice(0, 80);
  }
  if (body.url !== undefined || create) row.url = checkUrl(body.url);
  if (body.transport !== undefined) {
    if (!TRANSPORTS.includes(body.transport)) throw new BadInput("transport 只能是 streamable_http 或 sse");
    row.transport = body.transport;
  }
  if (body.authType !== undefined) {
    if (!AUTH_TYPES.includes(body.authType)) throw new BadInput("未知的授權方式");
    row.authType = body.authType;
  }
  if (body.enabled !== undefined) row.enabled = !!body.enabled;
  const input = body as McpServerInput;
  if (input.headers !== undefined) {
    if (!input.headers || typeof input.headers !== "object" || Array.isArray(input.headers)) throw new BadInput("headers 必須是物件");
    for (const [k, v] of Object.entries(input.headers)) {
      if (!/^[A-Za-z0-9-]{1,100}$/.test(k) || FORBIDDEN_HEADERS.test(k)) throw new BadInput(`不允許的 Header：${k}`);
      if (typeof v !== "string" || v.length > 4000 || /[\r\n]/.test(v)) throw new BadInput(`Header ${k} 的值無效`);
    }
  }
  if (input.bearer !== undefined && (typeof input.bearer !== "string" || input.bearer.length > 4000 || /[\r\n]/.test(input.bearer))) throw new BadInput("Bearer token 無效");
  const auth = (a: McpAuth): McpAuth => {
    const out: McpAuth = { ...a };
    if (input.bearer !== undefined) out.bearer = input.bearer.trim() || undefined;
    if (input.headers !== undefined) out.headers = input.headers;
    if (input.oauthClientId !== undefined || input.oauthClientSecret !== undefined || input.oauthScope !== undefined) {
      const o = { ...(out.oauth ?? {}) };
      if (input.oauthClientId !== undefined) {
        const next = input.oauthClientId?.trim() || undefined;
        if (next !== o.clientId) {
          // a different client invalidates everything obtained with the old one
          delete o.tokens;
          delete o.pending;
          delete o.clientSecret;
        }
        o.clientId = next;
      }
      if (input.oauthClientSecret !== undefined) o.clientSecret = input.oauthClientSecret?.trim() || undefined;
      if (input.oauthScope !== undefined) o.scope = input.oauthScope?.trim() || undefined;
      out.oauth = o;
    }
    return out;
  };
  return { row, auth };
}

export function mountMcp(app: Hono<HonoEnv>, deps: AppDeps) {
  const fetchFn = (): typeof fetch => deps.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const load = async (c: Ctx): Promise<McpServerRow | undefined> => {
    const id = c.req.param("id") ?? "";
    if (!UUID.test(id)) throw new BadInput("無效的 id");
    const [r] = await c.get("database").db.select().from(mcpServers).where(eq(mcpServers.id, id)).limit(1);
    return r;
  };
  const toolsOf = async (c: Ctx, r: McpServerRow) =>
    (await c.get("database").db.select().from(mcpTools).where(eq(mcpTools.serverId, r.id)).orderBy(asc(mcpTools.name))).map((t) => toToolDTO(r, t));

  async function trySync(c: Ctx, r: McpServerRow): Promise<McpSyncResponse> {
    try {
      const res = await syncServer(c.get("database"), c.get("encKey"), fetchFn(), r);
      const [fresh] = await c.get("database").db.select().from(mcpServers).where(eq(mcpServers.id, r.id));
      return { server: await toServerDTO(c, fresh), tools: res.tools.map((t) => toToolDTO(fresh, t)), added: res.added, removed: res.removed };
    } catch (e) {
      const [fresh] = await c.get("database").db.select().from(mcpServers).where(eq(mcpServers.id, r.id));
      const needsAuth = e instanceof McpAuthRequired || (fresh.authType === "oauth" && authStatus(fresh, await loadAuth(fresh, c.get("encKey"))) === "needs_auth");
      return { server: await toServerDTO(c, fresh), tools: await toolsOf(c, fresh), needsAuth, error: (e as Error).message };
    }
  }

  app.get("/mcp/servers", async (c) => {
    const rows = await c.get("database").db.select().from(mcpServers).orderBy(asc(mcpServers.name));
    return c.json(await Promise.all(rows.map((r) => toServerDTO(c, r))));
  });

  app.post("/mcp/servers", async (c) => {
    const body = await c.req.json().catch(() => null);
    const { row, auth } = parseInput(body, true);
    const database = c.get("database");
    const [created] = await database.db
      .insert(mcpServers)
      .values({ name: row.name!, url: row.url!, transport: row.transport ?? "streamable_http", authType: row.authType ?? "none", enabled: row.enabled ?? true, toolPrefix: await uniquePrefix(database, row.name!) })
      .returning();
    await saveAuth(database, created.id, auth({}), c.get("encKey"));
    const [fresh] = await database.db.select().from(mcpServers).where(eq(mcpServers.id, created.id));
    if (fresh.authType === "oauth" && authStatus(fresh, await loadAuth(fresh, c.get("encKey"))) === "needs_auth")
      return c.json({ server: await toServerDTO(c, fresh), tools: [], needsAuth: true } satisfies McpSyncResponse, 201);
    return c.json(await trySync(c, fresh), 201);
  });

  app.patch("/mcp/servers/:id", async (c) => {
    const r = await load(c);
    if (!r) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    const { row, auth } = parseInput(body, false);
    const database = c.get("database");
    const patch: Partial<typeof mcpServers.$inferInsert> = { ...row, updatedAt: new Date() };
    if (row.name && row.name !== r.name) patch.toolPrefix = await uniquePrefix(database, row.name, r.id);
    if ((row.url && row.url !== r.url) || (row.transport && row.transport !== r.transport)) Object.assign(patch, { sessionId: null, protocolVersion: null });
    await database.db.update(mcpServers).set(patch).where(eq(mcpServers.id, r.id));
    const [cur] = await database.db.select().from(mcpServers).where(eq(mcpServers.id, r.id));
    let a = auth(await loadAuth(cur, c.get("encKey")));
    if (row.url && row.url !== r.url && a.oauth) a = { ...a, oauth: { clientId: a.oauth.clientId, clientSecret: a.oauth.clientSecret, scope: a.oauth.scope } };
    await saveAuth(database, r.id, a, c.get("encKey"));
    const [fresh] = await database.db.select().from(mcpServers).where(eq(mcpServers.id, r.id));
    return c.json(await toServerDTO(c, fresh));
  });

  app.delete("/mcp/servers/:id", async (c) => {
    const r = await load(c);
    if (!r) return c.json({ error: "not_found" }, 404);
    const db = c.get("database").db;
    await db.delete(mcpServers).where(eq(mcpServers.id, r.id));
    const ps = await db.select({ id: projects.id, s: projects.enabledMcpServers }).from(projects);
    for (const p of ps) if (Array.isArray(p.s) && p.s.includes(r.id)) await db.update(projects).set({ enabledMcpServers: p.s.filter((x) => x !== r.id) }).where(eq(projects.id, p.id));
    return c.json({ ok: true });
  });

  app.post("/mcp/servers/:id/sync", async (c) => {
    const r = await load(c);
    if (!r) return c.json({ error: "not_found" }, 404);
    return c.json(await trySync(c, r));
  });

  app.get("/mcp/servers/:id/tools", async (c) => {
    const r = await load(c);
    if (!r) return c.json({ error: "not_found" }, 404);
    return c.json(await toolsOf(c, r));
  });

  app.patch("/mcp/tools/:id", async (c) => {
    const id = c.req.param("id");
    if (!UUID.test(id)) throw new BadInput("無效的 id");
    const body = await c.req.json().catch(() => null);
    const patch: Partial<typeof mcpTools.$inferInsert> = {};
    if (body?.enabled !== undefined) patch.enabled = !!body.enabled;
    if (body?.riskLevel !== undefined) {
      if (!(RISK_LEVELS as readonly string[]).includes(body.riskLevel)) throw new BadInput("未知的風險等級");
      patch.riskLevel = body.riskLevel;
      patch.riskCustomized = true;
    }
    if (!Object.keys(patch).length) throw new BadInput("沒有要更新的欄位");
    const db = c.get("database").db;
    const [t] = await db.update(mcpTools).set(patch).where(eq(mcpTools.id, id)).returning();
    if (!t) return c.json({ error: "not_found" }, 404);
    const [s] = await db.select().from(mcpServers).where(eq(mcpServers.id, t.serverId));
    return c.json(toToolDTO(s, t));
  });

  app.post("/mcp/servers/:id/oauth/start", async (c) => {
    const r = await load(c);
    if (!r) return c.json({ error: "not_found" }, 404);
    if (r.authType !== "oauth") throw new BadInput("這個伺服器的授權方式不是 OAuth");
    const auth = await loadAuth(r, c.get("encKey"));
    const redirectUri = `${new URL(c.req.url).origin}/api/mcp/oauth/callback`;
    // Probe the server for its WWW-Authenticate hint (resource_metadata); ignore failures.
    let www: string | null = null;
    try {
      const probe = await fetchFn()(r.url, {
        method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "EdgeMind", version: "0.1.0" } } }),
        signal: AbortSignal.timeout(10_000),
      });
      www = probe.headers.get("www-authenticate");
      await probe.body?.cancel().catch(() => {});
    } catch {
      /* discovery falls back to well-known URLs */
    }
    const { state, authorizeUrl } = await startAuthorization(fetchFn(), auth.oauth ?? {}, r.url, redirectUri, www).catch((e) => {
      throw new BadInput((e as Error).message);
    });
    await saveAuth(c.get("database"), r.id, { ...auth, oauth: state }, c.get("encKey"));
    await c.get("database").db.update(mcpServers).set({ oauthState: state.pending!.state }).where(eq(mcpServers.id, r.id));
    return c.json({ authorizeUrl });
  });

  app.post("/mcp/servers/:id/oauth/logout", async (c) => {
    const r = await load(c);
    if (!r) return c.json({ error: "not_found" }, 404);
    const auth = await loadAuth(r, c.get("encKey"));
    if (auth.oauth) auth.oauth = { clientId: auth.oauth.clientId, clientSecret: auth.oauth.clientSecret, scope: auth.oauth.scope };
    await saveAuth(c.get("database"), r.id, auth, c.get("encKey"));
    await c.get("database").db.update(mcpServers).set({ sessionId: null, protocolVersion: null, oauthState: null }).where(eq(mcpServers.id, r.id));
    const [fresh] = await c.get("database").db.select().from(mcpServers).where(eq(mcpServers.id, r.id));
    return c.json(await toServerDTO(c, fresh));
  });

  app.get("/mcp/oauth/callback", async (c) => {
    const back = (status: "ok" | "error", msg?: string) =>
      c.redirect(`/settings?tab=mcp&oauth=${status}${msg ? `&message=${encodeURIComponent(msg.slice(0, 200))}` : ""}`, 302);
    const state = c.req.query("state") ?? "";
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(state)) return back("error", "授權回呼缺少 state");
    const database = c.get("database");
    const [r] = await database.db.select().from(mcpServers).where(and(eq(mcpServers.oauthState, state))).limit(1);
    if (!r) return back("error", "授權已失效或已使用，請重新授權");
    await database.db.update(mcpServers).set({ oauthState: null }).where(eq(mcpServers.id, r.id)); // single use
    const auth = await loadAuth(r, c.get("encKey"));
    if (!auth.oauth?.pending || auth.oauth.pending.state !== state) return back("error", "授權狀態不符，請重新授權");
    const err = c.req.query("error");
    if (err) {
      auth.oauth = { ...auth.oauth, pending: undefined };
      await saveAuth(database, r.id, auth, c.get("encKey"));
      return back("error", `${err}${c.req.query("error_description") ? `：${c.req.query("error_description")}` : ""}`);
    }
    const code = c.req.query("code");
    if (!code) return back("error", "授權回呼缺少 code");
    try {
      auth.oauth = await exchangeCode(fetchFn(), auth.oauth, code);
    } catch (e) {
      return back("error", (e as Error).message);
    }
    await saveAuth(database, r.id, auth, c.get("encKey"));
    await database.db.update(mcpServers).set({ sessionId: null, protocolVersion: null, lastError: null }).where(eq(mcpServers.id, r.id));
    const [fresh] = await database.db.select().from(mcpServers).where(eq(mcpServers.id, r.id));
    try {
      await syncServer(database, c.get("encKey"), fetchFn(), fresh);
    } catch {
      /* the settings page shows lastError */
    }
    return back("ok");
  });
}
