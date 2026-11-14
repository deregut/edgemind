import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { builtinRegistry, type Tool } from "../src/agent/tools";
import { runs, usageLogs } from "../src/db/schema";
import { Harness, callsReply, convOf, lastEvent, runIdOf, textReply } from "./harness";

const writeTool: Tool = {
  name: "write_note", description: "寫筆記", risk: "write",
  parameters: { type: "object", properties: {} },
  async execute() { return "ok"; },
};
const projectOnly: Tool = {
  name: "proj_tool", description: "專案限定", risk: "read", projectOnly: true,
  parameters: { type: "object", properties: {} },
  async execute() { return "ok"; },
};
const h = new Harness({ tools: builtinRegistry().register(writeTool, projectOnly) });

beforeAll(() => h.setup());
afterAll(() => h.teardown());
beforeEach(async () => {
  h.script = [];
  h.llmBodies = [];
  await h.t.database.query(`DELETE FROM settings WHERE key IN ('permission_mode','full_mode_caps','model_prices','title_model_id')`);
});

describe("conversations", () => {
  it("lists, searches (CJK substring), pins, archives, renames, moves to a project, deletes", async () => {
    const c = h.client();
    h.script = [textReply("關於台北的天氣，今天晴朗。"), textReply("好的，Rust 的所有權規則如下。")];
    const a = convOf((await h.chat({ content: "台北天氣如何" })).events);
    const b = convOf((await h.chat({ content: "解釋 Rust ownership" })).events);

    let list = await c.get("/conversations");
    expect(list.body.map((x: any) => x.id)).toEqual([b, a]);

    const s = await c.get(`/conversations?q=${encodeURIComponent("晴朗")}`);
    expect(s.body.map((x: any) => x.id)).toEqual([a]);
    expect(s.body[0].snippet).toContain("晴朗");
    expect((await c.get(`/conversations?q=rust`)).body.map((x: any) => x.id)).toEqual([b]);
    expect((await c.get(`/conversations?q=${encodeURIComponent("100%")}`)).body).toEqual([]);

    expect((await c.req("PATCH", `/conversations/${a}`, { pinned: true, title: "台北" })).body).toMatchObject({ pinned: true, title: "台北" });
    list = await c.get("/conversations");
    expect(list.body[0].id).toBe(a);

    await c.req("PATCH", `/conversations/${b}`, { archived: true });
    expect((await c.get("/conversations")).body.map((x: any) => x.id)).toEqual([a]);
    expect((await c.get("/conversations?archived=1")).body.map((x: any) => x.id)).toEqual([b]);

    const p = await c.post("/projects", { name: "研究" });
    expect(p.status).toBe(201);
    expect((await c.req("PATCH", `/conversations/${a}`, { projectId: p.body.id })).body.projectId).toBe(p.body.id);
    expect((await c.get(`/conversations?projectId=${p.body.id}`)).body.map((x: any) => x.id)).toEqual([a]);
    expect((await c.get(`/projects`)).body[0]).toMatchObject({ name: "研究", conversationCount: 1 });
    expect((await c.req("PATCH", `/conversations/${a}`, { projectId: "00000000-0000-4000-8000-000000000000" })).status).toBe(400);
    expect((await c.req("PATCH", `/conversations/${a}`, { permissionMode: "bogus" })).status).toBe(400);
    expect((await c.req("PATCH", `/conversations/${a}`, { permissionMode: "plan" })).body.permissionMode).toBe("plan");

    expect((await c.req("DELETE", `/conversations/${b}`)).status).toBe(200);
    expect((await c.get(`/conversations/${b}`)).status).toBe(404);
  });

  it("auto-title via LLM, export markdown/json, branch switch via active-leaf", async () => {
    const c = h.client();
    h.script = [textReply("答案是 42。")];
    const r1 = await h.chat({ content: "生命的意義是什麼？" });
    const conv = convOf(r1.events);
    h.script = [textReply("「生命的意義」。")];
    const t = await c.post(`/conversations/${conv}/auto-title`);
    expect(t.status).toBe(200);
    expect(t.body.title).toBe("生命的意義");
    expect(h.llmBodies[1].messages[0].content).toContain("取標題");

    // edit-and-branch → two user siblings; switch back to the first branch
    const msgs1 = (await c.get(`/conversations/${conv}/messages`)).body;
    const firstUser = msgs1.messages.find((m: any) => m.role === "user");
    const firstLeaf = msgs1.conversation.activeLeafId;
    h.script = [textReply("另一個答案")];
    await h.chat({ conversationId: conv, content: "改問：宇宙有多大？", parentId: null });
    const msgs2 = (await c.get(`/conversations/${conv}/messages`)).body;
    expect(msgs2.messages.filter((m: any) => m.role === "user" && m.parentId === null)).toHaveLength(2);
    expect(msgs2.activeRun).toBeNull();
    expect((await c.req("PUT", `/conversations/${conv}/active-leaf`, { leafId: firstLeaf })).status).toBe(200);

    const md = await c.get(`/conversations/${conv}/export?format=md`);
    expect(md.headers.get("content-type")).toContain("text/markdown");
    expect(md.body).toContain("# 生命的意義");
    expect(md.body).toContain("答案是 42。");
    expect(md.body).not.toContain("宇宙");
    const js = await c.get(`/conversations/${conv}/export?format=json`);
    expect(js.body.messages.map((m: any) => m.id)).toEqual([firstUser.id, firstLeaf]);
  });

  it("messages endpoint reports an open run with its approvals", async () => {
    h.script = [callsReply([{ id: "w1", name: "write_note", args: {} }])];
    const r = await h.chat({ content: "寫入" });
    expect(lastEvent(r.events)).toMatchObject({ status: "waiting_approval" });
    const m = await h.client().get(`/conversations/${convOf(r.events)}/messages`);
    expect(m.body.activeRun).toMatchObject({ id: runIdOf(r.events), status: "waiting_approval", mode: "stream" });
    expect(m.body.activeRun.approvals[0]).toMatchObject({ toolName: "write_note", risk: "write" });
    expect(m.body.activeRun.lastSeq).toBeGreaterThan(0);
  });
});

describe("projects, models, tools, agent settings", () => {
  it("project CRUD with validation", async () => {
    const c = h.client();
    expect((await c.post("/projects", { name: " " })).status).toBe(400);
    const p = await c.post("/projects", { name: "P", instructions: "一律用表格回答", permissionMode: "auto_edit", defaultModelId: h.modelRowId, enabledTools: ["echo", "echo"] });
    expect(p.body).toMatchObject({ name: "P", permissionMode: "auto_edit", defaultModelId: h.modelRowId, enabledTools: ["echo"] });
    expect((await c.req("PATCH", `/projects/${p.body.id}`, { enabledTools: "x" })).status).toBe(400);
    expect((await c.req("PATCH", `/projects/${p.body.id}`, { enabledTools: null, description: "d" })).body).toMatchObject({ enabledTools: null, description: "d" });
    expect((await c.get(`/projects/${p.body.id}`)).body.instructions).toBe("一律用表格回答");
    expect((await c.req("DELETE", `/projects/${p.body.id}`)).status).toBe(200);
    expect((await c.get(`/projects/${p.body.id}`)).status).toBe(404);
  });

  it("models + tools listing", async () => {
    const c = h.client();
    const m = await c.get("/models");
    expect(m.body).toEqual([expect.objectContaining({ id: h.modelRowId, modelId: "mock-1", providerName: "Mock" })]);
    const t = await c.get("/tools");
    expect(t.body).toEqual(expect.arrayContaining([expect.objectContaining({ name: "write_note", risk: "write" }), expect.objectContaining({ name: "proj_tool", projectOnly: true })]));
  });

  it("project enabledTools filters tool defs and blocks disabled calls; project-only tools hidden outside projects", async () => {
    const c = h.client();
    h.script = [textReply("hi")];
    await h.chat({ content: "no project" });
    const names0 = h.llmBodies[0].tools.map((x: any) => x.function.name);
    expect(names0).toContain("write_note");
    expect(names0).not.toContain("proj_tool");

    const p = await c.post("/projects", { name: "限縮", enabledTools: ["echo", "proj_tool"], instructions: "專案指示 XYZ" });
    h.script = [callsReply([{ id: "x1", name: "write_note", args: {} }, { id: "x2", name: "echo", args: { text: "a" } }]), textReply("done")];
    const r = await h.chat({ content: "go", projectId: p.body.id });
    expect(lastEvent(r.events)).toMatchObject({ status: "completed" });
    const names = h.llmBodies[1].tools.map((x: any) => x.function.name).sort();
    expect(names).toEqual(["echo", "proj_tool"]);
    expect(h.llmBodies[1].messages[0].content).toContain("專案指示 XYZ");
    const tool = h.llmBodies[2].messages.filter((m: any) => m.role === "tool");
    expect(tool[0].content).toContain("未在此專案啟用");
    expect(tool[1].content).toBe('{"text":"a"}');
  });

  it("agent settings round-trip and 全部權限 caps (steps, tokens, cost)", async () => {
    const c = h.client();
    expect((await c.get("/settings/agent")).body.fullModeCaps).toEqual({ maxSteps: 50, maxTokens: 2_000_000, maxCostUsd: null });
    expect((await c.req("PUT", "/settings/agent", { maxSteps: 0 })).status).toBe(400);
    await c.req("PUT", "/permissions/mode", { scope: "global", mode: "full" });

    // step cap
    await c.req("PUT", "/settings/agent", { fullModeCaps: { maxSteps: 2, maxTokens: null, maxCostUsd: null } });
    h.script = [callsReply([{ id: "a", name: "write_note", args: {} }]), callsReply([{ id: "b", name: "write_note", args: {} }]), textReply("never")];
    let r = await h.chat({ content: "loop" });
    expect(lastEvent(r.events)).toEqual({ type: "done", status: "completed", reason: "full_mode_step_cap" });
    expect(h.llmBodies.length).toBe(2);

    // token cap
    h.llmBodies = [];
    await c.req("PUT", "/settings/agent", { fullModeCaps: { maxSteps: null, maxTokens: 1000, maxCostUsd: null } });
    h.script = [callsReply([{ id: "a", name: "write_note", args: {} }], [900, 200]), textReply("never")];
    r = await h.chat({ content: "loop" });
    expect(lastEvent(r.events)).toMatchObject({ reason: "full_mode_token_cap" });
    expect(h.llmBodies.length).toBe(1);

    // cost cap with model prices ($10 / 1M input, $30 / 1M output)
    h.llmBodies = [];
    await c.req("PUT", "/settings/agent", { fullModeCaps: { maxCostUsd: 0.01 }, modelPrices: { [h.modelRowId]: { input: 10, output: 30 } } });
    expect((await c.get("/settings/agent")).body).toMatchObject({ fullModeCaps: { maxSteps: null, maxTokens: null, maxCostUsd: 0.01 }, modelPrices: { [h.modelRowId]: { input: 10, output: 30 } } });
    h.script = [callsReply([{ id: "a", name: "write_note", args: {} }], [1000, 100]), textReply("never")];
    r = await h.chat({ content: "loop" });
    expect(lastEvent(r.events)).toMatchObject({ reason: "full_mode_cost_cap" });
    const u = await h.t.database.db.select().from(usageLogs).where(eq(usageLogs.runId, runIdOf(r.events)));
    expect(u[0].costUsd).toBeCloseTo(0.013, 5);

    // caps do not apply outside full mode
    await c.req("PUT", "/permissions/mode", { scope: "global", mode: "auto_edit" });
    h.script = [callsReply([{ id: "a", name: "write_note", args: {} }], [1000, 100]), textReply("ok")];
    r = await h.chat({ content: "loop" });
    expect(lastEvent(r.events)).toMatchObject({ status: "completed", reason: "stop" });
    const [run] = await h.t.database.db.select().from(runs).where(eq(runs.id, runIdOf(r.events)));
    expect(run.stepCount).toBe(2);
  });
});
