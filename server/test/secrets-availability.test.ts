/**
 * Regression: "我在設定 → 密鑰新增了 E2B_API_KEY，專案裡的模型卻說讀不到".
 * Captures the exact system prompt + tool list the (mock) model receives in every path where a saved secret could be
 * unusable, and checks the prompt tells the model the real reason (plan mode, project tool list, deny rule, no domains).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { parseAllowedDomains } from "../../shared/src/index";
import { settings, toolPolicies } from "../src/db/schema";
import { normalizeDomains } from "../src/secrets";
import { resetBuiltinSkillsMemo } from "../src/skills/builtin";
import { Harness, callsReply, convOf, lastEvent, textReply } from "./harness";
import { S3Mock } from "./s3-mock";

const s3 = new S3Mock();
const h = new Harness({ deps: { s3Fetch: s3.fetch } });
const KEY = "e2b_test_fake_key_0123456789";
const hits: { host: string; path: string; method: string; headers: Record<string, string>; body: string | null }[] = [];

const sysOf = (i = 0) => h.llmBodies[i].messages[0].content as string;
const toolsOf = (i = 0) => (h.llmBodies[i].tools ?? []).map((t: any) => t.function.name) as string[];
const vaultOf = (i = 0) => (sysOf(i).split("# 密鑰\n")[1] ?? "").split("\n# ")[0];
const toolResults = (body: any) => {
  const out: any[] = [];
  for (let i = body.messages.length - 1; i >= 0 && body.messages[i].role === "tool"; i--) out.unshift(body.messages[i]);
  return out.map((m) => { try { return JSON.parse(m.content); } catch { return m.content; } });
};

let secretId = "";
let pid = "";

beforeAll(async () => {
  h.routes.push((url) => {
    if (url.hostname !== "cloudflare-dns.com") return undefined;
    const name = url.searchParams.get("name")!;
    const ok = ["api.e2b.app", "sandbox.e2b.app"].includes(name) && url.searchParams.get("type") === "A";
    return Response.json({ Status: 0, Answer: ok ? [{ name, type: 1, data: "93.184.216.40" }] : [] });
  });
  h.routes.push((url, init) => {
    if (!["api.e2b.app", "sandbox.e2b.app"].includes(url.hostname)) return undefined;
    const headers = Object.fromEntries(new Headers(init.headers as HeadersInit).entries());
    const body = typeof init.body === "string" ? init.body : null;
    hits.push({ host: url.hostname, path: url.pathname, method: String(init.method ?? "GET"), headers, body });
    if (url.hostname === "api.e2b.app") {
      if (headers["x-api-key"] !== KEY) return Response.json({ code: 401, message: "Invalid API key" }, { status: 401 });
      if (url.pathname === "/v2/sandboxes" && init.method === "POST") {
        return Response.json({ sandboxID: "sbx1", templateID: "code-interpreter-v1", envdAccessToken: "envd-tok-1", trafficAccessToken: null, domain: null }, { status: 201 });
      }
      if (url.pathname === "/sandboxes/sbx1" && init.method === "DELETE") return new Response(null, { status: 204 });
    }
    if (url.hostname === "sandbox.e2b.app" && url.pathname === "/execute") {
      if (headers["x-access-token"] !== "envd-tok-1" || headers["e2b-sandbox-id"] !== "sbx1") return new Response("unauthorized", { status: 401 });
      return new Response('{"type":"stdout","text":"2\\n"}\n{"type":"number_of_executions","execution_count":1}\n', { headers: { "content-type": "application/x-ndjson" } });
    }
    return new Response("not found", { status: 404 });
  });
  await h.setup();
  pid = (await h.client().post("/projects", { name: "E2B 專案" })).body.id;
});
afterAll(() => h.teardown());
beforeEach(() => {
  h.script = [];
  h.llmBodies = [];
  hits.length = 0;
});

async function ask(body: Record<string, unknown>) {
  h.script = [textReply("ok")];
  const r = await h.chat({ content: "用 E2B 跑 print(1+1)", ...body });
  expect(lastEvent(r.events)).toMatchObject({ type: "done" });
  return r;
}

describe("allowed domain input", () => {
  it("normalizes URLs, trailing slashes, ports, case and Chinese separators; rejects junk with a clear message", () => {
    expect(normalizeDomains(["https://api.e2b.app", "api.e2b.app/", "HTTPS://API.E2B.APP/v2/sandboxes", "api.e2b.app:443", "api.e2b.app."])).toEqual(["api.e2b.app"]);
    expect(normalizeDomains("https://api.e2b.app/、*.e2b.app，sandbox.e2b.app；e2b.app")).toEqual(["api.e2b.app", "*.e2b.app", "sandbox.e2b.app", "e2b.app"]);
    expect(normalizeDomains(["https://*.e2b.app/"])).toEqual(["*.e2b.app"]);
    expect(() => normalizeDomains(["api_e2b.app"])).toThrow(/無效的網域：api_e2b\.app/);
    expect(() => normalizeDomains(["*"])).toThrow(/無效的網域/);
    expect(() => normalizeDomains(["*.app"])).toThrow(/太寬/);
    // the UI uses the same parser: errors are reported per entry instead of thrown
    expect(parseAllowedDomains("https://api.e2b.app/\nbad_host")).toEqual({ domains: ["api.e2b.app"], errors: [expect.stringContaining("bad_host")] });
  });

  it("the API stores the normalized form of what the user typed", async () => {
    const c = h.client();
    const r = await c.post("/secrets", { name: "E2B_API_KEY", value: KEY, allowedDomains: ["https://api.e2b.app/"] });
    expect(r.status).toBe(201);
    expect(r.body.secret.allowedDomains).toEqual(["api.e2b.app"]);
    secretId = r.body.secret.id;
    const bad = await c.req("PATCH", `/secrets/${secretId}`, { allowedDomains: ["https://api e2b_app"] });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toContain("無效的網域");
  });
});

describe("what the model is told about a saved secret", () => {
  it("normal mode, project and non-project: http_request offered and the secret plainly marked ready", async () => {
    for (const extra of [{}, { projectId: pid }]) {
      h.llmBodies = [];
      await ask({ ...extra, permissionMode: "normal" });
      expect(toolsOf()).toContain("http_request");
      const v = vaultOf();
      expect(v).toContain("E2B_API_KEY");
      expect(v).toContain("已設定，可以使用；只能送往 api.e2b.app");
      expect(v).toContain("{{secret:E2B_API_KEY}}");
      expect(v).toContain("不是環境變數");
      expect(v).not.toContain("無法使用 http_request");
      expect(JSON.stringify(h.llmBodies)).not.toContain(KEY);
    }
  });

  it("plan mode (conversation or project default) hides http_request and says so instead of leaving the model guessing", async () => {
    await ask({ projectId: pid, permissionMode: "plan" });
    expect(toolsOf()).not.toContain("http_request");
    expect(vaultOf()).toContain("本次對話目前無法使用 http_request");
    expect(vaultOf()).toContain("唯讀（Plan）");
    expect(vaultOf()).toContain("不要說成密鑰未同步");

    const c = h.client();
    await c.req("PATCH", `/projects/${pid}`, { permissionMode: "plan" });
    h.llmBodies = [];
    await ask({ projectId: pid }); // inherits the project's default
    expect(toolsOf()).not.toContain("http_request");
    expect(vaultOf()).toContain("唯讀（Plan）");
    await c.req("PATCH", `/projects/${pid}`, { permissionMode: null });

    await h.t.database.db.insert(settings).values({ key: "permission_mode", value: "plan" }).onConflictDoUpdate({ target: settings.key, set: { value: "plan" } });
    h.llmBodies = [];
    await ask({}); // non-project, global default
    expect(toolsOf()).not.toContain("http_request");
    expect(vaultOf()).toContain("唯讀（Plan）");
    await h.t.database.db.delete(settings).where(eq(settings.key, "permission_mode"));
  });

  it("a project tool list saved without http_request (stale list) is named as the reason", async () => {
    const c = h.client();
    const all = (await c.get("/tools")).body.map((t: any) => t.name) as string[];
    expect(all).toContain("http_request");
    await c.req("PATCH", `/projects/${pid}`, { enabledTools: all.filter((n) => n !== "http_request") });
    await ask({ projectId: pid, permissionMode: "full" });
    expect(toolsOf()).not.toContain("http_request");
    expect(vaultOf()).toContain("專案的「啟用的工具」沒有勾選 http_request");
    // other conversations are unaffected
    h.llmBodies = [];
    await ask({ permissionMode: "full" });
    expect(toolsOf()).toContain("http_request");
    expect(vaultOf()).not.toContain("無法使用 http_request");
    await c.req("PATCH", `/projects/${pid}`, { enabledTools: null });
    h.llmBodies = [];
    await ask({ projectId: pid, permissionMode: "full" });
    expect(toolsOf()).toContain("http_request");
  });

  it("an unconditional deny rule for http_request is named as the reason; a domain-scoped one is not", async () => {
    const db = h.t.database.db;
    const [p] = await db.insert(toolPolicies).values({ scope: "project", scopeId: pid, toolName: "http_request", action: "deny" }).returning();
    await ask({ projectId: pid, permissionMode: "normal" });
    expect(vaultOf()).toContain("權限規則禁止 http_request");
    await db.update(toolPolicies).set({ rule: { domains: ["evil.example.com"] } }).where(eq(toolPolicies.id, p.id));
    h.llmBodies = [];
    await ask({ projectId: pid, permissionMode: "normal" });
    expect(vaultOf()).not.toContain("無法使用 http_request");
    await db.delete(toolPolicies).where(eq(toolPolicies.id, p.id));
  });

  it("a secret without allowed domains is listed with the fix", async () => {
    const c = h.client();
    await c.req("PATCH", `/secrets/${secretId}`, { allowedDomains: [] });
    await ask({ projectId: pid, permissionMode: "normal" });
    expect(vaultOf()).toContain("E2B_API_KEY：值已存好，但尚未設定允許網域");
    expect(vaultOf()).toContain("設定 → 密鑰");
    await c.req("PATCH", `/secrets/${secretId}`, { allowedDomains: ["api.e2b.app"] });
  });

  it("a secret added after the conversation started is visible on the next turn", async () => {
    const c = h.client();
    await c.req("DELETE", `/secrets/${secretId}`);
    const r1 = await ask({ projectId: pid, permissionMode: "normal" });
    expect(sysOf()).not.toContain("# 密鑰");
    const created = await c.post("/secrets", { name: "E2B_API_KEY", value: KEY, allowedDomains: ["api.e2b.app"] });
    secretId = created.body.secret.id;
    h.llmBodies = [];
    h.script = [textReply("ok")];
    await h.chat({ conversationId: convOf(r1.events), content: "我已經新增 E2B_API_KEY 了" });
    expect(vaultOf()).toContain("E2B_API_KEY：已設定，可以使用");
  });
});

describe("e2b-sandbox flow vs allowed domains", () => {
  it("skill guidance matches hostAllowed: key only on api.e2b.app, execute on sandbox.e2b.app with the per-sandbox token", async () => {
    resetBuiltinSkillsMemo(h.t.database);
    h.script = [
      callsReply([{ id: "k1", name: "skill_load", args: { name: "e2b-sandbox" } }]),
      callsReply([{ id: "c1", name: "http_request", args: { method: "POST", url: "https://api.e2b.app/v2/sandboxes", headers: { "X-API-Key": "{{secret:E2B_API_KEY}}" }, body: { templateID: "code-interpreter-v1", timeout: 300 } } }]),
      callsReply([{ id: "x1", name: "http_request", args: { method: "POST", url: "https://sandbox.e2b.app/execute", headers: { "E2b-Sandbox-Id": "sbx1", "E2b-Sandbox-Port": "49999", "X-Access-Token": "envd-tok-1" }, body: { code: "print(1+1)", language: "python" } } }]),
      callsReply([
        { id: "d1", name: "http_request", args: { method: "DELETE", url: "https://api.e2b.app/sandboxes/sbx1", headers: { "X-API-Key": "{{secret:E2B_API_KEY}}" } } },
        { id: "w1", name: "http_request", args: { method: "POST", url: "https://sandbox.e2b.app/execute", headers: { "X-API-Key": "{{secret:E2B_API_KEY}}" } } },
      ]),
      textReply("結果是 2"),
    ];
    const r = await h.chat({ content: "用 E2B 跑 print(1+1)", projectId: pid, permissionMode: "full" });
    expect(lastEvent(r.events)).toMatchObject({ status: "completed" });
    const [skill] = toolResults(h.llmBodies[1]);
    expect(skill.instructions).toContain("允許網域填 `api.e2b.app`");
    expect(skill.instructions).toContain("不需要密鑰");
    expect(skill.instructions).toContain("目前無法使用 http_request");
    expect(skill.instructions).toContain("密鑰不是環境變數");
    expect(toolResults(h.llmBodies[2])[0]).toMatchObject({ status: 201 });
    const exec = toolResults(h.llmBodies[3])[0];
    expect(exec.status).toBe(200);
    expect(exec.body).toContain('"stdout"');
    const [del, wrong] = toolResults(h.llmBodies[4]);
    expect(del).toMatchObject({ status: 204 });
    expect(wrong).toContain("不允許送往 sandbox.e2b.app"); // the key never leaves api.e2b.app
    expect(hits.filter((x) => x.headers["x-api-key"]).map((x) => x.host)).toEqual(["api.e2b.app", "api.e2b.app"]);
    expect(JSON.stringify(h.llmBodies)).not.toContain(KEY);
  });

  it("an apex domain (e2b.app) does not cover api.e2b.app, and the error says how to fix it", async () => {
    const c = h.client();
    await c.req("PATCH", `/secrets/${secretId}`, { allowedDomains: ["e2b.app"] });
    h.script = [
      callsReply([{ id: "a1", name: "http_request", args: { method: "POST", url: "https://api.e2b.app/v2/sandboxes", headers: { "X-API-Key": "{{secret:E2B_API_KEY}}" }, body: { templateID: "base" } } }]),
      textReply("ok"),
    ];
    await h.chat({ content: "建立沙盒", permissionMode: "full" });
    const [err] = toolResults(h.llmBodies[1]);
    expect(err).toContain("不允許送往 api.e2b.app");
    expect(err).toContain("*.e2b.app");
    expect(hits).toHaveLength(0);
    await c.req("PATCH", `/secrets/${secretId}`, { allowedDomains: ["api.e2b.app"] });
  });

  it("an untouched v1 e2b-sandbox skill is upgraded in place (same id, so project skill lists keep it)", async () => {
    const db = h.t.database.db;
    const before = (await h.client().get("/skills")).body.find((s: any) => s.name === "e2b-sandbox");
    await db.update(settings).set({ value: { "e2b-sandbox": { version: 1 }, "self-hosted-runner": { version: 1 } } }).where(eq(settings.key, "builtin_skills"));
    resetBuiltinSkillsMemo(h.t.database);
    h.script = [callsReply([{ id: "s1", name: "skill_load", args: { name: "e2b-sandbox" } }]), textReply("ok")];
    await h.chat({ content: "e2b", permissionMode: "normal" });
    const [skill] = toolResults(h.llmBodies[1]);
    expect(skill.instructions).toContain("密鑰不是環境變數");
    const after = (await h.client().get("/skills")).body.find((s: any) => s.name === "e2b-sandbox");
    expect(after.id).toBe(before.id);
  });
});
