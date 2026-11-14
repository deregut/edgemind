import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Harness, callsReply, lastEvent, textReply } from "./harness";
import { S3Mock } from "./s3-mock";

const s3 = new S3Mock();
const h = new Harness({ deps: { s3Fetch: s3.fetch } });
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
let pid: string;
const hits: any[] = [];
const toolMsg = (body: any) => { const m = body.messages[body.messages.length - 1]; try { return JSON.parse(m.content); } catch { return m.content; } };

beforeAll(async () => {
  h.routes.push(async (url, init) => {
    if (url.hostname === "mock.img") {
      hits.push({ url: url.toString(), headers: Object.fromEntries(new Headers(init.headers as HeadersInit).entries()), body: JSON.parse(String(init.body)) });
      return Response.json({ data: [{ b64_json: PNG.toString("base64") }] });
    }
    if (url.hostname === "mock.gem") {
      hits.push({ url: url.toString(), body: JSON.parse(String(init.body)) });
      return Response.json({ candidates: [{ content: { parts: [{ text: "ok" }, { inlineData: { mimeType: "image/png", data: PNG.toString("base64") } }] } }] });
    }
    return undefined;
  });
  await h.setup();
  await h.client().req("PUT", "/permissions/mode", { scope: "global", mode: "auto_edit" });
  pid = (await h.client().post("/projects", { name: "圖片專案" })).body.id;
});
afterAll(() => h.teardown());
beforeEach(() => { h.script = []; h.llmBodies = []; hits.length = 0; });

describe("image_generate", () => {
  it("errors clearly without a provider, then works with OpenAI-compatible and Gemini", async () => {
    h.script = [callsReply([{ id: "i0", name: "image_generate", args: { prompt: "貓" } }]), textReply("好")];
    await h.chat({ content: "畫", projectId: pid });
    expect(JSON.stringify(toolMsg(h.llmBodies[1]))).toContain("尚未設定圖片生成供應商");

    const c = h.client();
    const p = (await c.post("/providers", { type: "image", kind: "openai", name: "Img", baseUrl: "https://mock.img/v1", apiKey: "img-key-123456" })).body;
    await c.post(`/providers/${p.id}/models`, { modelId: "gpt-image-1" }).catch(() => {});
    h.script = [callsReply([{ id: "i1", name: "image_generate", args: { prompt: "一隻貓", path: "images/cat.png", size: "512x512" } }]), textReply("完成")];
    h.llmBodies = [];
    const r = await h.chat({ content: "畫貓", projectId: pid });
    expect(lastEvent(r.events)).toMatchObject({ status: "completed" });
    expect(toolMsg(h.llmBodies[1])).toMatchObject({ path: "images/cat.png", mime: "image/png", size: 8 });
    expect(hits[0].url).toBe("https://mock.img/v1/images/generations");
    expect(hits[0].headers.authorization).toBe("Bearer img-key-123456");
    expect(hits[0].body).toMatchObject({ prompt: "一隻貓", size: "512x512", n: 1 });
    expect(Buffer.from((s3.objects.get(`projects/${pid}/files/images/cat.png`) as any).body)).toEqual(PNG);

    await c.req("DELETE", `/providers/${p.id}`);
    await c.post("/providers", { type: "image", kind: "gemini", name: "G", baseUrl: "https://mock.gem", apiKey: "gem-key-123456" });
    hits.length = 0;
    h.script = [callsReply([{ id: "i2", name: "image_generate", args: { prompt: "狗" } }]), textReply("完成")];
    h.llmBodies = [];
    await h.chat({ content: "畫狗", projectId: pid });
    const out = toolMsg(h.llmBodies[1]);
    expect(out.path).toMatch(/^images\/.+\.png$/);
    expect(hits[0].url).toContain("/v1beta/models/");
    expect(hits[0].body.generationConfig.responseModalities).toContain("IMAGE");
  });
});
