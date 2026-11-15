/**
 * MCP servers ↔ DB: encrypted auth (bearer / custom headers / OAuth state), session reuse, tool sync,
 * and model-facing tools `mcp__{prefix}__{tool}` built per run from the enabled servers/tools.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import type { RiskLevel } from "../../../shared/src/index";
import type { Database } from "../db/client";
import { mcpServers, mcpTools, projects } from "../db/schema";
import { decryptSecret, encryptSecret } from "../lib/crypto";
import type { Tool } from "../agent/tools";
import { McpAuthRequired, McpClient, McpError, toolResultText, type McpTransport } from "./client";
import { refreshTokens, tokenFresh, type OAuthState } from "./oauth";

export type McpServerRow = typeof mcpServers.$inferSelect;
export type McpToolRow = typeof mcpTools.$inferSelect;
type Fetch = typeof fetch;

export interface McpAuth {
  bearer?: string;
  headers?: Record<string, string>;
  oauth?: OAuthState;
}

const aad = (id: string) => `mcp:${id}`;

export async function loadAuth(row: McpServerRow, encKey: Uint8Array): Promise<McpAuth> {
  if (!row.authEnc) return {};
  try {
    return JSON.parse(await decryptSecret(row.authEnc, encKey, aad(row.id)));
  } catch {
    return {};
  }
}

export async function saveAuth(database: Database, id: string, auth: McpAuth, encKey: Uint8Array): Promise<void> {
  const authEnc = Object.keys(auth).length ? await encryptSecret(JSON.stringify(auth), encKey, aad(id)) : null;
  await database.db.update(mcpServers).set({ authEnc, updatedAt: new Date() }).where(eq(mcpServers.id, id));
}

export function slugPrefix(name: string): string {
  const s = name.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 20);
  return s || "server";
}

export async function uniquePrefix(database: Database, name: string, exceptId?: string): Promise<string> {
  const base = slugPrefix(name);
  const rows = await database.db.select({ id: mcpServers.id, p: mcpServers.toolPrefix }).from(mcpServers);
  const taken = new Set(rows.filter((r) => r.id !== exceptId).map((r) => r.p));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}${i}`)) return `${base}${i}`;
}

function shortHash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36).slice(0, 6);
}

/** Model-facing tool name (≤ 64 chars of [a-zA-Z0-9_-]). */
export function mcpToolName(prefix: string, tool: string): string {
  const clean = tool.replace(/[^a-zA-Z0-9_-]/g, "_");
  const full = `mcp__${prefix}__${clean}`;
  if (full.length <= 64 && clean === tool) return full;
  const head = `mcp__${prefix}__`;
  return `${head}${clean.slice(0, 64 - head.length - 7)}_${shortHash(tool)}`;
}

/** Default risk from MCP annotations (hints are untrusted, so only used as a starting point). */
export function defaultRisk(a: Record<string, unknown> | null | undefined): RiskLevel {
  if (a?.readOnlyHint === true) return "read";
  if (a?.destructiveHint === false && a?.openWorldHint === false) return "write";
  return "external";
}

export function authStatus(row: McpServerRow, auth: McpAuth): "none" | "configured" | "needs_auth" | "authorized" {
  if (row.authType === "oauth") return auth.oauth?.tokens?.accessToken ? "authorized" : "needs_auth";
  if (row.authType === "bearer") return auth.bearer ? "configured" : "needs_auth";
  if (row.authType === "headers") return auth.headers && Object.keys(auth.headers).length ? "configured" : "needs_auth";
  return "none";
}

async function headersFor(database: Database, encKey: Uint8Array, fetchFn: Fetch, row: McpServerRow, auth: McpAuth, forceRefresh = false): Promise<Record<string, string>> {
  const h: Record<string, string> = { "user-agent": "EdgeMind" };
  if (row.authType === "headers") Object.assign(h, auth.headers ?? {});
  if (row.authType === "bearer" && auth.bearer) h.authorization = `Bearer ${auth.bearer}`;
  if (row.authType === "oauth") {
    let st = auth.oauth;
    if (!st?.tokens?.accessToken) throw new McpError(`MCP「${row.name}」尚未完成 OAuth 授權：請到設定 → MCP 按「授權」`);
    if (forceRefresh || !tokenFresh(st.tokens)) {
      if (st.tokens.refreshToken) {
        st = await refreshTokens(fetchFn, st);
        auth.oauth = st;
        await saveAuth(database, row.id, auth, encKey);
      } else if (forceRefresh) throw new McpError(`MCP「${row.name}」的授權已過期：請重新授權`);
    }
    h.authorization = `Bearer ${st!.tokens!.accessToken}`;
  }
  return h;
}

/** Run `fn` with a client for this server: persists session changes, refreshes OAuth once on 401, records errors. */
export async function withClient<T>(
  database: Database, encKey: Uint8Array, fetchFn: Fetch, row: McpServerRow, fn: (c: McpClient) => Promise<T>, opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
  const auth = await loadAuth(row, encKey);
  const attempt = async (forceRefresh: boolean) => {
    const client = new McpClient(
      { url: row.url, transport: row.transport as McpTransport, headers: await headersFor(database, encKey, fetchFn, row, auth, forceRefresh), sessionId: row.sessionId, protocolVersion: row.protocolVersion },
      fetchFn,
      opts,
    );
    try {
      return await fn(client);
    } finally {
      if (client.sessionId !== row.sessionId || client.protocolVersion !== row.protocolVersion) {
        await database.db.update(mcpServers).set({ sessionId: client.sessionId, protocolVersion: client.protocolVersion }).where(eq(mcpServers.id, row.id));
        row.sessionId = client.sessionId;
        row.protocolVersion = client.protocolVersion;
      }
    }
  };
  try {
    try {
      return await attempt(false);
    } catch (e) {
      if (e instanceof McpAuthRequired && e.status === 401 && row.authType === "oauth" && auth.oauth?.tokens?.refreshToken) return await attempt(true);
      throw e;
    }
  } catch (e) {
    const msg = e instanceof McpAuthRequired && row.authType === "oauth" ? "需要重新授權" : (e as Error).message;
    await database.db.update(mcpServers).set({ lastError: msg.slice(0, 500) }).where(eq(mcpServers.id, row.id));
    throw e;
  }
}

export interface SyncResult {
  tools: McpToolRow[];
  added: number;
  removed: number;
}

/** initialize + tools/list → upsert mcp_tools (user choices for enabled / customized risk kept). */
export async function syncServer(database: Database, encKey: Uint8Array, fetchFn: Fetch, row: McpServerRow): Promise<SyncResult> {
  const { init, tools } = await withClient(database, encKey, fetchFn, row, (c) => c.initAndList());
  const db = database.db;
  const existing = await db.select().from(mcpTools).where(eq(mcpTools.serverId, row.id));
  const byName = new Map(existing.map((t) => [t.name, t]));
  const seen = new Set<string>();
  let added = 0;
  for (const t of tools.slice(0, 500)) {
    if (!t?.name || typeof t.name !== "string" || seen.has(t.name)) continue;
    seen.add(t.name);
    const annotations = (t.annotations ?? null) as Record<string, unknown> | null;
    const values = {
      description: typeof t.description === "string" ? t.description.slice(0, 4000) : null,
      inputSchema: t.inputSchema && typeof t.inputSchema === "object" ? t.inputSchema : { type: "object", properties: {} },
      title: typeof t.title === "string" ? t.title : typeof annotations?.title === "string" ? (annotations.title as string) : null,
      annotations,
    };
    const old = byName.get(t.name);
    if (old) await db.update(mcpTools).set({ ...values, ...(old.riskCustomized ? {} : { riskLevel: defaultRisk(annotations) }) }).where(eq(mcpTools.id, old.id));
    else {
      added++;
      await db.insert(mcpTools).values({ serverId: row.id, name: t.name, riskLevel: defaultRisk(annotations), ...values });
    }
  }
  const gone = existing.filter((t) => !seen.has(t.name)).map((t) => t.id);
  if (gone.length) await db.delete(mcpTools).where(inArray(mcpTools.id, gone));
  await db.update(mcpServers).set({
    serverInfo: (init.serverInfo ?? null) as Record<string, unknown> | null, instructions: init.instructions?.slice(0, 4000) ?? null,
    lastSyncedAt: new Date(), lastError: null, updatedAt: new Date(),
  }).where(eq(mcpServers.id, row.id));
  return { tools: await db.select().from(mcpTools).where(eq(mcpTools.serverId, row.id)).orderBy(asc(mcpTools.name)), added, removed: gone.length };
}

/** Enabled MCP tools visible to a conversation (project `enabledMcpServers`: null = all, else server ids). */
export async function availableMcp(database: Database, projectId: string | null): Promise<{ server: McpServerRow; tool: McpToolRow }[]> {
  let allowed: string[] | null = null;
  if (projectId) {
    const [p] = await database.db.select({ s: projects.enabledMcpServers }).from(projects).where(eq(projects.id, projectId)).limit(1);
    allowed = Array.isArray(p?.s) ? p.s : null;
  }
  const rows = await database.db
    .select({ server: mcpServers, tool: mcpTools })
    .from(mcpTools)
    .innerJoin(mcpServers, eq(mcpServers.id, mcpTools.serverId))
    .where(and(eq(mcpServers.enabled, true), eq(mcpTools.enabled, true)))
    .orderBy(asc(mcpServers.name), asc(mcpTools.name));
  return rows.filter((r) => r.server.toolPrefix && (allowed === null || allowed.includes(r.server.id)));
}

export function mcpTool(server: McpServerRow, tool: McpToolRow): Tool {
  const desc = `[MCP: ${server.name}] ${tool.title && tool.title !== tool.name ? `${tool.title}。` : ""}${tool.description ?? ""}`.slice(0, 2000);
  return {
    name: mcpToolName(server.toolPrefix!, tool.name),
    description: desc,
    parameters: (tool.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
    risk: tool.riskLevel as RiskLevel,
    async execute(args, ctx) {
      const fresh = (await ctx.database.db.select().from(mcpServers).where(eq(mcpServers.id, server.id)).limit(1))[0] ?? server;
      const r = await withClient(ctx.database, ctx.encKey, ctx.fetch, fresh, (c) => c.callTool(tool.name, args ?? {}), { signal: ctx.signal, timeoutMs: 50_000 });
      const out = toolResultText(r);
      if (out.isError) throw new Error(out.text || "MCP 工具回報錯誤");
      return out.text || "（MCP 工具沒有回傳內容）";
    },
  };
}

export async function buildMcpTools(database: Database, projectId: string | null): Promise<Tool[]> {
  return (await availableMcp(database, projectId)).map(({ server, tool }) => mcpTool(server, tool));
}

/** Risk of MCP tools by model-facing name (approval cards). */
export async function mcpRisks(database: Database): Promise<Map<string, RiskLevel>> {
  const rows = await database.db.select({ p: mcpServers.toolPrefix, n: mcpTools.name, r: mcpTools.riskLevel }).from(mcpTools).innerJoin(mcpServers, eq(mcpServers.id, mcpTools.serverId));
  return new Map(rows.filter((r) => r.p).map((r) => [mcpToolName(r.p!, r.n), r.r as RiskLevel]));
}
