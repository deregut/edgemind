import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { mcpServers } from "../src/db/schema";
import { canonicalResource, parseResourceMetadataUrl } from "../src/mcp/oauth";
import { defaultRisk, mcpToolName } from "../src/mcp/service";
import { toolResultText } from "../src/mcp/client";
import { Harness, callsReply, textReply } from "./harness";
import { McpMock } from "./mcp-mock";
import { S3Mock } from "./s3-mock";

const s3 = new S3Mock();
const h = new Harness({ deps: { s3Fetch: s3.fetch } });

const toolMsgs = (body: any) => {
  const out: any[] = [];
  for (let i = body.messages.length - 1; i >= 0 && body.messages[i].role === "tool"; i--) out.unshift(body.messages[i].content);
  return out;
};

function demoTools(m: McpMock) {
  m.tools = [
    {
      name: "add", description: "兩數相加", annotations: { readOnlyHint: true },
      inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
      handler: (a) => ({ content: [{ type: "text", text: String(a.a + a.b) }] }),
    },
    { name: "send.email", description: "寄信", handler: () => ({ content: [{ type: "text", text: "sent" }] }) },
    { name: "fail", annotations: { readOnlyHint: true }, handler: () => ({ isError: true, content: [{ type: "text", text: "壞掉了" }] }) },
  ];
}

beforeAll(async () => {
  await h.setup();
});
afterAll(() => h.teardown());
beforeEach(() => {
  h.script = [];
  h.llmBodies = [];
  h.routes = [];
});

describe("MCP helpers", () => {
  it("names, risks, result flattening, OAuth helpers", () => {
    expect(mcpToolName("github", "create_issue")).toBe("mcp__github__create_issue");
    const odd = mcpToolName("srv", "send.email");
    expect(odd).toMatch(/^mcp__srv__send_email_[a-z0-9]+$/);
    expect(mcpToolName("srv", "x".repeat(100)).length).toBeLessThanOrEqual(64);
    expect(defaultRisk({ readOnlyHint: true })).toBe("read");
    expect(defaultRisk({ destructiveHint: false, openWorldHint: false })).toBe("write");
    expect(defaultRisk(null)).toBe("external");
    expect(toolResultText({ content: [{ type: "text", text: "a" }, { type: "image", mimeType: "image/png", data: "x" }, { type: "resource", resource: { uri: "u", text: "t" } }] }).text).toBe("a\n\n[image: image/png，已省略]\n\n[資源 u]\nt");
    expect(toolResultText({ content: [], structuredContent: { x: 1 } }).text).toBe('{"x":1}');
    expect(canonicalResource("https://MCP.Example.com/mcp/")).toBe("https://mcp.example.com/mcp");
    expect(canonicalResource("https://a.com/")).toBe("https://a.com");
    expect(parseResourceMetadataUrl('Bearer error="x", resource_metadata="https://a/.well-known/oauth-protected-resource"')).toBe("https://a/.well-known/oauth-protected-resource");
  });
});

describe("MCP servers API", () => {
  it("Streamable HTTP: create → sync tools (pagination, JSON and SSE replies) → session reuse → expired session re-init → edit risk/enable", async () => {
    const m = new McpMock("https://mcp.demo.test");
    demoTools(m);
    m.pageSize = 2;
    h.routes.push(m.route);
    const c = h.client();
    expect((await c.post("/mcp/servers", { name: "x", url: "file:///etc" })).status).toBe(400);
    expect((await c.post("/mcp/servers", { name: "x", url: "https://a.test", authType: "headers", headers: { Host: "evil" } })).status).toBe(400);
    const r = await c.post("/mcp/servers", { name: "Demo Server", url: "https://mcp.demo.test/mcp", authType: "headers", headers: { "X-Api-Key": "k-123" } });
    expect(r.status).toBe(201);
    expect(r.body.error).toBeUndefined();
    expect(r.body.server).toMatchObject({ name: "Demo Server", toolPrefix: "demo_server", authStatus: "configured", headerNames: ["X-Api-Key"], toolCount: 3, instructions: "Mock server" });
    expect(JSON.stringify(r.body.server)).not.toContain("k-123");
    expect(r.body.tools.map((t: any) => [t.name, t.riskLevel])).toEqual([["add", "read"], ["fail", "read"], ["send.email", "external"]]);
    expect(m.calls.filter((x) => x.method === "tools/list")).toHaveLength(2);
    const sid = r.body.server.id;
    const [row] = await h.t.database.db.select().from(mcpServers).where(eq(mcpServers.id, sid));
    expect(row.sessionId).toBe("s1");
    expect(row.authEnc).not.toContain("k-123");

    // second sync over SSE replies reuses no session (initialize starts a new one) and keeps user choices
    const add = r.body.tools.find((t: any) => t.name === "add");
    const email = r.body.tools.find((t: any) => t.name === "send.email");
    expect((await c.req("PATCH", `/mcp/tools/${email.id}`, { riskLevel: "dangerous" })).body).toMatchObject({ riskLevel: "dangerous", riskCustomized: true });
    await c.req("PATCH", `/mcp/tools/${add.id}`, { enabled: false });
    m.replyAs = "sse";
    m.tools.pop(); // "fail" removed upstream
    const s = await c.post(`/mcp/servers/${sid}/sync`);
    expect(s.body).toMatchObject({ removed: 1, added: 0 });
    expect(s.body.tools.map((t: any) => [t.name, t.enabled, t.riskLevel])).toEqual([["add", false, "read"], ["send.email", true, "dangerous"]]);
    expect(m.calls.every((x) => x.method === "initialize" || x.session)).toBe(true);
    expect(m.calls.filter((x) => x.method !== "initialize").every((x) => x.auth === null)).toBe(true);

    // tool listing for the project tools UI includes MCP tools
    const tools = await c.get("/tools");
    expect(tools.body.map((t: any) => t.name)).toContain(mcpToolName("demo_server", "send.email"));
    expect(tools.body.map((t: any) => t.name)).not.toContain("mcp__demo_server__add"); // disabled
    await c.req("DELETE", `/mcp/servers/${sid}`);
  });

  it("legacy HTTP+SSE transport", async () => {
    const m = new McpMock("https://legacy.test");
    demoTools(m);
    h.routes.push(m.legacyRoute);
    const c = h.client();
    const r = await c.post("/mcp/servers", { name: "Legacy", url: "https://legacy.test/sse", transport: "sse" });
    expect(r.body.error).toBeUndefined();
    expect(r.body.tools).toHaveLength(3);
    expect(m.calls.map((x) => x.method)).toEqual(["initialize", "notifications/initialized", "tools/list"]);
    await c.req("DELETE", `/mcp/servers/${r.body.server.id}`);
  });

  it("OAuth 2.1: 401 → PRM + AS discovery → dynamic registration → PKCE authorize → callback → tokens → refresh", async () => {
    const m = new McpMock("https://secure.test");
    demoTools(m);
    m.requireBearer = "at-1";
    let registered: any = null;
    const tokenForms: URLSearchParams[] = [];
    h.routes.push(m.route, (url, init) => {
      if (url.href === "https://secure.test/.well-known/oauth-protected-resource/mcp")
        return Response.json({ resource: "https://secure.test/mcp", authorization_servers: ["https://auth.test"], scopes_supported: ["tools:read"] });
      if (url.href === "https://auth.test/.well-known/oauth-authorization-server")
        return Response.json({ issuer: "https://auth.test", authorization_endpoint: "https://auth.test/authorize", token_endpoint: "https://auth.test/token", registration_endpoint: "https://auth.test/register", code_challenge_methods_supported: ["S256"] });
      if (url.href === "https://auth.test/register") {
        registered = JSON.parse(String(init.body));
        return Response.json({ client_id: "cid-1" }, { status: 201 });
      }
      if (url.href === "https://auth.test/token") {
        const f = new URLSearchParams(String(init.body));
        tokenForms.push(f);
        if (f.get("grant_type") === "authorization_code") return Response.json({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, token_type: "Bearer" });
        return Response.json({ access_token: "at-2", expires_in: 3600, token_type: "Bearer" });
      }
      return undefined;
    });
    const c = h.client();
    const r = await c.post("/mcp/servers", { name: "Secure", url: "https://secure.test/mcp", authType: "oauth" });
    expect(r.body).toMatchObject({ needsAuth: true, server: { authStatus: "needs_auth" } });
    const sid = r.body.server.id;

    const start = await c.post(`/mcp/servers/${sid}/oauth/start`);
    expect(start.status).toBe(200);
    const au = new URL(start.body.authorizeUrl);
    expect(au.origin + au.pathname).toBe("https://auth.test/authorize");
    expect(Object.fromEntries(au.searchParams)).toMatchObject({
      response_type: "code", client_id: "cid-1", redirect_uri: "http://localhost/api/mcp/oauth/callback", code_challenge_method: "S256", resource: "https://secure.test/mcp", scope: "tools:read",
    });
    expect(registered).toMatchObject({ redirect_uris: ["http://localhost/api/mcp/oauth/callback"], token_endpoint_auth_method: "none" });

    // the callback is reachable without the session cookie (cross-site redirect), guarded by single-use state
    const anon = h.client();
    anon.cookies = new Map();
    const bad = await anon.get(`/mcp/oauth/callback?code=x&state=${"z".repeat(32)}`);
    expect(bad.status).toBe(302);
    expect(bad.headers.get("location")).toMatch(/oauth=error/);
    const cb = await anon.get(`/mcp/oauth/callback?code=the-code&state=${au.searchParams.get("state")}`);
    expect(cb.headers.get("location")).toBe("/settings?tab=mcp&oauth=ok");
    const form = tokenForms[0];
    expect(Object.fromEntries(form)).toMatchObject({ grant_type: "authorization_code", code: "the-code", client_id: "cid-1", resource: "https://secure.test/mcp", redirect_uri: "http://localhost/api/mcp/oauth/callback" });
    expect(form.get("code_verifier")!.length).toBeGreaterThanOrEqual(43);
    expect((await anon.get(`/mcp/oauth/callback?code=again&state=${au.searchParams.get("state")}`)).headers.get("location")).toMatch(/oauth=error/); // replay

    const list = (await c.get("/mcp/servers")).body.find((s: any) => s.id === sid);
    expect(list).toMatchObject({ authStatus: "authorized", toolCount: 3, oauthClientId: "cid-1", lastError: null });
    expect(m.calls.filter((x) => x.method === "tools/list").every((x) => x.auth === "Bearer at-1")).toBe(true);

    // server revokes at-1 → 401 → refresh with rt-1 → retry with at-2
    m.requireBearer = "at-2";
    await c.req("PUT", "/permissions/mode", { scope: "global", mode: "full" });
    h.script = [callsReply([{ id: "a1", name: "mcp__secure__add", args: { a: 2, b: 3 } }]), textReply("5")];
    await h.chat({ content: "2+3" });
    expect(toolMsgs(h.llmBodies[1])).toEqual(["5"]);
    expect(Object.fromEntries(tokenForms[1])).toMatchObject({ grant_type: "refresh_token", refresh_token: "rt-1", client_id: "cid-1" });

    // logout forgets tokens
    const out = await c.post(`/mcp/servers/${sid}/oauth/logout`);
    expect(out.body.authStatus).toBe("needs_auth");
    await c.req("PUT", "/permissions/mode", { scope: "global", mode: "normal" });
    await c.req("DELETE", `/mcp/servers/${sid}`);
  });
});

describe("MCP tools in the agent loop", () => {
  it("risk levels drive approvals; errors come back as tool errors; project allow-list filters servers", async () => {
    const m = new McpMock("https://loop.test");
    demoTools(m);
    h.routes.push(m.route);
    const c = h.client();
    await c.req("PUT", "/permissions/mode", { scope: "global", mode: "normal" });
    const srv = (await c.post("/mcp/servers", { name: "loop", url: "https://loop.test/mcp" })).body.server;
    const emailName = mcpToolName("loop", "send.email");

    h.script = [
      callsReply([{ id: "c1", name: "mcp__loop__add", args: { a: 1, b: 41 } }, { id: "c2", name: "mcp__loop__fail", args: {} }, { id: "c3", name: emailName, args: { to: "a@b.c" } }]),
      textReply("done"),
    ];
    const r = await h.chat({ content: "go" });
    const defs = h.llmBodies[0].tools.map((t: any) => t.function.name);
    expect(defs).toEqual(expect.arrayContaining(["mcp__loop__add", "mcp__loop__fail", emailName]));
    expect(h.llmBodies[0].tools.find((t: any) => t.function.name === "mcp__loop__add").function.description).toBe("[MCP: loop] 兩數相加");
    const appr = r.events.find((e) => e.type === "approval-required") as any;
    expect(appr.approvals).toEqual([expect.objectContaining({ toolName: emailName, risk: "external" })]);
    const results = r.events.filter((e) => e.type === "tool-result") as any[];
    expect(results.find((e) => e.callId === "c1").result).toBe("42");
    expect(results.find((e) => e.callId === "c2")).toMatchObject({ isError: true });
    expect(JSON.stringify(results.find((e) => e.callId === "c2").result)).toContain("壞掉了");
    // pending approval visible through the messages endpoint with its MCP risk
    const runId = (r.events.find((e) => e.type === "run") as any).runId;
    const dec = await c.post(`/runs/${runId}/approvals`, { toolCallId: "c3", decision: "deny" });
    expect(dec.status).toBeLessThan(300);

    // the stored session expires upstream → 404 → transparent re-initialize
    m.sessions.clear();
    const inits = m.calls.filter((x) => x.method === "initialize").length;
    h.llmBodies = [];
    h.script = [callsReply([{ id: "r1", name: "mcp__loop__add", args: { a: 1, b: 1 } }]), textReply("2")];
    await h.chat({ content: "again" });
    expect(toolMsgs(h.llmBodies[1])).toEqual(["2"]);
    expect(m.calls.filter((x) => x.method === "initialize").length).toBe(inits + 1);

    // plan mode only offers read MCP tools
    const conv = (r.events.find((e) => e.type === "run") as any).conversationId;
    await c.req("PATCH", `/conversations/${conv}`, { permissionMode: "plan" });
    h.llmBodies = [];
    h.script = [textReply("ok")];
    await h.chat({ content: "plan", conversationId: conv });
    const planDefs = h.llmBodies[0].tools.map((t: any) => t.function.name);
    expect(planDefs).toContain("mcp__loop__add");
    expect(planDefs).not.toContain(emailName);

    // project that allows no MCP servers
    const pid = (await c.post("/projects", { name: "no-mcp" })).body.id;
    expect((await c.req("PATCH", `/projects/${pid}`, { enabledMcpServers: [] })).body.enabledMcpServers).toEqual([]);
    h.llmBodies = [];
    h.script = [textReply("ok")];
    await h.chat({ content: "x", projectId: pid });
    expect(h.llmBodies[0].tools.map((t: any) => t.function.name).some((n: string) => n.startsWith("mcp__"))).toBe(false);
    await c.req("PATCH", `/projects/${pid}`, { enabledMcpServers: [srv.id] });
    h.llmBodies = [];
    h.script = [textReply("ok")];
    await h.chat({ content: "y", projectId: pid });
    expect(h.llmBodies[0].tools.map((t: any) => t.function.name)).toContain("mcp__loop__add");

    // disabling the server hides every tool; deleting removes it from project allow-lists
    await c.req("PATCH", `/mcp/servers/${srv.id}`, { enabled: false });
    h.llmBodies = [];
    h.script = [textReply("ok")];
    await h.chat({ content: "z" });
    expect(h.llmBodies[0].tools.map((t: any) => t.function.name).some((n: string) => n.startsWith("mcp__"))).toBe(false);
    await c.req("DELETE", `/mcp/servers/${srv.id}`);
    expect((await c.get("/projects")).body.find((p: any) => p.id === pid).enabledMcpServers).toEqual([]);
  });
});
