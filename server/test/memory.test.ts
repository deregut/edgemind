import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { conversations, memories, runSteps } from "../src/db/schema";
import { documentTokens } from "../src/lib/textsearch";
import { compactionCut, estimateTokens } from "../src/memory";
import { Harness, textReply, convOf, runIdOf } from "./harness";
import { S3Mock } from "./s3-mock";

function fakeEmbed(text: string, dim = 64): number[] {
  const v = new Array(dim).fill(0);
  for (const t of documentTokens(text)) {
    let h = 2166136261;
    for (const ch of t) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619) >>> 0;
    v[h % dim] += 1;
  }
  const n = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
  return v.map((x) => x / n);
}

const s3 = new S3Mock();
const h = new Harness({ deps: { s3Fetch: s3.fetch }, autoExtract: true });
let embedCalls: string[][] = [];
const embedRoute = async (url: URL, init: RequestInit) => {
  if (url.href !== "https://mock.embed/v1/embeddings") return undefined;
  const body = JSON.parse(String(init.body));
  embedCalls.push(body.input);
  return Response.json({ data: (body.input as string[]).map((t, i) => ({ index: i, embedding: fakeEmbed(t) })) });
};
const sys = (i: number) => h.llmBodies[i].messages[0].content as string;
const waitFor = async (fn: () => Promise<boolean>, ms = 3000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timeout");
};
const allMemories = () => h.t.database.db.select().from(memories);

beforeAll(async () => {
  await h.setup();
  await h.client().req("PUT", "/settings/memory", { autoExtract: false });
});
afterAll(() => h.teardown());
beforeEach(async () => {
  h.script = [];
  h.llmBodies = [];
  h.routes = [embedRoute];
  embedCalls = [];
  await h.t.database.query("DELETE FROM memories");
});

describe("token estimate and compaction cut", () => {
  it("estimates CJK vs Latin and cuts before a user message, keeping recent turns", () => {
    expect(estimateTokens("你好世界")).toBe(4);
    expect(estimateTokens("abcdefgh")).toBe(2);
    const mk = (role: string, n: number) => ({ id: `${role}${Math.random()}`, role, parts: [{ type: "text", text: "字".repeat(n) }] }) as any;
    const branch = [mk("user", 100), mk("assistant", 300), mk("user", 100), mk("assistant", 300), mk("user", 50), mk("assistant", 50)];
    expect(compactionCut(branch, 0, 10_000, 100, 0)).toBeNull(); // fits
    const cut = compactionCut(branch, 0, 500, 150, 0)!;
    expect(branch[cut].role).toBe("user");
    expect(cut).toBe(4);
    expect(compactionCut(branch, 2, 300, 10_000, 0)).toBe(4); // keeps everything it can, but must cut something
    expect(compactionCut([mk("user", 5000), mk("assistant", 10)], 0, 100, 10, 0)).toBeNull(); // a single turn can't be compacted
  });
});

describe("memory management API + settings", () => {
  it("CRUD, filters, bulk delete, settings round-trip, re-embed", async () => {
    const c = h.client();
    const pid = (await c.post("/projects", { name: "記憶專案" })).body.id;
    expect((await c.post("/memories", { content: "" })).status).toBe(400);
    expect((await c.post("/memories", { content: "x", scope: "project" })).status).toBe(400);
    const g = await c.post("/memories", { content: "使用者偏好深色主題", scope: "global" });
    expect(g.body).toMatchObject({ scope: "global", source: "user", embeddingModel: null });
    const p = await c.post("/memories", { content: "這個專案用 Postgres 17", scope: "project", projectId: pid });
    expect(p.body).toMatchObject({ scope: "project", projectId: pid });
    expect((await c.get("/memories")).body.total).toBe(2);
    expect((await c.get(`/memories?scope=project&projectId=${pid}`)).body.items.map((m: any) => m.id)).toEqual([p.body.id]);
    expect((await c.get(`/memories?q=${encodeURIComponent("深色")}`)).body.items.map((m: any) => m.id)).toEqual([g.body.id]);
    const u = await c.req("PATCH", `/memories/${g.body.id}`, { content: "使用者偏好淺色主題", scope: "project", projectId: pid });
    expect(u.body).toMatchObject({ content: "使用者偏好淺色主題", scope: "project", projectId: pid });

    // settings
    const s0 = (await c.get("/settings/memory")).body;
    expect(s0).toMatchObject({ autoRecall: true, recallK: 5, compaction: { enabled: true, threshold: 0.7 } });
    const s1 = await c.req("PUT", "/settings/memory", { ...s0, recallK: 99, minScore: 0.5, compaction: { ...s0.compaction, threshold: 2 } });
    expect(s1.body).toMatchObject({ recallK: 20, minScore: 0.5, compaction: { threshold: 0.95 } });
    await c.req("PUT", "/settings/memory", { ...s0 });

    // embeddings configured later → re-embed existing rows
    const ep = (await c.post("/providers", { type: "embedding", kind: "openai_compatible", name: "MockEmb", baseUrl: "https://mock.embed/v1", apiKey: "emb-key-123456" })).body.id;
    await c.req("PUT", `/providers/${ep}/models`, { models: [{ modelId: "emb-large" }] });
    const re = await c.post("/memories/reembed");
    expect(re.body).toMatchObject({ done: 2, remaining: 0, model: "emb-large" });
    expect((await allMemories()).every((m) => m.embeddingDim === 64)).toBe(true);

    expect((await c.post("/memories/bulk-delete", { ids: [p.body.id] })).body.deleted).toBe(1);
    expect((await c.post("/memories/bulk-delete", { all: true })).body.deleted).toBe(1);
  });
});

describe("auto recall", () => {
  it("injects relevant memories (vector with similarity floor), embeds the query once per segment, can be turned off", async () => {
    const c = h.client();
    await c.post("/memories", { content: "使用者養了一隻叫做麻糬的柴犬", scope: "global" });
    await c.post("/memories", { content: "使用者的公司在新竹科學園區", scope: "global" });
    embedCalls = [];
    h.script = [
      { sse: `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "e1", type: "function", function: { name: "echo", arguments: '{"text":"x"}' } }] }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n` },
      textReply("麻糬很可愛"),
    ];
    await h.chat({ content: "我的柴犬麻糬最近不太吃飯" });
    expect(sys(0)).toContain("# 相關記憶");
    expect(sys(0)).toContain("麻糬的柴犬");
    expect(sys(0)).not.toContain("新竹"); // below the similarity floor
    expect(sys(1)).toContain("麻糬的柴犬");
    expect(embedCalls.filter((x) => x[0].includes("不太吃飯"))).toHaveLength(1); // two model steps, one query embedding

    const s = (await c.get("/settings/memory")).body;
    await c.req("PUT", "/settings/memory", { ...s, autoRecall: false });
    h.llmBodies = [];
    h.script = [textReply("ok")];
    await h.chat({ content: "我的柴犬麻糬最近不太吃飯" });
    expect(sys(0)).not.toContain("# 相關記憶");
    await c.req("PUT", "/settings/memory", { ...s, autoRecall: true });
  });
});

describe("auto extraction", () => {
  it("adds / updates memories from the finished exchange in the background, filters secrets, skips trivial turns", async () => {
    const c = h.client();
    const s = (await c.get("/settings/memory")).body;
    await c.req("PUT", "/settings/memory", { ...s, autoExtract: true });
    h.script = [
      textReply("了解，之後都用正體中文回覆你。"),
      textReply('```json\n[{"op":"add","content":"使用者希望回覆一律使用正體中文","scope":"global"},{"op":"add","content":"使用者的 API key 是 sk-abcdefghijklmnop"},{"op":"update","id":"00000000-0000-0000-0000-000000000000","content":"偽造的更新"}]\n```'),
    ];
    await h.chat({ content: "以後請你都用正體中文回答我，謝謝" });
    await waitFor(async () => (await allMemories()).length > 0);
    await new Promise((r) => setTimeout(r, 100));
    const rows = await allMemories();
    expect(rows.map((m) => [m.content, m.source, m.scope])).toEqual([["使用者希望回覆一律使用正體中文", "auto", "global"]]);
    expect(rows[0].embeddingDim).toBe(64);
    const extractReq = h.llmBodies[1];
    expect(extractReq.messages[0].content).toContain("萃取");
    expect(extractReq.messages[1].content).toContain("以後請你都用正體中文回答我");

    // second exchange: the extractor sees the existing memory and updates it
    const id = rows[0].id;
    h.llmBodies = [];
    h.script = [textReply("好的"), (body: any) => {
      expect(body.messages[1].content).toContain(id);
      return textReply(JSON.stringify([{ op: "update", id, content: "使用者希望回覆一律使用正體中文，並附上英文術語" }]));
    }];
    await h.chat({ content: "用正體中文回答時，專有名詞請附上英文術語" });
    await waitFor(async () => (await allMemories())[0].content.includes("英文術語"));
    expect(await allMemories()).toHaveLength(1);

    // trivial turn → no extraction call
    h.llmBodies = [];
    h.script = [textReply("嗨")];
    await h.chat({ content: "嗨" });
    await new Promise((r) => setTimeout(r, 100));
    expect(h.llmBodies).toHaveLength(1);
    await c.req("PUT", "/settings/memory", { ...s, autoExtract: false });
  });
});

describe("conversation compaction", () => {
  it("summarizes older turns when the prompt nears the context window; summary only applies on its branch; manual compact", async () => {
    const c = h.client();
    const prov = (await c.get("/providers")).body.find((p: any) => p.type === "llm");
    const long = (tag: string) => `${tag}：${"這是一段很長的內容。".repeat(50)}`; // ~500 tokens
    const s0 = (await c.get("/settings/memory")).body;
    await c.req("PUT", "/settings/memory", { ...s0, compaction: { ...s0.compaction, keepRecentRatio: 0.05 } });

    h.script = [textReply(long("回答一"))];
    const r1 = await h.chat({ content: long("問題一") });
    const conv = convOf(r1.events);
    // size the mock model's window so that turn 2 fits and turn 3 does not (fixed = system + tool schemas)
    const fixed = estimateTokens(h.llmBodies[0].messages[0].content) + estimateTokens(JSON.stringify(h.llmBodies[0].tools));
    await c.req("PUT", `/providers/${prov.id}/models`, { models: [{ modelId: "mock-1", capabilities: { tools: true, vision: true }, contextLength: Math.ceil((fixed + 1800) / 0.7) }] });
    h.script = [textReply(long("回答二"))];
    await h.chat({ conversationId: conv, content: long("問題二") });
    let [row] = await h.t.database.db.select().from(conversations).where(eq(conversations.id, conv));
    expect(row.summaryUpTo).toBeNull();

    // third turn pushes the prompt over 70% of 3000 → summary first, then the answer
    h.llmBodies = [];
    h.script = [textReply("- 使用者問了問題一與問題二\n- 助理分別回答"), textReply("第三個回答")];
    const r3 = await h.chat({ conversationId: conv, content: "問題三：總結一下" });
    expect(h.llmBodies).toHaveLength(2);
    expect(h.llmBodies[0].messages[0].content).toContain("壓縮");
    const finalReq = h.llmBodies[1];
    expect(finalReq.messages[0].content).toContain("# 先前對話摘要");
    expect(finalReq.messages[0].content).toContain("使用者問了問題一與問題二");
    expect(JSON.stringify(finalReq.messages.slice(1))).not.toContain("問題一：");
    expect(finalReq.messages.at(-1).content).toBe("問題三：總結一下");
    [row] = await h.t.database.db.select().from(conversations).where(eq(conversations.id, conv));
    expect(row.summaryUpTo).toBeTruthy();
    const steps = await h.t.database.db.select().from(runSteps).where(eq(runSteps.runId, runIdOf(r3.events)));
    expect(steps.some((s) => s.kind === "compacted")).toBe(true);

    // an edit that branches off before the summarized part does not use the summary
    const msgs = (await c.get(`/conversations/${conv}/messages`)).body.messages;
    const firstUser = msgs.find((m: any) => m.role === "user");
    h.llmBodies = [];
    h.script = [textReply("分支回答")];
    await h.chat({ conversationId: conv, content: "改問別的", parentId: firstUser.parentId ?? null });
    expect(h.llmBodies[0].messages[0].content).not.toContain("# 先前對話摘要");

    // manual compaction endpoint
    await c.req("PUT", `/providers/${prov.id}/models`, { models: [{ modelId: "mock-1", capabilities: { tools: true, vision: true } }] });
    const c2 = convOf((await (async () => { h.script = [textReply("A1")]; return h.chat({ content: "短問題一" }); })()).events);
    h.script = [textReply("A2")];
    await h.chat({ conversationId: c2, content: "短問題二" });
    h.script = [textReply("- 摘要內容")];
    const mc = await c.post(`/conversations/${c2}/compact`);
    expect(mc.body).toMatchObject({ compacted: true, summarizedMessages: 2, summary: "- 摘要內容" });
    await c.req("PUT", "/settings/memory", s0);
  });
});
