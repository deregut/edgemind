import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditLogs, files, messages, runSteps, secrets, skills, toolApprovals } from "../src/db/schema";
import { decryptSecret } from "../src/lib/crypto";
import { hostAllowed, makeRedactor, normalizeDomains } from "../src/secrets";
import { resetBuiltinSkillsMemo } from "../src/skills/builtin";
import { Harness, callsReply, lastEvent, runIdOf, textReply } from "./harness";
import { S3Mock } from "./s3-mock";

const s3 = new S3Mock();
const h = new Harness({ deps: { s3Fetch: s3.fetch } });
const VALUE = "sk-live-SUPER-secret-9f8e7d6c";
const dns: Record<string, string[]> = { "api.example.com": ["93.184.216.34"], "other.example.org": ["93.184.216.35"], "cdn.example.com": ["93.184.216.36"], "internal.example.com": ["10.1.2.3"] };
const hits: { url: string; headers: Record<string, string>; body: string | null }[] = [];

const trailingTools = (body: any) => {
  const out: any[] = [];
  for (let i = body.messages.length - 1; i >= 0 && body.messages[i].role === "tool"; i--) out.unshift(body.messages[i]);
  return out;
};
const toolMsgs = (body: any) => trailingTools(body).map((m: any) => { try { return JSON.parse(m.content); } catch { return m.content; } });

beforeAll(async () => {
  h.routes.push((url) => {
    if (url.hostname !== "cloudflare-dns.com") return undefined;
    const name = url.searchParams.get("name")!;
    const type = url.searchParams.get("type");
    const ips = (dns[name] ?? []).filter((ip) => (type === "A" ? !ip.includes(":") : ip.includes(":")));
    return Response.json({ Status: 0, Answer: ips.map((ip) => ({ name, type: type === "A" ? 1 : 28, data: ip })) });
  });
  h.routes.push(async (url, init) => {
    if (!["api.example.com", "other.example.org", "cdn.example.com"].includes(url.hostname)) return undefined;
    const headers = Object.fromEntries(new Headers(init.headers as HeadersInit).entries());
    const body = init.body === undefined ? null : typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body as Uint8Array);
    hits.push({ url: url.toString(), headers, body });
    if (url.pathname === "/echo") {
      // A misbehaving API that reflects the credential back (must be redacted before the model sees it).
      return Response.json({ youSent: headers.authorization, query: url.searchParams.get("k"), body: body ? JSON.parse(body) : null }, { headers: { "x-request-id": "r-1", "set-cookie": "a=b", "x-ratelimit-remaining": "9" } });
    }
    if (url.pathname === "/big") return new Response("z".repeat(50_000), { headers: { "content-type": "text/plain" } });
    if (url.pathname === "/redirect-out") return new Response(null, { status: 302, headers: { location: "https://other.example.org/steal" } });
    if (url.pathname === "/redirect-in") return new Response(null, { status: 302, headers: { location: "https://api.example.com/echo" } });
    if (url.pathname === "/file") return new Response(new Uint8Array([137, 80, 78, 71, 1, 2, 3]), { headers: { "content-type": "image/png" } });
    if (url.pathname === "/fail") return Response.json({ error: `bad key ${headers["x-api-key"]}` }, { status: 401 });
    return new Response("ok");
  });
  await h.setup();
});
afterAll(() => h.teardown());
beforeEach(() => {
  h.script = [];
  h.llmBodies = [];
  hits.length = 0;
});

describe("secrets vault", () => {
  it("domain patterns and redaction helpers", () => {
    expect(normalizeDomains(["API.e2b.app", "https://x.com/path", "*.E2B.app", " "])).toEqual(["api.e2b.app", "x.com", "*.e2b.app"]);
    expect(() => normalizeDomains(["*"])).toThrow();
    expect(() => normalizeDomains(["*.com"])).toThrow();
    expect(() => normalizeDomains(["bad host"])).toThrow();
    expect(hostAllowed("api.e2b.app", ["*.e2b.app"])).toBe(true);
    expect(hostAllowed("49999-abc.e2b.app", ["*.e2b.app"])).toBe(true);
    expect(hostAllowed("e2b.app", ["*.e2b.app"])).toBe(false);
    expect(hostAllowed("evil-e2b.app", ["*.e2b.app"])).toBe(false);
    expect(hostAllowed("api.e2b.app.evil.com", ["api.e2b.app"])).toBe(false);
    const red = makeRedactor([{ name: "K", value: "abc+/=def" }]);
    expect(red(`x abc+/=def y ${encodeURIComponent("abc+/=def")} ${btoa("abc+/=def")}`)).toBe("x [已遮蔽:K] y [已遮蔽:K] [已遮蔽:K]");
  });

  it("CRUD: values are write-only and AES-GCM encrypted with an id-bound AAD", async () => {
    const c = h.client();
    const bad = await c.post("/secrets", { name: "1BAD", value: "xxxxxx", allowedDomains: [] });
    expect(bad.status).toBe(400);
    expect((await c.post("/secrets", { name: "OK_NAME", value: "abc", allowedDomains: [] })).status).toBe(400); // too short
    const created = await c.post("/secrets", { name: "API_KEY", value: VALUE, allowedDomains: ["api.example.com", "*.example.com"], description: "測試 API" });
    expect(created.status).toBe(201);
    expect(created.body.secret).toMatchObject({ name: "API_KEY", allowedDomains: ["api.example.com", "*.example.com"], description: "測試 API" });
    expect(JSON.stringify(created.body)).not.toContain(VALUE);
    expect(created.body.secret.preview).not.toBe(VALUE);
    expect((await c.post("/secrets", { name: "API_KEY", value: "other-value", allowedDomains: [] })).status).toBe(400);

    const [row] = await h.t.database.db.select().from(secrets).where(eq(secrets.name, "API_KEY"));
    expect(row.valueEnc).not.toContain(VALUE);
    expect(await decryptSecret(row.valueEnc, Buffer.from(h.env.ENCRYPTION_KEY, "base64"), `secret:${row.id}`)).toBe(VALUE);
    await expect(decryptSecret(row.valueEnc, Buffer.from(h.env.ENCRYPTION_KEY, "base64"), "secret:other")).rejects.toThrow();

    const tmp = await c.post("/secrets", { name: "TEMP", value: "temp-value-1", allowedDomains: "a.example.com, b.example.com" });
    const id = tmp.body.secret.id;
    const up = await c.req("PATCH", `/secrets/${id}`, { name: "TEMP2", allowedDomains: ["c.example.com"], value: "" });
    expect(up.body.secret).toMatchObject({ name: "TEMP2", allowedDomains: ["c.example.com"] });
    const [t2] = await h.t.database.db.select().from(secrets).where(eq(secrets.id, id));
    expect(await decryptSecret(t2.valueEnc, Buffer.from(h.env.ENCRYPTION_KEY, "base64"), `secret:${id}`)).toBe("temp-value-1"); // empty value = keep
    await c.req("PATCH", `/secrets/${id}`, { value: "temp-value-2" });
    const [t3] = await h.t.database.db.select().from(secrets).where(eq(secrets.id, id));
    expect(await decryptSecret(t3.valueEnc, Buffer.from(h.env.ENCRYPTION_KEY, "base64"), `secret:${id}`)).toBe("temp-value-2");
    const list = await c.get("/secrets");
    expect(list.body.secrets.map((s: any) => s.name)).toEqual(["API_KEY", "TEMP2"]);
    expect(JSON.stringify(list.body)).not.toMatch(/temp-value|SUPER-secret/);
    expect((await c.req("DELETE", `/secrets/${id}`)).status).toBe(200);
    expect((await c.req("DELETE", `/secrets/${id}`)).status).toBe(404);
    expect(JSON.stringify(await h.t.database.db.select().from(auditLogs))).not.toContain(VALUE);
  });
});

describe("http_request", () => {
  it("injects secrets server-side, redacts them from the response, run_steps, messages and audit logs; names in the system prompt", async () => {
    h.script = [
      callsReply([{
        id: "h1", name: "http_request",
        args: { method: "POST", url: "https://api.example.com/echo", headers: { Authorization: "Bearer {{secret:API_KEY}}" }, query: { k: "{{ secret:API_KEY }}" }, body: { token: "{{secret:API_KEY}}", n: 1 } },
      }]),
      textReply("完成"),
    ];
    const r = await h.chat({ content: "呼叫 API", permissionMode: "full" });
    expect(lastEvent(r.events)).toMatchObject({ status: "completed" });
    // the provider really got the value
    expect(hits[0].headers.authorization).toBe(`Bearer ${VALUE}`);
    expect(new URL(hits[0].url).searchParams.get("k")).toBe(VALUE);
    expect(JSON.parse(hits[0].body!)).toEqual({ token: VALUE, n: 1 });
    // the model never did
    const sys = h.llmBodies[0].messages[0].content as string;
    expect(sys).toContain("API_KEY");
    expect(sys).toContain("api.example.com");
    expect(JSON.stringify(h.llmBodies)).not.toContain(VALUE);
    const res = toolMsgs(h.llmBodies[1])[0];
    expect(res).toMatchObject({ status: 200, headers: { "x-request-id": "r-1", "x-ratelimit-remaining": "9" } });
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(res.url).toBe("https://api.example.com/echo?k=[已遮蔽:API_KEY]");
    expect(JSON.parse(res.body)).toEqual({ youSent: "Bearer [已遮蔽:API_KEY]", query: "[已遮蔽:API_KEY]", body: { token: "[已遮蔽:API_KEY]", n: 1 } });
    const runId = runIdOf(r.events);
    const db = h.t.database.db;
    expect(JSON.stringify(await db.select().from(runSteps).where(eq(runSteps.runId, runId)))).not.toContain(VALUE);
    expect(JSON.stringify(await db.select().from(messages))).not.toContain(VALUE);
    expect(JSON.stringify(await db.select().from(auditLogs))).not.toContain(VALUE);
  });

  it("refuses hosts outside the secret's allowed domains, private addresses, unknown secrets; keeps secrets off redirects", async () => {
    h.script = [
      callsReply([
        { id: "d1", name: "http_request", args: { url: "https://other.example.org/x", headers: { "X-Api-Key": "{{secret:API_KEY}}" } } },
        { id: "d2", name: "http_request", args: { url: "http://10.0.0.1/admin" } },
        { id: "d3", name: "http_request", args: { url: "https://internal.example.com/" } },
        { id: "d4", name: "http_request", args: { url: "https://api.example.com/x", headers: { A: "{{secret:NOPE}}" } } },
        { id: "d5", name: "http_request", args: { url: "https://{{secret:API_KEY}}.example.com/" } },
        { id: "d6", name: "http_request", args: { url: "https://api.example.com/redirect-out", headers: { "X-Api-Key": "{{secret:API_KEY}}" } } },
        { id: "d7", name: "http_request", args: { url: "https://cdn.example.com/redirect-in", headers: { Authorization: "Bearer {{secret:API_KEY}}" } } },
        { id: "d8", name: "http_request", args: { url: "https://api.example.com/fail", headers: { "x-api-key": "{{secret:API_KEY}}" } } },
      ]),
      textReply("ok"),
    ];
    await h.chat({ content: "試試", permissionMode: "full" });
    const [d1, d2, d3, d4, d5, d6, d7, d8] = toolMsgs(h.llmBodies[1]);
    expect(d1).toContain("不允許送往 other.example.org");
    expect(d2).toContain("已封鎖");
    expect(d3).toContain("已封鎖");
    expect(d4).toContain("找不到密鑰：NOPE");
    expect(d5).toContain("主機名稱");
    expect(d6).toMatchObject({ status: 302, headers: { location: "https://other.example.org/steal" } }); // not followed
    expect(d7).toMatchObject({ status: 200, redirects: ["https://api.example.com/echo"] }); // same allowed domain: followed
    expect(JSON.parse(d7.body).youSent).toBe("Bearer [已遮蔽:API_KEY]");
    expect(d8).toMatchObject({ status: 401 });
    expect(d8.body).toContain("[已遮蔽:API_KEY]");
    expect(hits.map((x) => new URL(x.url).hostname)).not.toContain("other.example.org");
    expect(JSON.stringify(h.llmBodies)).not.toContain(VALUE);
  });

  it("a secret can hold a whole base URL at the start of the url (self-hosted runners)", async () => {
    await h.client().post("/secrets", { name: "PISTON_URL", value: "https://cdn.example.com/", allowedDomains: ["cdn.example.com"] });
    h.script = [
      callsReply([
        { id: "u1", name: "http_request", args: { method: "POST", url: "{{secret:PISTON_URL}}/echo", body: { language: "python" } } },
        { id: "u2", name: "http_request", args: { url: "https://api.example.com/{{secret:PISTON_URL}}" } },
      ]),
      textReply("ok"),
    ];
    await h.chat({ content: "piston", permissionMode: "full" });
    const [u1, u2] = toolMsgs(h.llmBodies[1]);
    expect(hits[0].url).toBe("https://cdn.example.com/echo");
    expect(u1.status).toBe(200);
    expect(u1.url).toMatch(/^\[已遮蔽:PISTON_URL\]\/?echo$/);
    expect(u2).toContain("不允許送往 api.example.com");
  });

  it("caps long bodies, describes binary ones, saves / uploads project files", async () => {
    const pid = (await h.client().post("/projects", { name: "HTTP 專案" })).body.id;
    h.script = [
      callsReply([
        { id: "b1", name: "http_request", args: { url: "https://api.example.com/big" } },
        { id: "b2", name: "http_request", args: { url: "https://api.example.com/file" } },
        { id: "b3", name: "http_request", args: { url: "https://api.example.com/file", saveResponseTo: "downloads/a.png" } },
        { id: "b4", name: "http_request", args: { url: "https://api.example.com/echo", headers: { Authorization: "{{secret:API_KEY}}" }, saveResponseTo: "downloads/echo.json" } },
      ]),
      callsReply([{ id: "b5", name: "http_request", args: { method: "POST", url: "https://api.example.com/upload", bodyFromFile: "downloads/a.png" } }]),
      textReply("ok"),
    ];
    await h.chat({ content: "下載", projectId: pid, permissionMode: "full" });
    const [b1, b2, b3, b4] = toolMsgs(h.llmBodies[1]);
    expect(b1.truncated).toBe(true);
    expect(b1.body.length).toBeLessThan(20_100);
    expect(b2).toMatchObject({ body: null, binary: { bytes: 7, contentType: "image/png" } });
    expect(b3.savedTo).toMatchObject({ path: "downloads/a.png", size: 7 });
    const [png] = await h.t.database.db.select().from(files).where(and(eq(files.projectId, pid), eq(files.path, "downloads/a.png")));
    expect([...s3.objects.get(png.s3Key)!.body]).toEqual([137, 80, 78, 71, 1, 2, 3]);
    const [echo] = await h.t.database.db.select().from(files).where(and(eq(files.projectId, pid), eq(files.path, "downloads/echo.json")));
    const saved = new TextDecoder().decode(s3.objects.get(echo.s3Key)!.body);
    expect(saved).toContain("[已遮蔽:API_KEY]");
    expect(saved).not.toContain(VALUE);
    expect(b4.savedTo.path).toBe("downloads/echo.json");
    const up = hits.find((x) => x.url.endsWith("/upload"))!;
    expect(up.headers["content-type"]).toBe("image/png");
  });

  it("is dangerous: asks in the default mode; domain policies see the target host", async () => {
    h.script = [callsReply([{ id: "p1", name: "http_request", args: { url: "https://api.example.com/x" } }])];
    const r = await h.chat({ content: "x" });
    const ap = (r.events.find((e) => e.type === "approval-required") as any).approvals[0];
    expect(ap).toMatchObject({ toolName: "http_request", risk: "dangerous" });
    await h.client().post(`/runs/${runIdOf(r.events)}/stop`, {});
    const [row] = await h.t.database.db.select().from(toolApprovals).where(eq(toolApprovals.toolCallId, "p1"));
    expect(row.status).toBe("denied");
  });
});

describe("bundled skills", () => {
  it("e2b-sandbox and self-hosted-runner are installed, loadable, can be disabled, and stay deleted", async () => {
    const c = h.client();
    const list = await c.get("/skills");
    const names = list.body.map((s: any) => s.name);
    expect(names).toEqual(expect.arrayContaining(["e2b-sandbox", "self-hosted-runner"]));
    expect(list.body.find((s: any) => s.name === "e2b-sandbox").source).toBe("builtin");

    h.script = [
      callsReply([
        { id: "s1", name: "skill_load", args: { name: "e2b-sandbox" } },
        { id: "s2", name: "skill_load", args: { name: "e2b-sandbox", path: "references/api.md" } },
        { id: "s3", name: "skill_load", args: { name: "self-hosted-runner" } },
      ]),
      textReply("ok"),
    ];
    await h.chat({ content: "用 E2B 跑 Python" });
    const sys = h.llmBodies[0].messages[0].content as string;
    expect(sys).toContain("e2b-sandbox");
    expect(sys).toContain("self-hosted-runner");
    const [e2b, api, runner] = toolMsgs(h.llmBodies[1]);
    expect(e2b.instructions).toContain("https://api.e2b.app/v2/sandboxes");
    expect(e2b.instructions).toContain("{{secret:E2B_API_KEY}}");
    expect(e2b.instructions).toContain("DELETE https://api.e2b.app/sandboxes/");
    expect(e2b.note).toContain("code_run");
    expect(e2b.files.map((f: any) => f.path)).toEqual(["references/api.md"]);
    expect(api.content).toContain("POST /execute");
    expect(runner.instructions).toContain("/api/v2/execute");
    expect(runner.instructions).toContain("/submissions?base64_encoded=false&wait=true");
    expect(runner.instructions).toContain("2026-02-15");

    const id = list.body.find((s: any) => s.name === "self-hosted-runner").id;
    expect((await c.req("PATCH", `/skills/${id}`, { enabled: false })).body.enabled).toBe(false);
    h.llmBodies = [];
    h.script = [textReply("ok")];
    await h.chat({ content: "hi" });
    expect(h.llmBodies[0].messages[0].content).not.toContain("self-hosted-runner");

    expect((await c.req("DELETE", `/skills/${id}`)).status).toBe(200);
    resetBuiltinSkillsMemo(h.t.database);
    const after = await c.get("/skills");
    expect(after.body.map((s: any) => s.name)).not.toContain("self-hosted-runner");
    expect(await h.t.database.db.select().from(skills).where(eq(skills.name, "e2b-sandbox"))).toHaveLength(1);
  });
});
