/**
 * Cloudflare Pages Functions adapter. functions/[[path]].ts mounts this; non-/api paths fall through
 * to static assets via context.next().
 */
import { createApp } from "../app";
import { createNeonDatabase } from "../db/client";

export interface PagesContext {
  request: Request;
  env: Record<string, unknown>;
  waitUntil(p: Promise<unknown>): void;
  next(): Promise<Response>;
  passThroughOnException(): void;
}

const app = createApp({
  getDatabase: (env) => createNeonDatabase(env.DATABASE_URL),
  platform: { name: "cloudflare" },
});

export async function handlePages(context: PagesContext): Promise<Response> {
  const url = new URL(context.request.url);
  if (url.pathname !== "/api" && !url.pathname.startsWith("/api/")) return context.next();
  return app.fetch(context.request, context.env, {
    waitUntil: (p: Promise<unknown>) => context.waitUntil(p),
    passThroughOnException: () => context.passThroughOnException(),
    props: {},
  } as never);
}
