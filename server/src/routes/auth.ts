/**
 * Single-user auth: first-run password setup, login/logout, password change.
 * - PBKDF2-SHA256 (WebCrypto) password hash, one `users` row.
 * - JWT (HS256) in an HttpOnly cookie; each JWT references a `sessions` row (revocable) and the
 *   user's token_version (bumped on password change -> all sessions invalid).
 * - CSRF: double-submit token (non-HttpOnly cookie echoed in X-CSRF-Token) + Origin check, required
 *   on every non-GET request including login/setup.
 * - Login rate limit backed by `login_attempts` (per IP + global), since serverless has no shared memory.
 */
import type { Hono, MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { sign, verify } from "hono/jwt";
import { and, eq, gte, isNull, sql } from "drizzle-orm";
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from "@edgemind/shared";
import type { Ctx, HonoEnv } from "../context";
import { clientIp } from "../context";
import type { AppEnv } from "../env";
import type { Database } from "../db/client";
import { auditLogs, loginAttempts, sessions, users } from "../db/schema";
import { hashPassword, randomToken, timingSafeEqual, verifyPassword } from "../lib/crypto";

export const SESSION_TTL_SEC = 30 * 24 * 3600;
export const RATE_WINDOW_MIN = 15;
export const MAX_FAILS_PER_IP = 5;
export const MAX_FAILS_GLOBAL = 30;
export const MIN_PASSWORD_LEN = 10;

const PUBLIC_PATHS = new Set(["/api/auth/setup", "/api/auth/login"]);

function isSecure(c: Ctx) {
  return new URL(c.req.url).protocol === "https:";
}

export function ensureCsrfCookie(c: Ctx): string {
  const existing = getCookie(c, CSRF_COOKIE);
  if (existing && existing.length >= 20) return existing;
  const token = randomToken(24);
  setCookie(c, CSRF_COOKIE, token, { path: "/", sameSite: "Strict", secure: isSecure(c), httpOnly: false, maxAge: 365 * 24 * 3600 });
  return token;
}

/** CSRF for all state-changing requests. */
export const csrfGuard: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const m = c.req.method;
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return next();
  const origin = c.req.header("origin");
  if (origin && origin !== new URL(c.req.url).origin) return c.json({ error: "csrf", message: "來源不符（Origin）" }, 403);
  const cookie = getCookie(c, CSRF_COOKIE);
  const header = c.req.header(CSRF_HEADER);
  if (!cookie || !header || !timingSafeEqual(cookie, header)) return c.json({ error: "csrf", message: "CSRF 驗證失敗，請重新整理頁面" }, 403);
  return next();
};

interface Claims {
  sid: string;
  tv: number;
  exp: number;
  [k: string]: unknown;
}

async function readSession(c: Ctx, env: AppEnv, database: Database): Promise<string | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  let claims: Claims;
  try {
    claims = (await verify(token, env.JWT_SECRET, "HS256")) as Claims;
  } catch {
    return null;
  }
  const rows = await database.db
    .select({ id: sessions.id, tv: users.tokenVersion })
    .from(sessions)
    .innerJoin(users, eq(users.id, 1))
    .where(and(eq(sessions.id, claims.sid), isNull(sessions.revokedAt), gte(sessions.expiresAt, new Date())))
    .limit(1);
  if (!rows.length || rows[0].tv !== claims.tv) return null;
  return rows[0].id;
}

export async function isAuthenticated(c: Ctx, env: AppEnv, database: Database): Promise<boolean> {
  return (await readSession(c, env, database)) !== null;
}

export const requireAuth: MiddlewareHandler<HonoEnv> = async (c, next) => {
  if (PUBLIC_PATHS.has(c.req.path)) return next();
  const sid = await readSession(c, c.get("env"), c.get("database"));
  if (!sid) return c.json({ error: "unauthorized", message: "請先登入" }, 401);
  c.set("sessionId", sid);
  return next();
};

async function startSession(c: Ctx, tokenVersion: number) {
  const database = c.get("database");
  const expiresAt = new Date(Date.now() + SESSION_TTL_SEC * 1000);
  const [s] = await database.db
    .insert(sessions)
    .values({ userAgent: c.req.header("user-agent")?.slice(0, 300), ip: clientIp(c), expiresAt })
    .returning({ id: sessions.id });
  const jwt = await sign({ sid: s.id, tv: tokenVersion, exp: Math.floor(expiresAt.getTime() / 1000) }, c.get("env").JWT_SECRET, "HS256");
  setCookie(c, SESSION_COOKIE, jwt, { path: "/", httpOnly: true, sameSite: "Strict", secure: isSecure(c), maxAge: SESSION_TTL_SEC });
}

async function readPassword(c: Ctx, field = "password"): Promise<string | null> {
  const body = await c.req.json().catch(() => null);
  const v = body?.[field];
  return typeof v === "string" ? v : null;
}

function passwordProblem(p: string | null): string | null {
  if (!p) return "請輸入密碼";
  if (p.length < MIN_PASSWORD_LEN) return `密碼至少需要 ${MIN_PASSWORD_LEN} 個字元`;
  if (p.length > 256) return "密碼過長";
  return null;
}

export function mountAuth(app: Hono<HonoEnv>) {
  app.use("*", csrfGuard);
  app.use("*", requireAuth);

  app.post("/auth/setup", async (c) => {
    const password = await readPassword(c);
    const problem = passwordProblem(password);
    if (problem) return c.json({ error: "invalid_password", message: problem }, 400);
    const database = c.get("database");
    const hash = await hashPassword(password!);
    const inserted = await database.db.insert(users).values({ id: 1, passwordHash: hash }).onConflictDoNothing().returning({ tv: users.tokenVersion });
    if (!inserted.length) return c.json({ error: "already_setup", message: "密碼已設定過，請直接登入" }, 409);
    await database.db.insert(auditLogs).values({ action: "setup", ip: clientIp(c) });
    await startSession(c, inserted[0].tv);
    return c.json({ ok: true });
  });

  app.post("/auth/login", async (c) => {
    const database = c.get("database");
    const ip = clientIp(c);
    const since = new Date(Date.now() - RATE_WINDOW_MIN * 60_000);
    const [{ perIp, total }] = await database.db
      .select({
        perIp: sql<number>`count(*) filter (where ${loginAttempts.ip} = ${ip})::int`,
        total: sql<number>`count(*)::int`,
      })
      .from(loginAttempts)
      .where(and(eq(loginAttempts.success, false), gte(loginAttempts.createdAt, since)));
    if (perIp >= MAX_FAILS_PER_IP || total >= MAX_FAILS_GLOBAL) {
      c.header("Retry-After", String(RATE_WINDOW_MIN * 60));
      return c.json({ error: "rate_limited", message: `登入失敗次數過多，請 ${RATE_WINDOW_MIN} 分鐘後再試` }, 429);
    }
    const password = await readPassword(c);
    const [user] = await database.db.select().from(users).where(eq(users.id, 1)).limit(1);
    if (!user) return c.json({ error: "setup_required", message: "尚未設定密碼" }, 409);
    const ok = !!password && (await verifyPassword(password, user.passwordHash));
    await database.db.insert(loginAttempts).values({ ip, success: ok });
    if (!ok) return c.json({ error: "invalid_credentials", message: "密碼錯誤" }, 401);
    // Housekeeping: drop old attempts.
    await database.db.delete(loginAttempts).where(sql`${loginAttempts.createdAt} < now() - interval '1 day'`);
    await database.db.insert(auditLogs).values({ action: "login", ip });
    await startSession(c, user.tokenVersion);
    return c.json({ ok: true });
  });

  app.post("/auth/logout", async (c) => {
    await c.get("database").db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, c.get("sessionId")));
    deleteCookie(c, SESSION_COOKIE, { path: "/", secure: isSecure(c) });
    return c.json({ ok: true });
  });

  app.get("/auth/me", (c) => c.json({ ok: true, sessionId: c.get("sessionId") }));

  app.post("/auth/password", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const current = typeof body.currentPassword === "string" ? body.currentPassword : "";
    const next = typeof body.newPassword === "string" ? body.newPassword : null;
    const problem = passwordProblem(next);
    if (problem) return c.json({ error: "invalid_password", message: problem }, 400);
    const database = c.get("database");
    const [user] = await database.db.select().from(users).where(eq(users.id, 1)).limit(1);
    if (!(await verifyPassword(current, user.passwordHash))) return c.json({ error: "invalid_credentials", message: "目前密碼錯誤" }, 401);
    const tv = user.tokenVersion + 1;
    await database.db.update(users).set({ passwordHash: await hashPassword(next!), tokenVersion: tv, updatedAt: new Date() }).where(eq(users.id, 1));
    await database.db.update(sessions).set({ revokedAt: new Date() }).where(isNull(sessions.revokedAt));
    await database.db.insert(auditLogs).values({ action: "password_change", ip: clientIp(c) });
    await startSession(c, tv); // keep the current browser signed in
    return c.json({ ok: true });
  });
}
