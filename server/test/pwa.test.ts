import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

/** Load web/public/sw.js with a fake service-worker global and return its fetch handler. */
function loadSw() {
  const handlers: Record<string, (e: any) => void> = {};
  const store = new Map<string, Response>();
  const cache = { put: async (k: any, v: Response) => void store.set(typeof k === "string" ? k : k.url, v), keys: async () => [], delete: async () => true, addAll: async () => {} };
  const self = { addEventListener: (t: string, f: any) => (handlers[t] = f), location: { origin: "https://em.example" }, skipWaiting() {}, clients: { claim() {} } };
  const caches = { open: async () => cache, match: async (k: any) => store.get(typeof k === "string" ? new URL(k, "https://em.example").pathname === "/" ? "/" : k : k.url), keys: async () => [], delete: async () => true };
  runInNewContext(readFileSync(new URL("../../web/public/sw.js", import.meta.url), "utf8"), { self, caches, fetch: async () => new Response("net"), URL, Response, Promise });
  const intercept = (url: string, init: { method?: string; mode?: string } = {}) => {
    let responded = false;
    handlers.fetch({ request: { url, method: init.method ?? "GET", mode: init.mode ?? "cors" }, respondWith: () => (responded = true) });
    return responded;
  };
  return { intercept, handlers };
}

describe("PWA service worker", () => {
  it("caches the app shell only and never intercepts /api or non-GET requests", () => {
    const { intercept, handlers } = loadSw();
    expect(Object.keys(handlers).sort()).toEqual(["activate", "fetch", "install"]);
    expect(intercept("https://em.example/api/chat", { method: "POST" })).toBe(false);
    expect(intercept("https://em.example/api/conversations")).toBe(false);
    expect(intercept("https://em.example/api/mcp/oauth/callback?code=x", { mode: "navigate" })).toBe(false);
    expect(intercept("https://em.example/.netlify/functions/agent-background")).toBe(false);
    expect(intercept("https://cdn.jsdelivr.net/pyodide/v314.0.8/full/pyodide.mjs")).toBe(false);
    expect(intercept("https://em.example/assets/index-abc123.js")).toBe(true);
    expect(intercept("https://em.example/c/123", { mode: "navigate" })).toBe(true);
    expect(intercept("https://em.example/icons/icon-192.png")).toBe(true);
    expect(intercept("https://em.example/assets/x.js", { method: "POST" })).toBe(false);
  });

  it("ships a valid manifest with installable icons", () => {
    const m = JSON.parse(readFileSync(new URL("../../web/public/manifest.webmanifest", import.meta.url), "utf8"));
    expect(m).toMatchObject({ display: "standalone", start_url: "/", lang: "zh-Hant-TW" });
    expect(m.icons.map((i: any) => i.sizes)).toEqual(expect.arrayContaining(["192x192", "512x512"]));
    expect(m.icons.some((i: any) => i.purpose === "maskable")).toBe(true);
    const html = readFileSync(new URL("../../web/index.html", import.meta.url), "utf8");
    expect(html).toContain('rel="manifest"');
  });
});
