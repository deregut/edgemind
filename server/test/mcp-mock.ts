/** In-memory MCP servers for tests: Streamable HTTP (JSON or SSE replies, sessions) and legacy HTTP+SSE. */
const enc = new TextEncoder();

export interface MockTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: Record<string, unknown>;
  handler(args: any): any;
}

export class McpMock {
  tools: MockTool[] = [];
  /** Reply format for Streamable HTTP. */
  replyAs: "json" | "sse" = "json";
  sessions = new Set<string>();
  requireBearer: string | null = null;
  calls: { method: string; params: any; session: string | null; auth: string | null }[] = [];
  pageSize = 100;
  private nextSession = 1;
  /** legacy SSE streams by session */
  private streams = new Map<string, ReadableStreamDefaultController<Uint8Array>>();

  constructor(public base: string) {}

  private result(method: string, params: any): any {
    if (method === "initialize") return { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "mock", version: "1.0" }, instructions: "Mock server" };
    if (method === "tools/list") {
      const start = params?.cursor ? Number(params.cursor) : 0;
      const page = this.tools.slice(start, start + this.pageSize).map(({ handler: _h, ...t }) => ({ inputSchema: { type: "object", properties: {} }, ...t }));
      const next = start + this.pageSize < this.tools.length ? String(start + this.pageSize) : undefined;
      return { tools: page, ...(next ? { nextCursor: next } : {}) };
    }
    if (method === "tools/call") {
      const t = this.tools.find((x) => x.name === params?.name);
      if (!t) throw { code: -32602, message: `Unknown tool ${params?.name}` };
      return t.handler(params.arguments ?? {});
    }
    throw { code: -32601, message: "method not found" };
  }

  private authFail(auth: string | null): Response | undefined {
    if (this.requireBearer && auth !== `Bearer ${this.requireBearer}`)
      return new Response("unauthorized", { status: 401, headers: { "www-authenticate": `Bearer resource_metadata="${this.base}/.well-known/oauth-protected-resource/mcp"` } });
    return undefined;
  }

  /** Streamable HTTP endpoint at {base}/mcp */
  route = async (url: URL, init: RequestInit): Promise<Response | undefined> => {
    if (url.href !== `${this.base}/mcp`) return undefined;
    const h = new Headers(init.headers);
    const auth = h.get("authorization");
    const fail = this.authFail(auth);
    if (fail) return fail;
    if (init.method !== "POST") return new Response(null, { status: 405 });
    const msg = JSON.parse(String(init.body));
    const session = h.get("mcp-session-id");
    this.calls.push({ method: msg.method ?? "(response)", params: msg.params, session, auth });
    if (msg.method !== "initialize" && session && !this.sessions.has(session)) return new Response("session gone", { status: 404 });
    if (msg.method !== "initialize" && !session) return new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "no session" } }), { status: 400 });
    if (msg.id === undefined || msg.method === undefined) return new Response(null, { status: 202 }); // notification / response
    let body: unknown;
    try {
      body = { jsonrpc: "2.0", id: msg.id, result: this.result(msg.method, msg.params) };
    } catch (e: any) {
      body = { jsonrpc: "2.0", id: msg.id, error: e };
    }
    const headers: Record<string, string> = {};
    if (msg.method === "initialize") {
      const sid = `s${this.nextSession++}`;
      this.sessions.add(sid);
      headers["mcp-session-id"] = sid;
    }
    if (this.replyAs === "sse") {
      // a server notification + a ping request before the actual response
      const sse =
        `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } })}\n\n` +
        `event: message\ndata: ${JSON.stringify(body)}\n\n`;
      return new Response(sse, { headers: { ...headers, "content-type": "text/event-stream" } });
    }
    return Response.json(body, { headers });
  };

  /** Legacy HTTP+SSE at {base}/sse (GET) + {base}/messages?sessionId= (POST) */
  legacyRoute = async (url: URL, init: RequestInit): Promise<Response | undefined> => {
    const h = new Headers(init.headers);
    if (url.href === `${this.base}/sse` && (init.method ?? "GET") === "GET") {
      const fail = this.authFail(h.get("authorization"));
      if (fail) return fail;
      const sid = `L${this.nextSession++}`;
      const stream = new ReadableStream<Uint8Array>({
        start: (ctrl) => {
          this.streams.set(sid, ctrl);
          ctrl.enqueue(enc.encode(`: hello\n\nevent: endpoint\ndata: /messages?sessionId=${sid}\n\n`));
        },
        cancel: () => void this.streams.delete(sid),
      });
      init.signal?.addEventListener("abort", () => {
        try {
          this.streams.get(sid)?.close();
        } catch {
          /* closed */
        }
        this.streams.delete(sid);
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    }
    if (url.origin + url.pathname === `${this.base}/messages` && init.method === "POST") {
      const sid = url.searchParams.get("sessionId") ?? "";
      const ctrl = this.streams.get(sid);
      if (!ctrl) return new Response("no session", { status: 404 });
      const msg = JSON.parse(String(init.body));
      this.calls.push({ method: msg.method ?? "(response)", params: msg.params, session: sid, auth: h.get("authorization") });
      if (msg.id !== undefined && msg.method) {
        let body: unknown;
        try {
          body = { jsonrpc: "2.0", id: msg.id, result: this.result(msg.method, msg.params) };
        } catch (e: any) {
          body = { jsonrpc: "2.0", id: msg.id, error: e };
        }
        queueMicrotask(() => {
          try {
            ctrl.enqueue(enc.encode(`event: message\ndata: ${JSON.stringify(body)}\n\n`));
          } catch {
            /* closed */
          }
        });
      }
      return new Response("Accepted", { status: 202 });
    }
    return undefined;
  };
}
