/**
 * Regression: 「非專案中又無法建立對話」.
 * The global default model is kept in `settings` (no foreign key). After the user re-synced / removed a provider's
 * models, deleted the provider or disabled the model, it still pointed at the old row: the chat page sent that id for
 * every chat outside a project (inside a project its own default — FK, ON DELETE SET NULL — won), POST /api/chat
 * answered 400 「找不到指定的模型」 and still left an empty conversation behind.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { conversations, models, settings } from "../src/db/schema";
import { Harness, convOf, lastEvent, textReply } from "./harness";

const h = new Harness();
let staleId = "";

async function convCount() {
  return (await h.t.database.db.select({ id: conversations.id }).from(conversations)).length;
}

beforeAll(async () => {
  await h.setup();
  const c = h.client();
  // a second provider whose model becomes the global default, then disappears
  const p = await c.post("/providers", { type: "llm", kind: "openai", name: "Old", baseUrl: "https://mock.llm/v1", apiKey: "sk-old-123456" });
  const m = await c.req("PUT", `/providers/${p.body.id}/models`, { models: [{ modelId: "old-model", capabilities: { tools: true } }] });
  staleId = m.body[0].id;
  expect((await c.req("PUT", "/settings/agent", { defaultModelId: staleId, titleModelId: staleId })).status).toBe(200);
  expect((await c.req("DELETE", `/providers/${p.body.id}`)).status).toBe(200);
});
afterAll(() => h.teardown());
beforeEach(() => {
  h.script = [];
  h.llmBodies = [];
});

describe("new conversation outside a project with a stale global default model", () => {
  it("GET /settings/agent reports a removed default / title model as not set", async () => {
    const s = await h.client().get("/settings/agent");
    expect(s.body.defaultModelId).toBeNull();
    expect(s.body.titleModelId).toBeNull();
  });

  it("no modelId: the server skips the stale default and uses a usable model", async () => {
    h.script = [textReply("ok")];
    const r = await h.chat({ content: "嗨", modelId: undefined });
    expect(r.status).toBe(200);
    expect(lastEvent(r.events)).toMatchObject({ type: "done", status: "completed" });
    const [conv] = await h.t.database.db.select().from(conversations).where(eq(conversations.id, convOf(r.events)));
    expect(conv.projectId).toBeNull();
    expect(h.llmBodies[0].model).toBe("mock-1");
  });

  it("a page still holding the removed id (explicit modelId) is not refused", async () => {
    h.script = [textReply("ok")];
    const r = await h.chat({ content: "嗨", modelId: staleId });
    expect(r.status).toBe(200);
    expect(lastEvent(r.events)).toMatchObject({ type: "done", status: "completed" });
    expect(h.llmBodies[0].model).toBe("mock-1");
  });

  it("projectId null / omitted both create a non-project conversation", async () => {
    for (const projectId of [null, undefined]) {
      h.script = [textReply("ok")];
      const r = await h.chat({ content: "嗨", projectId });
      expect(lastEvent(r.events)).toMatchObject({ type: "done", status: "completed" });
      const [conv] = await h.t.database.db.select().from(conversations).where(eq(conversations.id, convOf(r.events)));
      expect(conv.projectId).toBeNull();
    }
  });

  it("a disabled default model is skipped too", async () => {
    const c = h.client();
    const p = await c.post("/providers", { type: "llm", kind: "openai", name: "Off", baseUrl: "https://mock.llm/v1", apiKey: "sk-off-123456" });
    const m = await c.req("PUT", `/providers/${p.body.id}/models`, { models: [{ modelId: "off-model", capabilities: { tools: true }, enabled: false }] });
    await h.t.database.db.update(settings).set({ value: m.body[0].id }).where(eq(settings.key, "default_model_id"));
    expect((await c.get("/settings/agent")).body.defaultModelId).toBeNull();
    h.script = [textReply("ok")];
    const r = await h.chat({ content: "嗨", modelId: m.body[0].id });
    expect(lastEvent(r.events)).toMatchObject({ type: "done", status: "completed" });
    expect(h.llmBodies[0].model).toBe("mock-1");
    await h.t.database.db.delete(models).where(eq(models.id, m.body[0].id));
  });

  it("a first message that is refused leaves no empty conversation behind", async () => {
    const before = await convCount();
    const bad = await h.chat({ content: "嗨", modelId: "not-a-uuid" });
    expect(bad.status).toBe(400);
    const empty = await h.chat({ content: "   " });
    expect(empty.status).toBe(400);
    const noProject = await h.chat({ content: "嗨", projectId: "00000000-0000-4000-8000-000000000000" });
    expect(noProject.status).toBe(400);
    expect(await convCount()).toBe(before);
  });

  it("no usable model at all: a clear 400 and still no empty conversation", async () => {
    await h.t.database.db.update(models).set({ enabled: false });
    try {
      const before = await convCount();
      const r = await h.chat({ content: "嗨", modelId: undefined });
      expect(r.status).toBe(400);
      expect(r.json.message).toContain("尚未設定任何語言模型");
      expect(await convCount()).toBe(before);
    } finally {
      await h.t.database.db.update(models).set({ enabled: true });
    }
  });
});
