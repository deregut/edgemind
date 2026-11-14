import { Hono } from "hono";
import type { StatusResponse } from "@edgemind/shared";
import type { AppDeps, HonoEnv } from "./context";
import { decodeKey32, validateEnv, type EnvValidation } from "./env";
import { migrate } from "./db/migrate";
import type { Database } from "./db/client";
import { APP_VERSION } from "./version";

/** Migrations run at most once per isolate per database URL. */
const migrated = new Map<string, Promise<void>>();

export function ensureMigrated(database: Database, url: string): Promise<void> {
  let p = migrated.get(url);
  if (!p) {
    p = migrate(database).then(() => undefined);
    p.catch(() => migrated.delete(url));
    migrated.set(url, p);
  }
  return p;
}

export function createApp(deps: AppDeps) {
  const app = new Hono<HonoEnv>().basePath("/api");

  app.onError((err, c) => {
    console.error("[edgemind]", err);
    return c.json({ error: "internal_error", message: err.message }, 500);
  });

  const envCache = new WeakMap<object, EnvValidation>();
  const checkEnv = (raw: Record<string, unknown>) => {
    let v = envCache.get(raw);
    if (!v) {
      v = validateEnv(raw);
      envCache.set(raw, v);
    }
    return v;
  };

  // Status: always reachable; drives the SPA's env-error / setup / login screens.
  app.get("/status", async (c) => {
    const v = checkEnv(c.env ?? {});
    const body: StatusResponse = {
      env: { ok: v.ok, issues: v.issues },
      db: { ok: false },
      setupRequired: false,
      authenticated: false,
      version: APP_VERSION,
    };
    if (!v.ok || !v.env) return c.json(body);
    const database = deps.getDatabase(v.env);
    try {
      await ensureMigrated(database, v.env.DATABASE_URL);
      const rows = await database.query<{ n: number }>("SELECT count(*)::int AS n FROM users");
      body.db = { ok: true, migrated: true };
      body.setupRequired = rows[0].n === 0;
    } catch (e) {
      body.db = { ok: false, error: (e as Error).message };
    }
    return c.json(body);
  });

  // Everything else needs a valid env + migrated DB.
  app.use("*", async (c, next) => {
    const v = checkEnv(c.env ?? {});
    if (!v.ok || !v.env) return c.json({ error: "env_invalid", issues: v.issues }, 503);
    const database = deps.getDatabase(v.env);
    await ensureMigrated(database, v.env.DATABASE_URL);
    c.set("env", v.env);
    c.set("database", database);
    c.set("encKey", decodeKey32(v.env.ENCRYPTION_KEY)!);
    await next();
  });


  app.get("/health", (c) => c.json({ ok: true, platform: deps.platform?.name ?? "unknown" }));
  app.notFound((c) => c.json({ error: "not_found" }, 404));
  return app;
}

export type App = ReturnType<typeof createApp>;
