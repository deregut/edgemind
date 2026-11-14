import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { fileVersions, files, memories, toolApprovals } from "../src/db/schema";
import { md5Base64 } from "../src/lib/md5";
import { decodeUtf8Window } from "../src/storage/files";
import { Harness, callsReply, convOf, lastEvent, runIdOf, textReply } from "./harness";
import { S3Mock } from "./s3-mock";
import { createHash } from "node:crypto";

const s3 = new S3Mock();
const h = new Harness({ deps: { s3Fetch: s3.fetch } });
let pid: string;

/** Tool results of the latest step (the trailing tool messages of a request). */
const trailingTools = (body: any) => {
  const out: any[] = [];
  for (let i = body.messages.length - 1; i >= 0 && body.messages[i].role === "tool"; i--) out.unshift(body.messages[i]);
  return out;
};
const toolMsgs = (body: any) => trailingTools(body).map((m: any) => { try { return JSON.parse(m.content); } catch { return m.content; } });

beforeAll(async () => {
  await h.setup();
  await h.client().req("PUT", "/permissions/mode", { scope: "global", mode: "auto_edit" });
  pid = (await h.client().post("/projects", { name: "檔案專案" })).body.id;
});
afterAll(() => h.teardown());
beforeEach(() => {
  h.script = [];
  h.llmBodies = [];
});

describe("md5 / utf-8 helpers", () => {
  it("md5 matches node crypto", () => {
    for (const s of ["", "a", "hello world", "x".repeat(1000), "中文測試".repeat(50)]) {
      const b = new TextEncoder().encode(s);
      expect(md5Base64(b)).toBe(createHash("md5").update(b).digest("base64"));
    }
  });
  it("never splits a multi-byte character", () => {
    const b = new TextEncoder().encode("ab中文");
    const w = decodeUtf8Window(b.subarray(0, 4), false); // cuts inside 中
    expect(w).toEqual({ text: "ab", used: 2, skipped: 0 });
    const w2 = decodeUtf8Window(b.subarray(3), true); // starts mid-character
    expect(w2.text).toBe("文");
  });
});

describe("file_* tools in a project", () => {
  it("write → read → edit → list → search → delete, with versions in file_versions", async () => {
    h.script = [
      callsReply([{ id: "w1", name: "file_write", args: { path: "docs/notes.md", content: "# 筆記\n第一行\n待辦：買牛奶\n" } }]),
      callsReply([{ id: "r1", name: "file_read", args: { path: "docs/notes.md" } }, { id: "l1", name: "file_list", args: {} }]),
      callsReply([{ id: "e1", name: "file_edit", args: { path: "docs/notes.md", old_string: "買牛奶", new_string: "買咖啡" } }]),
      callsReply([{ id: "a1", name: "file_write", args: { path: "docs/notes.md", content: "追加一行\n", mode: "append" } }, { id: "w2", name: "file_write", args: { path: "src/app.ts", content: "const 咖啡 = 1;\n" } }]),
      callsReply([{ id: "s1", name: "file_search", args: { query: "咖啡" } }, { id: "s2", name: "file_search", args: { query: "咖啡", glob: "docs/**" } }]),
      callsReply([{ id: "d1", name: "file_delete", args: { path: "src/app.ts" } }, { id: "x1", name: "file_read", args: { path: "../etc/passwd" } }]),
      textReply("完成"),
    ];
    const r = await h.chat({ content: "整理檔案", projectId: pid });
    expect(lastEvent(r.events)).toMatchObject({ status: "completed" });
    const names = h.llmBodies[0].tools.map((t: any) => t.function.name);
    expect(names).toEqual(expect.arrayContaining(["file_list", "file_read", "file_write", "file_edit", "file_delete", "file_search"]));

    const [w1] = toolMsgs(h.llmBodies[1]);
    expect(w1).toMatchObject({ ok: true, path: "docs/notes.md", version: 1 });
    const [r1, l1] = toolMsgs(h.llmBodies[2]);
    expect(r1).toMatchObject({ path: "docs/notes.md", offset: 0, nextOffset: null, content: "# 筆記\n第一行\n待辦：買牛奶\n" });
    expect(l1.files.map((f: any) => f.path)).toEqual(["docs/notes.md"]);
    expect(toolMsgs(h.llmBodies[3])[0]).toMatchObject({ ok: true, replacements: 1, version: 2 });
    const [a1, w2] = toolMsgs(h.llmBodies[4]);
    expect(a1.version).toBe(3);
    expect(w2.version).toBe(1);
    expect(s3.text(`projects/${pid}/files/docs/notes.md`)).toBe("# 筆記\n第一行\n待辦：買咖啡\n追加一行\n");
    const [s1, s2] = toolMsgs(h.llmBodies[5]);
    expect(s1.matches).toEqual([{ path: "docs/notes.md", line: 3, text: "待辦：買咖啡" }, { path: "src/app.ts", line: 1, text: "const 咖啡 = 1;" }]);
    expect(s2.matches.map((m: any) => m.path)).toEqual(["docs/notes.md"]);
    const [d1, x1] = trailingTools(h.llmBodies[6]).map((m: any) => m.content);
    expect(JSON.parse(d1)).toMatchObject({ ok: true, deleted: "src/app.ts" });
    expect(x1).toContain("不可包含 ..");

    const notes = (await h.t.database.db.select().from(files).where(eq(files.path, "docs/notes.md")))[0];
    const vs = await h.t.database.db.select().from(fileVersions).where(eq(fileVersions.fileId, notes.id));
    expect(vs.map((v) => v.version).sort()).toEqual([1, 2]);
    expect(s3.text(vs.find((v) => v.version === 1)!.s3Key)).toContain("買牛奶");
    const app = (await h.t.database.db.select().from(files).where(eq(files.path, "src/app.ts")))[0];
    expect(app.status).toBe("deleted");
    expect(s3.objects.has(app.s3Key)).toBe(false);

    // version history + restore via the API
    const c = h.client();
    expect((await c.get(`/files/${notes.id}/versions`)).body.map((v: any) => v.version)).toEqual([2, 1]);
    const restored = await c.post(`/files/${notes.id}/restore`, { version: 1 });
    expect(restored.body.version).toBe(4);
    expect(s3.text(notes.s3Key)).toContain("買牛奶");
    expect((await c.get(`/projects/${pid}/files`)).body.map((f: any) => f.path)).toEqual(["docs/notes.md"]);
  });

  it("reads large files in byte ranges without breaking characters", async () => {
    const big = Array.from({ length: 3000 }, (_, i) => `第${i}行：資料內容`).join("\n");
    const store = (await import("../src/storage/files")).FileStore;
    const { S3 } = await import("../src/storage/s3");
    await new store(h.t.database, new S3(h.env as any, s3.fetch)).write(pid, "big.txt", new TextEncoder().encode(big));
    let offset: number | null = 0;
    let acc = "";
    let calls = 0;
    while (offset !== null && calls < 20) {
      h.script = [callsReply([{ id: `rr${calls}`, name: "file_read", args: { path: "big.txt", offset, length: 10000 } }]), textReply("ok")];
      h.llmBodies = [];
      await h.chat({ content: "讀", projectId: pid });
      const res = toolMsgs(h.llmBodies[1])[0];
      acc += res.content;
      offset = res.nextOffset;
      calls++;
    }
    expect(acc).toBe(big);
    expect(calls).toBeGreaterThan(5);
  });

  it("file tools are not offered outside a project and refuse there", async () => {
    h.script = [callsReply([{ id: "z", name: "file_list", args: {} }]), textReply("ok")];
    await h.chat({ content: "沒有專案" });
    expect(h.llmBodies[0].tools.map((t: any) => t.function.name)).not.toContain("file_list");
    expect(trailingTools(h.llmBodies[1])[0].content).toContain("只能在專案內");
  });
});

describe("browser-direct uploads", () => {
  it("single PUT: presign → browser PUT → complete; auto-applies bucket CORS once (valid Content-MD5)", async () => {
    const c = h.client();
    const t = await c.post("/uploads", { scope: "project", projectId: pid, path: "data/a.csv", size: 11, mime: "text/csv" }, { headers: { origin: "http://localhost" } });
    expect(t.status).toBe(201);
    expect(t.body.method).toBe("put");
    expect(t.body.url).toContain("X-Amz-Signature=");
    expect(t.body.url).toContain(`/edgemind/projects/${pid}/files/data/a.csv`);
    expect(s3.corsCalls).toBe(1);
    expect(s3.cors).toContain("<AllowedOrigin>http://localhost</AllowedOrigin>");
    expect(s3.cors).toContain("<ExposeHeader>ETag</ExposeHeader>");
    // the browser uploads straight to S3 (no server proxy, no auth header)
    expect((await s3.fetch(t.body.url, { method: "PUT", body: "a,b\n1,2\n3,4", headers: t.body.headers })).status).toBe(200);
    const done = await c.post(`/uploads/${t.body.fileId}/complete`, {});
    expect(done.body).toMatchObject({ path: "data/a.csv", size: 11, status: "ready", version: 1 });
    // second upload from the same origin does not touch CORS again; overwrite keeps a version
    const t2 = await c.post("/uploads", { scope: "project", projectId: pid, path: "data/a.csv", size: 3, mime: "text/csv" }, { headers: { origin: "http://localhost" } });
    expect(s3.corsCalls).toBe(1);
    await s3.fetch(t2.body.url, { method: "PUT", body: "x,y" });
    expect((await c.post(`/uploads/${t2.body.fileId}/complete`, {})).body.version).toBe(2);
    expect((await c.get(`/files/${t2.body.fileId}/versions`)).body.map((v: any) => v.version)).toEqual([1]);
    const dl = await c.get(`/files/${t2.body.fileId}/download`);
    expect(dl.body.url).toContain("response-content-disposition");
    expect(await (await s3.fetch(dl.body.url)).text()).toBe("x,y");
    // explicit CORS endpoint
    const cors = await c.post("/storage/cors", { origin: "http://localhost:5173" });
    expect(cors.body.origins).toEqual(["http://localhost", "http://localhost:5173"]);
    expect(s3.cors).toContain("<AllowedOrigin>http://localhost:5173</AllowedOrigin>");
    expect((await c.post(`/uploads/${t.body.fileId}/complete`, {})).status).toBe(200);
  });

  it("multipart: part URLs → browser PUTs parts → complete with ETags", async () => {
    const c = h.client();
    const size = 33 * 1024 * 1024 + 5;
    const data = new Uint8Array(size);
    for (let i = 0; i < size; i++) data[i] = i % 251;
    const t = await c.post("/uploads", { scope: "project", projectId: pid, path: "big.bin", size, mime: "application/octet-stream" });
    expect(t.body.method).toBe("multipart");
    expect(t.body.parts.length).toBe(Math.ceil(size / t.body.partSize));
    const parts = [];
    for (const p of t.body.parts) {
      const chunk = data.subarray((p.partNumber - 1) * t.body.partSize, p.partNumber * t.body.partSize);
      const res = await s3.fetch(p.url, { method: "PUT", body: chunk });
      parts.push({ partNumber: p.partNumber, etag: res.headers.get("etag")! });
    }
    expect((await c.post(`/uploads/${t.body.fileId}/complete`, { parts: [] })).status).toBe(400);
    const done = await c.post(`/uploads/${t.body.fileId}/complete`, { parts });
    expect(done.body).toMatchObject({ size, status: "ready" });
    expect(Buffer.from(s3.objects.get(`projects/${pid}/files/big.bin`)!.body).equals(Buffer.from(data))).toBe(true);
    const [row] = await h.t.database.db.select().from(files).where(eq(files.id, t.body.fileId));
    expect(row.uploadId).toBeNull();
  });

  it("abort removes a pending upload; complete without the object fails", async () => {
    const c = h.client();
    const t = await c.post("/uploads", { scope: "upload", name: "x.txt", size: 5 });
    expect((await c.post(`/uploads/${t.body.fileId}/complete`, {})).status).toBe(409);
    expect((await c.post(`/uploads/${t.body.fileId}/abort`, {})).status).toBe(200);
    expect((await c.get(`/files/${t.body.fileId}`)).status).toBe(404);
  });

  it("chat attachments by fileId reach the model (text inline, image as image part)", async () => {
    const c = h.client();
    const up = async (name: string, mime: string, body: Uint8Array | string) => {
      const size = typeof body === "string" ? new TextEncoder().encode(body).length : body.length;
      const t = await c.post("/uploads", { scope: "upload", name, size, mime });
      await s3.fetch(t.body.url, { method: "PUT", body: body as BodyInit, headers: t.body.headers });
      await c.post(`/uploads/${t.body.fileId}/complete`, {});
      return t.body.fileId as string;
    };
    const txt = await up("說明.md", "text/markdown", "# 機密說明\n密碼提示：藍色大象");
    const png = await up("pic.png", "image/png", new Uint8Array([137, 80, 78, 71, 1, 2, 3]));
    expect(s3.objects.has([...s3.objects.keys()].find((k) => k.startsWith("users/1/uploads/") && k.endsWith("說明.md"))!)).toBe(true);
    h.script = [textReply("看到了")];
    const r = await h.chat({ content: [{ type: "text", text: "看附件" }, { type: "file", fileId: txt, name: "說明.md", mime: "text/markdown" }, { type: "file", fileId: png, name: "pic.png", mime: "image/png" }] });
    expect(lastEvent(r.events)).toMatchObject({ status: "completed" });
    const user = h.llmBodies[0].messages.find((m: any) => m.role === "user");
    const flat = JSON.stringify(user.content);
    expect(flat).toContain("藍色大象");
    expect(flat).toContain("data:image/png;base64,iVBORwECAw==");
    // stored message keeps only the reference
    const msgs = (await c.get(`/conversations/${convOf(r.events)}/messages`)).body.messages;
    const stored = msgs.find((m: any) => m.role === "user").parts;
    expect(stored[1]).toEqual({ type: "file", fileId: txt, name: "說明.md", mime: "text/markdown" });
  });

  it("deleting a project purges its objects", async () => {
    const c = h.client();
    const p2 = (await c.post("/projects", { name: "暫時" })).body.id;
    h.script = [callsReply([{ id: "w", name: "file_write", args: { path: "a.txt", content: "1" } }]), callsReply([{ id: "w2", name: "file_write", args: { path: "a.txt", content: "2" } }]), textReply("ok")];
    await h.chat({ content: "寫", projectId: p2 });
    expect([...s3.objects.keys()].filter((k) => k.startsWith(`projects/${p2}/`)).length).toBe(2);
    await c.req("DELETE", `/projects/${p2}`);
    expect([...s3.objects.keys()].filter((k) => k.startsWith(`projects/${p2}/`))).toEqual([]);
  });
});

describe("memory tools", () => {
  it("keyword fallback without an embedding provider; scopes; update/delete", async () => {
    h.script = [
      callsReply([{ id: "m1", name: "memory_save", args: { content: "使用者喜歡烏龍茶，不加糖" } }, { id: "m2", name: "memory_save", args: { content: "專案使用 TypeScript", scope: "project" } }]),
      callsReply([{ id: "q1", name: "memory_search", args: { query: "烏龍茶" } }]),
      textReply("ok"),
    ];
    await h.chat({ content: "記住", projectId: pid });
    const [s1, s2] = toolMsgs(h.llmBodies[1]);
    expect(s1.memory).toMatchObject({ scope: "project" }); // default in a project
    expect(s2.memory.scope).toBe("project");
    const q = toolMsgs(h.llmBodies[2])[0];
    expect(q.mode).toBe("keyword");
    expect(q.results[0].content).toContain("烏龍茶");
    // outside the project the project memories are invisible
    h.llmBodies = [];
    h.script = [callsReply([{ id: "q2", name: "memory_search", args: { query: "烏龍茶" } }, { id: "g1", name: "memory_save", args: { content: "全域：使用者住在台北" } }]), textReply("ok")];
    await h.chat({ content: "查" });
    const [q2, g1] = toolMsgs(h.llmBodies[1]);
    expect(q2.results).toEqual([]);
    expect(g1.memory.scope).toBe("global");
    h.llmBodies = [];
    h.script = [
      callsReply([{ id: "u1", name: "memory_update", args: { id: g1.memory.id, content: "全域：使用者住在新竹" } }]),
      callsReply([{ id: "d1", name: "memory_delete", args: { id: s1.memory.id } }]),
      textReply("ok"),
    ];
    await h.chat({ content: "改" });
    expect(toolMsgs(h.llmBodies[1])[0].memory.content).toBe("全域：使用者住在新竹");
    expect(trailingTools(h.llmBodies[2])[0].content).toContain("找不到這則記憶"); // project memory not visible here
  });

  it("vector search when an embedding provider is configured", async () => {
    const c = h.client();
    const p = await c.post("/providers", { type: "embedding", kind: "openai", name: "Emb", baseUrl: "https://mock.emb/v1", apiKey: "sk-emb-123456" });
    await c.req("PUT", `/providers/${p.body.id}/models`, { models: [{ modelId: "emb-3" }] });
    const vec = (t: string) => (t.includes("茶") ? [1, 0, 0] : t.includes("狗") ? [0, 1, 0] : [0, 0, 1]);
    h.routes.unshift((url, init) => {
      if (url.hostname !== "mock.emb") return undefined;
      const body = JSON.parse(String(init.body));
      return Response.json({ data: body.input.map((t: string, index: number) => ({ index, embedding: vec(t) })) });
    });
    h.script = [
      callsReply([{ id: "v1", name: "memory_save", args: { content: "最愛的飲料是綠茶", scope: "global" } }, { id: "v2", name: "memory_save", args: { content: "養了一隻狗叫小黑", scope: "global" } }]),
      callsReply([{ id: "v3", name: "memory_search", args: { query: "喝什麼茶", limit: 1 } }]),
      textReply("ok"),
    ];
    await h.chat({ content: "記" });
    const res = toolMsgs(h.llmBodies[2])[0];
    expect(res.mode).toBe("vector");
    expect(res.results).toHaveLength(1);
    expect(res.results[0]).toMatchObject({ content: "最愛的飲料是綠茶", score: 1 });
    const rows = await h.t.database.db.select().from(memories).where(eq(memories.content, "養了一隻狗叫小黑"));
    expect(rows[0]).toMatchObject({ embeddingDim: 3, embeddingModel: "emb-3" });
    h.routes.shift();
    await h.t.database.query("DELETE FROM providers WHERE type = 'embedding'");
  });
});

describe("ask_user and todo", () => {
  it("ask_user pauses the run until answered (also in plan mode); deny = skip", async () => {
    const c = h.client();
    h.script = [callsReply([{ id: "ask1", name: "ask_user", args: { question: "要用哪個資料庫？", choices: ["Postgres", "SQLite"] } }])];
    const r = await h.chat({ content: "幫我規劃", permissionMode: "plan" });
    expect(lastEvent(r.events)).toMatchObject({ status: "waiting_approval" });
    const ap = (r.events.find((e) => e.type === "approval-required") as any).approvals[0];
    expect(ap).toMatchObject({ toolName: "ask_user", kind: "question", args: { question: "要用哪個資料庫？" } });
    const runId = runIdOf(r.events);
    expect((await c.post(`/runs/${runId}/approvals`, { toolCallId: "ask1", decision: "allow_once" })).status).toBe(400);
    expect((await c.post(`/runs/${runId}/answers`, { toolCallId: "ask1", answer: " " })).status).toBe(400);
    const a = await c.post(`/runs/${runId}/answers`, { toolCallId: "ask1", answer: "Postgres" });
    expect(a.body).toMatchObject({ status: "paused", resume: true, remaining: [] });
    h.script = [textReply("好，用 Postgres")];
    const r2 = await h.chat({ runId, action: "continue" });
    expect(lastEvent(r2.events)).toMatchObject({ status: "completed" });
    expect(toolMsgs(h.llmBodies[1])[0]).toEqual({ answer: "Postgres" });
    const [appr] = await h.t.database.db.select().from(toolApprovals).where(eq(toolApprovals.toolCallId, "ask1"));
    expect(appr).toMatchObject({ kind: "question", status: "approved", answer: "Postgres" });

    h.llmBodies = [];
    h.script = [callsReply([{ id: "ask2", name: "ask_user", args: { question: "還有嗎？" } }])];
    const r3 = await h.chat({ content: "再問" });
    await c.post(`/runs/${runIdOf(r3.events)}/approvals`, { toolCallId: "ask2", decision: "deny" });
    h.script = [textReply("ok")];
    await h.chat({ runId: runIdOf(r3.events), action: "continue" });
    expect(toolMsgs(h.llmBodies[1])[0]).toMatchObject({ skipped: true });
  });

  it("todo stores the plan on the conversation", async () => {
    h.script = [
      callsReply([{ id: "t1", name: "todo", args: { items: [{ content: "查資料", status: "done" }, { content: "寫報告", status: "in_progress" }] } }]),
      callsReply([{ id: "t2", name: "todo", args: {} }]),
      textReply("ok"),
    ];
    await h.chat({ content: "計畫" });
    expect(toolMsgs(h.llmBodies[1])[0]).toMatchObject({ ok: true, progress: "1/2" });
    expect(toolMsgs(h.llmBodies[2])[0].items).toHaveLength(2);
  });
});
