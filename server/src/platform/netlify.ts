/**
 * Netlify Functions (v2, Web-standard Request/Response) adapter.
 * Sync + streaming functions are capped at 60s; background functions (15 min) get their own entry later.
 */
import { createApp } from "../app";
import { createNeonDatabase } from "../db/client";
import { ENV_KEYS } from "../env";

interface NetlifyContext {
  waitUntil?: (p: Promise<unknown>) => void;
}

declare const Netlify: { env: { get(k: string): string | undefined } } | undefined;

function readEnv(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ENV_KEYS) {
    out[k] = (typeof Netlify !== "undefined" ? Netlify.env.get(k) : undefined) ?? process.env[k];
  }
  return out;
}

let envObj: Record<string, unknown> | undefined;

const app = createApp({
  getDatabase: (env) => createNeonDatabase(env.DATABASE_URL),
  platform: { name: "netlify" },
});

export async function handleNetlify(req: Request, context: NetlifyContext): Promise<Response> {
  envObj ??= readEnv(); // stable object identity -> env validation cached per instance
  const waitUntil = context?.waitUntil?.bind(context) ?? ((p: Promise<unknown>) => void p.catch(() => {}));
  return app.fetch(req, envObj, { waitUntil, passThroughOnException() {}, props: {} } as never);
}
