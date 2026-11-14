import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { providers } from "../src/db/schema";
import { createTestDatabase, testEnv, TestClient } from "./helpers";

type Call = { url: string; method: string; headers: Record<string, string>; body: any };
let calls: Call[] = [];
let routes: [RegExp, (call: Call) => Response][] = [];

const mockFetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const url = String(input);
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  const call: Call = { url, method: init.method ?? "GET", headers, body: init.body ? JSON.parse(String(init.body)) : undefined };
  calls.push(call);
  const hit = routes.find(([re]) => re.test(url));
  return hit ? hit[1](call) : new Response("no route", { status: 404 });
}) as typeof fetch;
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

let t: Awaited<ReturnType<typeof createTestDatabase>>;
let c: TestClient;
beforeAll(async () => {
  t = await createTestDatabase();
  const app = createApp({ getDatabase: () => t.database, fetch: mockFetch });
  c = new TestClient(app, testEnv(t.url));
  await c.get("/status");
  expect((await c.post("/auth/setup", { password: "owner-password-1" })).status).toBe(200);
});
afterAll(async () => t?.drop());
beforeEach(() => { calls = []; routes = []; });

async function create(body: Record<string, unknown>) {
  const r = await c.post("/providers", body);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
}

describe("providers CRUD", () => {
  it("encrypts API keys at rest and never returns them", async () => {
    const p = await create({ type: "llm", kind: "openai", name: "OpenAI", apiKey: "sk-test-1234567890" });
    expect(p.apiKeyPreview).toBe("sk-t…7890");
    expect(p.hasApiKey).toBe(true);
    expect(p.baseUrl).toBe("https://api.openai.com/v1");
    expect(JSON.stringify(p)).not.toContain("sk-test-1234567890");
    const [row] = await t.database.db.select().from(providers);
    expect(row.apiKeyEnc).toMatch(/^v1\./);
    expect(row.apiKeyEnc).not.toContain("1234567890");
    const list = await c.get("/providers?type=llm");
    expect(list.body).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain("1234567890");
  });

  it("validates input against the catalog (no Exa / Brave, bad URL, required fields)", async () => {
    expect((await c.post("/providers", { type: "search", kind: "exa", name: "Exa" })).status).toBe(400);
    expect((await c.post("/providers", { type: "search", kind: "brave", name: "Brave" })).status).toBe(400);
    expect((await c.post("/providers", { type: "llm", kind: "openai", name: "x", baseUrl: "ftp://x" })).status).toBe(400);
    expect((await c.post("/providers", { type: "search", kind: "searxng", name: "sx" })).status).toBe(400); // needs base URL
    expect((await c.post("/providers", { type: "nope", kind: "openai", name: "x" })).status).toBe(400);
  });

  it("updates: keep key when omitted, clear with empty string, ignores unknown config keys", async () => {
    const p = await create({ type: "search", kind: "google_pse", name: "PSE", apiKey: "AIzaKEY12345", config: { cx: "abc", evil: "x" } });
    expect(p.config).toEqual({ cx: "abc" });
    const u1 = await c.req("PATCH", `/providers/${p.id}`, { name: "PSE 2", priority: 5, enabled: false });
    expect(u1.body).toMatchObject({ name: "PSE 2", priority: 5, enabled: false, hasApiKey: true });
    const u2 = await c.req("PATCH", `/providers/${p.id}`, { apiKey: "" });
    expect(u2.body.hasApiKey).toBe(false);
    expect((await c.req("PATCH", `/providers/${p.id}`, { type: "llm", kind: "anthropic" })).body.kind).toBe("google_pse"); // immutable
    expect((await c.req("DELETE", `/providers/${p.id}`)).status).toBe(200);
    expect((await c.req("DELETE", `/providers/${p.id}`)).status).toBe(404);
  });
});

describe("model listing (real request shapes, mocked HTTP)", () => {
  it("openai-compatible: GET /models with Bearer", async () => {
    const p = await create({ type: "llm", kind: "openai", name: "OR", baseUrl: "https://openrouter.ai/api/v1/", apiKey: "or-key-123456" });
    routes.push([/openrouter\.ai\/api\/v1\/models$/, () => json({ data: [{ id: "b-model", context_length: 8000 }, { id: "a-model" }] })]);
    const r = await c.get(`/providers/${p.id}/models/remote`);
    expect(r.body.models.map((m: any) => m.id)).toEqual(["a-model", "b-model"]);
    expect(calls[0].headers.authorization).toBe("Bearer or-key-123456");
  });

  it("anthropic: x-api-key + version header, pagination", async () => {
    const p = await create({ type: "llm", kind: "anthropic", name: "Claude", apiKey: "ant-key-123456" });
    routes.push([/api\.anthropic\.com\/v1\/models/, (call) =>
      call.url.includes("after_id") ? json({ data: [{ id: "claude-b", display_name: "B" }], has_more: false })
        : json({ data: [{ id: "claude-a", display_name: "A" }], has_more: true, last_id: "claude-a" })]);
    const r = await c.get(`/providers/${p.id}/models/remote`);
    expect(r.body.models.map((m: any) => m.id)).toEqual(["claude-a", "claude-b"]);
    expect(calls[0].headers["x-api-key"]).toBe("ant-key-123456");
    expect(calls[0].headers["anthropic-version"]).toBe("2023-06-01");
  });

  it("gemini: filters by generation method, strips models/ prefix", async () => {
    const p = await create({ type: "llm", kind: "gemini", name: "Gemini", apiKey: "gm-key-123456" });
    routes.push([/generativelanguage\.googleapis\.com\/v1beta\/models\?/, () => json({ models: [
      { name: "models/gemini-2.5-flash", inputTokenLimit: 1048576, supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-embedding-001", supportedGenerationMethods: ["embedContent"] },
    ] })]);
    const r = await c.get(`/providers/${p.id}/models/remote`);
    expect(r.body.models).toEqual([{ id: "gemini-2.5-flash", contextLength: 1048576 }]);
    expect(calls[0].headers["x-goog-api-key"]).toBe("gm-key-123456");
  });

  it("upstream errors become 502 with the key redacted", async () => {
    const p = await create({ type: "llm", kind: "openai", name: "Bad", apiKey: "sk-leaky-999999" });
    routes.push([/api\.openai\.com/, () => new Response("invalid key sk-leaky-999999", { status: 401 })]);
    const r = await c.get(`/providers/${p.id}/models/remote`);
    expect(r.status).toBe(502);
    expect(r.body.message).toContain("HTTP 401");
    expect(r.body.message).not.toContain("sk-leaky-999999");
  });

  it("saves the picked model set with capabilities", async () => {
    const p = await create({ type: "llm", kind: "openai", name: "Saved" });
    const r1 = await c.req("PUT", `/providers/${p.id}/models`, { models: [{ modelId: "m1", capabilities: { vision: true, tools: "x" } }, { modelId: "m2", contextLength: 128000 }] });
    expect(r1.body.map((m: any) => m.modelId)).toEqual(["m1", "m2"]);
    expect(r1.body[0].capabilities).toEqual({ vision: true });
    const r2 = await c.req("PUT", `/providers/${p.id}/models`, { models: [{ modelId: "m2", capabilities: { reasoning: true } }] });
    expect(r2.body).toHaveLength(1);
    expect(r2.body[0]).toMatchObject({ modelId: "m2", capabilities: { reasoning: true } });
  });
});

describe("connection tests", () => {
  it("llm with model: minimal chat completion", async () => {
    const p = await create({ type: "llm", kind: "openai", name: "T", apiKey: "k-1234567890" });
    routes.push([/chat\/completions$/, () => json({ choices: [{ message: { content: "pong" } }] })]);
    const r = await c.post(`/providers/${p.id}/test`, { model: "gpt-x" });
    expect(r.body).toMatchObject({ ok: true, detail: { reply: "pong" } });
    expect(calls[0].body).toMatchObject({ model: "gpt-x", max_tokens: 8 });
  });

  it("anthropic + gemini pings use their native endpoints", async () => {
    routes.push([/\/v1\/messages$/, () => json({ content: [{ type: "text", text: "hi" }] })]);
    routes.push([/:generateContent$/, () => json({ candidates: [{ content: { parts: [{ text: "yo" }] } }] })]);
    const a = await c.post("/providers/test", { type: "llm", kind: "anthropic", name: "a", apiKey: "k-aaaaaaaaaa", baseUrl: "https://api.anthropic.com/v1", model: "claude-x" });
    expect(a.body).toMatchObject({ ok: true, detail: { reply: "hi" } });
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    const g = await c.post("/providers/test", { type: "llm", kind: "gemini", name: "g", apiKey: "k-gggggggggg", model: "gemini-2.5-flash" });
    expect(g.body).toMatchObject({ ok: true, detail: { reply: "yo" } });
    expect(calls[1].url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
  });

  it("every search kind sends its own request shape", async () => {
    routes.push([/api\.tavily\.com\/search$/, () => json({ results: [{}] })]);
    routes.push([/google\.serper\.dev\/search$/, () => json({ organic: [{}, {}] })]);
    routes.push([/searx\.example\.com\/search\?/, () => json({ results: [{}, {}, {}] })]);
    routes.push([/s\.jina\.ai\/\?q=/, () => json({ data: [{}] })]);
    routes.push([/customsearch\/v1\?/, () => json({ items: [{}] })]);
    const cases = [
      [{ kind: "tavily", apiKey: "tv-1234567890" }, 1],
      [{ kind: "serper", apiKey: "sp-1234567890" }, 2],
      [{ kind: "searxng", baseUrl: "https://searx.example.com" }, 3],
      [{ kind: "jina", apiKey: "jn-1234567890" }, 1],
      [{ kind: "google_pse", apiKey: "gp-1234567890", config: { cx: "cx1" } }, 1],
    ] as const;
    for (const [input, n] of cases) {
      const r = await c.post("/providers/test", { type: "search", name: "s", ...input });
      expect(r.body.ok, JSON.stringify(r.body)).toBe(true);
      expect(r.body.detail.results).toBe(n);
    }
    expect(calls[0].headers.authorization).toBe("Bearer tv-1234567890");
    expect(calls[1].headers["x-api-key"]).toBe("sp-1234567890");
    expect(calls[2].url).toContain("format=json");
    expect(calls[4].url).toContain("cx=cx1");
    // missing required cx
    const bad = await c.post("/providers/test", { type: "search", kind: "google_pse", name: "s", apiKey: "gp-1234567890" });
    expect(bad.body).toMatchObject({ ok: false });
    expect(bad.body.message).toContain("cx");
  });

  it("embedding test reports the vector dimension (openai shape, cohere, gemini, workers ai)", async () => {
    routes.push([/api\.openai\.com\/v1\/embeddings$/, () => json({ data: [{ embedding: new Array(1536).fill(0) }] })]);
    routes.push([/api\.cohere\.com\/v2\/embed$/, () => json({ embeddings: { float: [new Array(1024).fill(0)] } })]);
    routes.push([/:embedContent$/, () => json({ embedding: { values: new Array(3072).fill(0) } })]);
    routes.push([/accounts\/acc1\/ai\/run\/@cf\/baai\/bge-m3$/, () => json({ result: { data: [new Array(1024).fill(0)] } })]);
    const o = await c.post("/providers/test", { type: "embedding", kind: "openai", name: "e", apiKey: "k-1234567890" });
    expect(o.body).toMatchObject({ ok: true, detail: { dimension: 1536, model: "text-embedding-3-small" } });
    const co = await c.post("/providers/test", { type: "embedding", kind: "cohere", name: "e", apiKey: "k-1234567890" });
    expect(co.body.detail.dimension).toBe(1024);
    const g = await c.post("/providers/test", { type: "embedding", kind: "gemini", name: "e", apiKey: "k-1234567890" });
    expect(g.body.detail.dimension).toBe(3072);
    const w = await c.post("/providers/test", { type: "embedding", kind: "workers_ai", name: "e", apiKey: "k-1234567890", config: { accountId: "acc1" } });
    expect(w.body.detail.dimension).toBe(1024);
  });

  it("rerank + image tests", async () => {
    routes.push([/api\.jina\.ai\/v1\/rerank$/, () => json({ results: [{}, {}] })]);
    routes.push([/api\.voyageai\.com\/v1\/rerank$/, () => json({ data: [{}, {}] })]);
    routes.push([/api\.openai\.com\/v1\/models$/, () => json({ data: [{ id: "gpt-image-1" }] })]);
    expect((await c.post("/providers/test", { type: "rerank", kind: "jina", name: "r", apiKey: "k-1234567890" })).body.ok).toBe(true);
    expect((await c.post("/providers/test", { type: "rerank", kind: "voyage", name: "r", apiKey: "k-1234567890" })).body.ok).toBe(true);
    expect((await c.post("/providers/test", { type: "image", kind: "openai", name: "i", apiKey: "k-1234567890" })).body.ok).toBe(true);
  });

  it("draft test reuses the stored key when apiKey is omitted", async () => {
    const p = await create({ type: "search", kind: "tavily", name: "T", apiKey: "tv-stored-123456" });
    routes.push([/api\.tavily\.com\/search$/, () => json({ results: [] })]);
    const r = await c.post("/providers/test", { id: p.id, name: "T" });
    expect(r.body.ok).toBe(true);
    expect(calls[0].headers.authorization).toBe("Bearer tv-stored-123456");
  });

  it("key-required providers fail fast without a key; network errors are reported", async () => {
    const r = await c.post("/providers/test", { type: "llm", kind: "anthropic", name: "a" });
    expect(r.body).toMatchObject({ ok: false, message: "此供應商需要 API Key" });
    expect(calls).toHaveLength(0);
    const r2 = await c.post("/providers/test", { type: "llm", kind: "openai", name: "x", baseUrl: "https://unreachable.example/v1" });
    expect(r2.body.ok).toBe(false);
  });
});
