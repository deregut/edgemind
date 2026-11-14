import type { Context } from "hono";
import type { Database } from "./db/client";
import type { AppEnv } from "./env";

/** Platform hooks provided by netlify.ts / cloudflare.ts (or tests). */
export interface Platform {
  name: "netlify" | "cloudflare" | "node" | "test";
}

export interface AppDeps {
  /** Build the Database for an env. Prod: Neon HTTP. Tests: node-postgres. */
  getDatabase(env: AppEnv): Database;
  /** Outbound fetch for provider calls (mocked in tests). */
  fetch?: typeof fetch;
  platform?: Platform;
}

export interface HonoEnv {
  Bindings: Record<string, unknown>;
  Variables: {
    env: AppEnv;
    database: Database;
    encKey: Uint8Array;
    sessionId: string;
  };
}

export type Ctx = Context<HonoEnv>;

export function clientIp(c: Ctx): string {
  const h = c.req.header.bind(c.req);
  return (
    h("x-nf-client-connection-ip") ||
    h("cf-connecting-ip") ||
    h("x-forwarded-for")?.split(",")[0].trim() ||
    h("x-real-ip") ||
    "unknown"
  );
}

/** Keep work alive after the response (CF waitUntil / Netlify context.waitUntil via executionCtx). */
export function runInBackground(c: Ctx, p: Promise<unknown>) {
  let ec: { waitUntil(p: Promise<unknown>): void } | undefined;
  try {
    ec = c.executionCtx;
  } catch {
    ec = undefined;
  }
  if (ec) ec.waitUntil(p);
  else p.catch((e) => console.error("[edgemind] background task failed", e));
}
