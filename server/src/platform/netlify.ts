/**
 * Netlify Functions (v2, Web-standard Request/Response) adapter.
 * Sync + streaming functions are capped at 60s; background functions (15 min) get their own entry later.
 */
import { createApp } from "../app";
import { createNeonDatabase } from "../db/client";
import { ENV_KEYS } from "../env";
import type { Platform } from "../context";

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

/** Background mode: hand the run to the `agent-background` background function (15 min, no streaming). */
const startBackground: NonNullable<Platform["startBackground"]> = async ({ origin, runId, token }) => {
  const res = await fetch(`${origin}/.netlify/functions/agent-background`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-edgemind-drive": token },
    body: JSON.stringify({ runId }),
  });
  if (res.status >= 400) throw new Error(`無法啟動背景執行（HTTP ${res.status}）`);
};

const app = createApp({
  getDatabase: (env) => createNeonDatabase(env.DATABASE_URL),
  platform: { name: "netlify", segment: { softMs: 50_000, hardMs: 57_000 }, startBackground },
});

/** Same app, configured to drive runs inline with the background-function budget. */
const backgroundApp = createApp({
  getDatabase: (env) => createNeonDatabase(env.DATABASE_URL),
  platform: { name: "netlify", background: { softMs: 13 * 60_000, hardMs: 14 * 60_000 + 30_000 }, driveInline: true, startBackground },
});

/** Entry of netlify/functions/agent-background.ts (body: { runId }, header x-edgemind-drive). */
export async function handleNetlifyBackground(req: Request, context: NetlifyContext): Promise<Response> {
  envObj ??= readEnv();
  const body = (await req.json().catch(() => null)) as { runId?: string } | null;
  const runId = typeof body?.runId === "string" ? body.runId : "";
  const origin = new URL(req.url).origin;
  const inner = new Request(`${origin}/api/internal/runs/${encodeURIComponent(runId)}/drive`, {
    method: "POST",
    headers: { "x-edgemind-drive": req.headers.get("x-edgemind-drive") ?? "" },
  });
  const waitUntil = context?.waitUntil?.bind(context) ?? ((p: Promise<unknown>) => void p.catch(() => {}));
  return backgroundApp.fetch(inner, envObj, { waitUntil, passThroughOnException() {}, props: {} } as never);
}

export async function handleNetlify(req: Request, context: NetlifyContext): Promise<Response> {
  envObj ??= readEnv(); // stable object identity -> env validation cached per instance
  const waitUntil = context?.waitUntil?.bind(context) ?? ((p: Promise<unknown>) => void p.catch(() => {}));
  return app.fetch(req, envObj, { waitUntil, passThroughOnException() {}, props: {} } as never);
}
