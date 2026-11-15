/** Shared integration harness: throwaway DB, logged-in client, scripted OpenAI-compatible mock LLM, extra HTTP routes. */
import { expect } from "vitest";
import type { AgentEvent } from "../../shared/src/index";
import { createApp } from "../src/app";
import type { AppDeps, Platform } from "../src/context";
import { parseSse } from "../src/llm";
import type { ToolRegistry } from "../src/agent/tools";
import { createTestDatabase, testEnv, TestClient } from "./helpers";
import { sseResponse } from "./llm-helpers";

export type Reply = { sse: string };
const chunk = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const usage = (i = 10, o = 3) => `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: i, completion_tokens: o } })}\n\n`;
export const textReply = (t: string, tokens?: [number, number]): Reply => ({ sse: chunk({ role: "assistant", content: t }) + chunk({}, "stop") + usage(...(tokens ?? [10, 3])) + "data: [DONE]\n\n" });
export const callsReply = (cs: { id: string; name: string; args: unknown }[], tokens?: [number, number]): Reply => ({
  sse: cs.map((c, i) => chunk({ tool_calls: [{ index: i, id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } }] })).join("") + chunk({}, "tool_calls") + usage(...(tokens ?? [10, 3])) + "data: [DONE]\n\n",
});

export type Route = (url: URL, init: RequestInit) => Response | Promise<Response | undefined> | undefined;

export class Harness {
  t!: Awaited<ReturnType<typeof createTestDatabase>>;
  env!: Record<string, string>;
  cookies = new Map<string, string>();
  modelRowId = "";
  script: (Reply | ((body: any) => Reply))[] = [];
  llmBodies: any[] = [];
  /** Extra outbound HTTP handlers (search providers, web pages, embeddings …). First non-undefined wins. */
  routes: Route[] = [];
  outbound: { url: string; init: RequestInit }[] = [];

  constructor(private opts: { tools?: ToolRegistry; deps?: Partial<AppDeps>; autoExtract?: boolean } = {}) {}

  fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    this.outbound.push({ url: url.toString(), init });
    if (url.href.startsWith("https://mock.llm/v1/")) {
      if (url.pathname.endsWith("/models")) return Response.json({ data: [{ id: "mock-1" }] });
      const body = JSON.parse(String(init.body));
      this.llmBodies.push(body);
      const next = this.script.shift();
      if (!next) return new Response('{"error":{"message":"script exhausted"}}', { status: 400 });
      const r = typeof next === "function" ? next(body) : next;
      return sseResponse(r.sse, 4096);
    }
    for (const r of this.routes) {
      const res = await r(url, init);
      if (res) return res;
    }
    return new Response("no route", { status: 404 });
  }) as typeof fetch;

  app(platform: Platform = { name: "test" }) {
    return createApp({
      getDatabase: () => this.t.database,
      fetch: this.fetch,
      platform,
      tools: this.opts.tools,
      agent: { heartbeatMs: 40, llmRetry: { maxRetries: 0 } },
      ...this.opts.deps,
    });
  }

  client() {
    const c = new TestClient(this.app(), this.env);
    c.cookies = this.cookies;
    return c;
  }

  async setup() {
    this.t = await createTestDatabase();
    this.env = testEnv(this.t.url);
    const c = new TestClient(this.app(), this.env);
    await c.get("/status");
    expect((await c.post("/auth/setup", { password: "owner-password-1" })).status).toBe(200);
    this.cookies = c.cookies;
    const p = await c.post("/providers", { type: "llm", kind: "openai", name: "Mock", baseUrl: "https://mock.llm/v1", apiKey: "sk-mock-123456" });
    expect(p.status).toBe(201);
    const m = await c.req("PUT", `/providers/${p.body.id}/models`, { models: [{ modelId: "mock-1", capabilities: { tools: true, vision: true } }] });
    this.modelRowId = m.body[0].id;
    // Auto memory extraction would consume scripted LLM replies in the background; tests opt in explicitly.
    if (!this.opts.autoExtract) expect((await c.req("PUT", "/settings/memory", { autoExtract: false })).status).toBe(200);
  }

  async teardown() {
    await this.t?.drop();
  }

  /** POST /api/chat and collect the SSE events (or the JSON body for 202/4xx). */
  async chat(body: Record<string, unknown>) {
    const app = this.app();
    const headers: Record<string, string> = { "content-type": "application/json", cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "), "x-csrf-token": this.cookies.get("em_csrf")! };
    const res = await app.request("http://localhost/api/chat", { method: "POST", headers, body: JSON.stringify({ modelId: this.modelRowId, ...body }) }, this.env);
    if (!res.headers.get("content-type")?.includes("text/event-stream")) return { status: res.status, json: (await res.json()) as any, events: [] as AgentEvent[] };
    const events: AgentEvent[] = [];
    for await (const e of parseSse(res.body!)) events.push(JSON.parse(e.data));
    return { status: res.status, json: null as any, events };
  }
}

export const lastEvent = (evs: AgentEvent[]) => evs[evs.length - 1];
export const runIdOf = (evs: AgentEvent[]) => (evs.find((e) => e.type === "run") as any).runId as string;
export const convOf = (evs: AgentEvent[]) => (evs.find((e) => e.type === "run") as any).conversationId as string;
