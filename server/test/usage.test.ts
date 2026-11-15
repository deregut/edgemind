import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Harness, callsReply, convOf, lastEvent, runIdOf, textReply } from "./harness";
import { costOf } from "../src/usage";

const h = new Harness();
beforeAll(() => h.setup());
afterAll(() => h.teardown());
beforeEach(() => { h.script = []; h.llmBodies = []; });

const reasoningReply = (text: string) => ({
  sse:
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 2000, completion_tokens: 1000, prompt_tokens_details: { cached_tokens: 1000 }, completion_tokens_details: { reasoning_tokens: 400 } } })}\n\n` +
    "data: [DONE]\n\n",
});

describe("cost", () => {
  it("bills cached input at the cached price (falls back to input price)", () => {
    const prices = { m: { input: 2, output: 8, cachedInput: 0.5 }, n: { input: 2, output: 8 } };
    expect(costOf(prices, "m", { inputTokens: 1_000_000, outputTokens: 100_000, cachedInputTokens: 400_000 })).toBeCloseTo(0.6 * 2 + 0.4 * 0.5 + 0.8, 10);
    expect(costOf(prices, "n", { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 400_000 })).toBeCloseTo(2, 10);
    expect(costOf(prices, "x", { inputTokens: 1, outputTokens: 1 })).toBeNull();
  });
});

describe("usage recording, dashboard API and spend caps", () => {
  it("records per-step tokens (cached / reasoning) with cost and aggregates them", async () => {
    const c = h.client();
    expect((await c.req("PUT", "/settings/agent", { modelPrices: { [h.modelRowId]: { input: 1, output: 2, cachedInput: 0.25 } } })).status).toBe(200);
    expect((await c.get("/settings/agent")).body.modelPrices[h.modelRowId]).toEqual({ input: 1, output: 2, cachedInput: 0.25 });
    expect((await c.req("PUT", "/settings/spend-caps", { timezone: "UTC" })).status).toBe(200);

    const proj = await c.post("/projects", { name: "研究" });
    h.script = [callsReply([{ id: "t1", name: "get_time", args: {} }], [1000, 500]), reasoningReply("答案")];
    const r = await h.chat({ content: "現在幾點", projectId: proj.body.id });
    expect(lastEvent(r.events)).toMatchObject({ type: "done", status: "completed" });
    const rows = await h.t.database.query<any>("SELECT * FROM usage_logs WHERE run_id = $1 ORDER BY created_at", [runIdOf(r.events)]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ input_tokens: 1000, output_tokens: 500, model_id: h.modelRowId, conversation_id: convOf(r.events) });
    expect(rows[0].cost_usd).toBeCloseTo(0.002, 8);
    expect(rows[1]).toMatchObject({ cached_tokens: 1000, reasoning_tokens: 400 });
    expect(rows[1].cost_usd).toBeCloseTo((1000 * 1 + 1000 * 0.25 + 1000 * 2) / 1e6, 8);

    // a backdated row: 23:30 UTC on Jan 10 is Jan 11 in Taipei
    await h.t.database.query("INSERT INTO usage_logs (kind, model, input_tokens, output_tokens, cost_usd, created_at) VALUES ('chat', 'old-model', 10, 10, 1.5, '2026-01-10T23:30:00Z')");

    const u = (await c.get("/usage")).body;
    expect(u.daily).toHaveLength(30);
    expect(u.totals.calls).toBe(2);
    expect(u.totals.inputTokens).toBe(3000);
    expect(u.totals.reasoningTokens).toBe(400);
    expect(u.totals.costUsd).toBeCloseTo(0.00525, 8);
    expect(u.daily.at(-1).costUsd).toBeCloseTo(0.00525, 8);
    expect(u.byModel[0].label).toBe("Mock / mock-1");
    expect(u.byProject[0]).toMatchObject({ key: proj.body.id, label: "研究" });
    expect(u.byConversation[0].key).toBe(convOf(r.events));
    expect(u.byKind[0]).toMatchObject({ key: "chat", calls: 2 });

    const tpe = (await c.get("/usage?from=2026-01-01&to=2026-01-31&tz=Asia/Taipei")).body;
    expect(tpe.daily).toHaveLength(31);
    expect(tpe.daily.find((d: any) => d.costUsd > 0).date).toBe("2026-01-11");
    expect(tpe.unpricedCalls).toBe(0);
    expect(tpe.byConversation[0].label).toBe("（不屬於對話）");
    expect((await c.get("/usage?from=2026-02-01&to=2026-01-01")).status).toBe(400);
  });

  it("warns at 80 % and blocks LLM calls at the daily / monthly cap with a clear error", async () => {
    const c = h.client();
    expect((await c.req("PUT", "/settings/spend-caps", { timezone: "Mars/Base" })).status).toBe(400);
    expect((await c.req("PUT", "/settings/spend-caps", { dailyUsd: -1 })).status).toBe(400);
    // spent today so far: 0.00525 → cap 0.006 puts us at 87 %
    await c.req("PUT", "/settings/spend-caps", { dailyUsd: 0.006, monthlyUsd: null });
    const st = (await c.get("/usage/status")).body;
    expect(st.daily).toBe("warning");
    expect(st.message).toContain("每日上限的 87%");

    h.script = [textReply("好", [1000, 500])];
    const r = await h.chat({ content: "第一題" });
    expect(lastEvent(r.events)).toMatchObject({ status: "completed" });
    const steps = (await c.get(`/runs/${runIdOf(r.events)}/events`)).body.steps;
    expect(steps.filter((s: any) => s.kind === "spend_warning")).toHaveLength(1);

    // now over the cap: no model call, failed with reason spend_cap
    h.script = [textReply("不應該被呼叫")];
    h.llmBodies = [];
    const r2 = await h.chat({ content: "第二題" });
    expect(h.llmBodies).toHaveLength(0);
    expect(r2.events.find((e: any) => e.type === "error")).toMatchObject({ error: { code: "spend_cap" } });
    expect(lastEvent(r2.events)).toMatchObject({ type: "done", status: "failed", reason: "spend_cap" });
    const run2 = (await c.get(`/runs/${runIdOf(r2.events)}`)).body;
    expect(run2.error).toContain("已達每日花費上限");
    expect((await c.get("/usage/status")).body.daily).toBe("blocked");
    // auto-title is blocked too
    const t = await c.post(`/conversations/${convOf(r.events)}/auto-title`, {});
    expect(t.status).toBe(429);

    // monthly cap
    await c.req("PUT", "/settings/spend-caps", { dailyUsd: null, monthlyUsd: 0.001 });
    const r3 = await h.chat({ content: "第三題" });
    expect(lastEvent(r3.events)).toMatchObject({ status: "failed", reason: "spend_cap" });
    expect((await c.get(`/runs/${runIdOf(r3.events)}`)).body.error).toContain("每月花費上限");

    // lifting the cap restores service
    await c.req("PUT", "/settings/spend-caps", { dailyUsd: null, monthlyUsd: null });
    h.script = [textReply("恢復")];
    expect(lastEvent((await h.chat({ content: "第四題" })).events)).toMatchObject({ status: "completed" });
  });

  it("sub-agent calls are priced and stop at the cap", async () => {
    const c = h.client();
    h.script = [callsReply([{ id: "s1", name: "subagent", args: { task: "查" } }]), textReply("子結論", [2000, 0]), textReply("主完成")];
    const r = await h.chat({ content: "派子代理" });
    const rows = await h.t.database.query<any>("SELECT cost_usd FROM usage_logs WHERE run_id = $1 ORDER BY created_at", [runIdOf(r.events)]);
    expect(rows).toHaveLength(3);
    expect(rows[1].cost_usd).toBeCloseTo(0.002, 8);

    const spent = (await c.get("/usage/status")).body.todayUsd;
    // cap just above what is spent: the parent's first call fits, then the sub-agent hits the cap after it
    h.script = [callsReply([{ id: "s2", name: "subagent", args: { task: "查" } }], [10_000, 0]), textReply("主：子代理失敗")];
    await c.req("PUT", "/settings/spend-caps", { dailyUsd: spent + 0.005 });
    const r2 = await h.chat({ content: "再派" });
    expect(lastEvent(r2.events)).toMatchObject({ type: "done", status: "failed", reason: "spend_cap" });
    const toolMsg = r2.events.filter((e: any) => e.type === "message").map((e: any) => e.message).find((m: any) => m.role === "tool");
    expect(JSON.stringify(toolMsg.parts)).toContain("已達每日花費上限");
    await c.req("PUT", "/settings/spend-caps", { dailyUsd: null });
  });
});
