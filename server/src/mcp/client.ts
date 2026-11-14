/**
 * Minimal MCP client over native fetch (remote servers only; stdio is impossible on serverless):
 *  - Streamable HTTP (2025-03-26+): JSON-RPC POSTs; replies as application/json or an SSE stream;
 *    `Mcp-Session-Id` kept by the caller across invocations, re-initialized on 404; `MCP-Protocol-Version` header.
 *  - Legacy HTTP+SSE (2024-11-05): GET opens the event stream, the `endpoint` event gives the POST URL,
 *    replies arrive as `message` events. Each operation opens its own short-lived connection.
 * Server→client requests (sampling, elicitation, roots) are answered with "method not found"; pings with {}.
 */
import { parseSse } from "../llm/sse";

export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export type McpTransport = "streamable_http" | "sse";

export interface McpConnection {
  url: string;
  transport: McpTransport;
  headers: Record<string, string>;
  sessionId?: string | null;
  protocolVersion?: string | null;
}

export interface McpToolInfo {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface McpInitResult {
  protocolVersion: string;
  serverInfo?: Record<string, unknown>;
  capabilities?: Record<string, unknown>;
  instructions?: string;
}

export class McpError extends Error {
  constructor(message: string, public status?: number, public code?: number) {
    super(message);
  }
}
/** 401/403 from the server: needs (re-)authorization. */
export class McpAuthRequired extends McpError {
  constructor(public wwwAuthenticate: string | null, status = 401) {
    super(status === 403 ? "MCP 伺服器拒絕存取（權限不足）" : "MCP 伺服器需要授權", status);
  }
}
class SessionExpired extends McpError {}

type Fetch = typeof fetch;
interface RpcResponse {
  jsonrpc: "2.0";
  id?: string | number | null;
  result?: any;
  error?: { code: number; message: string; data?: unknown };
  method?: string;
  params?: unknown;
}

const CLIENT_INFO = { name: "EdgeMind", version: "0.1.0" };

export class McpClient {
  private nextId = 1;
  /** Updated session state (persist after use). */
  sessionId: string | null;
  protocolVersion: string | null;

  constructor(private conn: McpConnection, private fetchFn: Fetch, private opts: { timeoutMs?: number; signal?: AbortSignal } = {}) {
    this.sessionId = conn.sessionId ?? null;
    this.protocolVersion = conn.protocolVersion ?? null;
  }

  private signal(): AbortSignal {
    const t = AbortSignal.timeout(this.opts.timeoutMs ?? 45_000);
    return this.opts.signal ? AbortSignal.any([t, this.opts.signal]) : t;
  }

  private baseHeaders(): Record<string, string> {
    const h: Record<string, string> = { ...this.conn.headers };
    if (this.sessionId) h["mcp-session-id"] = this.sessionId;
    if (this.protocolVersion) h["mcp-protocol-version"] = this.protocolVersion;
    return h;
  }

  private initParams() {
    return { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO };
  }

  private acceptInit(r: any): McpInitResult {
    const v = typeof r?.protocolVersion === "string" ? r.protocolVersion : MCP_PROTOCOL_VERSION;
    if (!SUPPORTED_VERSIONS.includes(v)) throw new McpError(`不支援的 MCP 協定版本：${v}`);
    this.protocolVersion = v;
    return { protocolVersion: v, serverInfo: r?.serverInfo, capabilities: r?.capabilities, instructions: typeof r?.instructions === "string" ? r.instructions : undefined };
  }

  // ---------------- Streamable HTTP ----------------

  private async post(body: unknown, signal: AbortSignal): Promise<Response> {
    const res = await this.fetchFn(this.conn.url, {
      method: "POST",
      headers: { ...this.baseHeaders(), "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify(body),
      signal,
    });
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel().catch(() => {});
      throw new McpAuthRequired(res.headers.get("www-authenticate"), res.status);
    }
    if (res.status === 404 && this.sessionId) {
      await res.body?.cancel().catch(() => {});
      throw new SessionExpired("MCP session 已過期", 404);
    }
    return res;
  }

  /** Read the JSON-RPC response for `id` from a JSON or SSE reply, answering server→client requests. */
  private async readResponse(res: Response, id: number, signal: AbortSignal): Promise<any> {
    const ct = res.headers.get("content-type") ?? "";
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let msg = text.slice(0, 300);
      try {
        const j = JSON.parse(text);
        msg = j?.error?.message ?? msg;
      } catch {
        /* not JSON */
      }
      throw new McpError(`MCP 伺服器回應 HTTP ${res.status}${msg ? `：${msg}` : ""}`, res.status);
    }
    const handle = (m: RpcResponse): { done: boolean; value?: any } => {
      if (m.id === id && (m.result !== undefined || m.error)) {
        if (m.error) throw new McpError(`MCP 錯誤 ${m.error.code}：${m.error.message}`, undefined, m.error.code);
        return { done: true, value: m.result };
      }
      if (m.method && m.id !== undefined && m.id !== null) void this.answerServerRequest(m, signal);
      return { done: false };
    };
    if (ct.includes("text/event-stream")) {
      for await (const ev of parseSse(res.body!, signal)) {
        if (!ev.data) continue;
        let msg: RpcResponse | RpcResponse[];
        try {
          msg = JSON.parse(ev.data);
        } catch {
          continue;
        }
        for (const m of Array.isArray(msg) ? msg : [msg]) {
          const r = handle(m);
          if (r.done) {
            void res.body?.cancel().catch(() => {});
            return r.value;
          }
        }
      }
      throw new McpError("MCP 串流在回應前結束");
    }
    const json = (await res.json().catch(() => null)) as RpcResponse | RpcResponse[] | null;
    if (!json) throw new McpError("MCP 回應不是有效的 JSON");
    for (const m of Array.isArray(json) ? json : [json]) {
      const r = handle(m);
      if (r.done) return r.value;
    }
    throw new McpError("MCP 回應缺少對應的結果");
  }

  private async answerServerRequest(m: RpcResponse, signal: AbortSignal) {
    const reply = m.method === "ping" ? { jsonrpc: "2.0", id: m.id, result: {} } : { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not supported by EdgeMind" } };
    try {
      const r = await this.post(reply, signal);
      await r.body?.cancel().catch(() => {});
    } catch {
      /* best effort */
    }
  }

  private async rpcHttp(method: string, params: unknown): Promise<any> {
    const signal = this.signal();
    const id = this.nextId++;
    const res = await this.post({ jsonrpc: "2.0", id, method, params }, signal);
    if (method === "initialize") {
      const sid = res.headers.get("mcp-session-id");
      if (sid) this.sessionId = sid;
    }
    return this.readResponse(res, id, signal);
  }

  private async notifyHttp(method: string, params?: unknown) {
    const res = await this.post({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }, this.signal());
    await res.body?.cancel().catch(() => {});
    if (!res.ok && res.status !== 202) throw new McpError(`MCP 通知失敗（HTTP ${res.status}）`, res.status);
  }

  async initialize(): Promise<McpInitResult> {
    if (this.conn.transport === "sse") return this.withSse(async () => this.lastInit!);
    this.sessionId = null;
    this.protocolVersion = null;
    const r = this.acceptInit(await this.rpcHttp("initialize", this.initParams()));
    await this.notifyHttp("notifications/initialized");
    this.lastInit = r;
    return r;
  }
  private lastInit: McpInitResult | null = null;

  /** One request; (re)initializes when there is no session yet or the session expired. */
  async request(method: string, params: unknown = {}): Promise<any> {
    if (this.conn.transport === "sse") return this.withSse((send) => send(method, params));
    if (!this.protocolVersion) await this.initialize();
    try {
      return await this.rpcHttp(method, params);
    } catch (e) {
      if (!(e instanceof SessionExpired)) throw e;
      await this.initialize();
      return this.rpcHttp(method, params);
    }
  }

  async listTools(maxPages = 20): Promise<McpToolInfo[]> {
    if (this.conn.transport === "sse") {
      return this.withSse(async (send) => {
        const out: McpToolInfo[] = [];
        let cursor: string | undefined;
        for (let i = 0; i < maxPages; i++) {
          const r = await send("tools/list", cursor ? { cursor } : {});
          out.push(...((r?.tools ?? []) as McpToolInfo[]));
          cursor = r?.nextCursor;
          if (!cursor) break;
        }
        return out;
      });
    }
    const out: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < maxPages; i++) {
      const r = await this.request("tools/list", cursor ? { cursor } : {});
      out.push(...((r?.tools ?? []) as McpToolInfo[]));
      cursor = r?.nextCursor;
      if (!cursor) break;
    }
    return out;
  }

  /** initialize + tools/list (one connection on the legacy SSE transport). */
  async initAndList(): Promise<{ init: McpInitResult; tools: McpToolInfo[] }> {
    if (this.conn.transport === "sse") {
      const tools = await this.listTools();
      return { init: this.lastInit!, tools };
    }
    const init = await this.initialize();
    return { init, tools: await this.listTools() };
  }

  callTool(name: string, args: unknown): Promise<any> {
    return this.request("tools/call", { name, arguments: args ?? {} });
  }

  // ---------------- legacy HTTP + SSE ----------------

  private async withSse<T>(fn: (send: (method: string, params: unknown) => Promise<any>) => Promise<T>): Promise<T> {
    const signal = this.signal();
    const ac = new AbortController();
    const both = AbortSignal.any([signal, ac.signal]);
    const res = await this.fetchFn(this.conn.url, { method: "GET", headers: { ...this.conn.headers, accept: "text/event-stream" }, signal: both });
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel().catch(() => {});
      throw new McpAuthRequired(res.headers.get("www-authenticate"), res.status);
    }
    if (!res.ok || !res.body) throw new McpError(`MCP SSE 連線失敗（HTTP ${res.status}）`, res.status);
    const events = parseSse(res.body, both);
    const waiters = new Map<number, { resolve(v: any): void; reject(e: unknown): void }>();
    let endpoint: string | null = null;
    let endpointResolve!: () => void;
    let endpointReject!: (e: unknown) => void;
    const endpointReady = new Promise<void>((r, j) => {
      endpointResolve = r;
      endpointReject = j;
    });
    const pump = (async () => {
      try {
        for await (const ev of events) {
          if (ev.event === "endpoint") {
            endpoint = new URL(ev.data.trim(), this.conn.url).toString();
            if (new URL(endpoint).origin !== new URL(this.conn.url).origin) throw new McpError("MCP SSE endpoint 與伺服器不同源，已拒絕");
            endpointResolve();
            continue;
          }
          let m: RpcResponse;
          try {
            m = JSON.parse(ev.data);
          } catch {
            continue;
          }
          if (typeof m.id === "number" && waiters.has(m.id) && (m.result !== undefined || m.error)) {
            const w = waiters.get(m.id)!;
            waiters.delete(m.id);
            if (m.error) w.reject(new McpError(`MCP 錯誤 ${m.error.code}：${m.error.message}`, undefined, m.error.code));
            else w.resolve(m.result);
          } else if (m.method && m.id !== undefined && m.id !== null && endpoint) {
            const reply = m.method === "ping" ? { jsonrpc: "2.0", id: m.id, result: {} } : { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not supported by EdgeMind" } };
            void this.fetchFn(endpoint, { method: "POST", headers: { ...this.conn.headers, "content-type": "application/json" }, body: JSON.stringify(reply), signal: both }).catch(() => {});
          }
        }
        throw new McpError("MCP SSE 連線已關閉");
      } catch (e) {
        endpointReject(e);
        for (const w of waiters.values()) w.reject(e);
        waiters.clear();
      }
    })();
    const postMsg = async (msg: unknown) => {
      const r = await this.fetchFn(endpoint!, { method: "POST", headers: { ...this.conn.headers, "content-type": "application/json" }, body: JSON.stringify(msg), signal: both });
      await r.body?.cancel().catch(() => {});
      if (r.status === 401 || r.status === 403) throw new McpAuthRequired(r.headers.get("www-authenticate"), r.status);
      if (!r.ok && r.status !== 202) throw new McpError(`MCP POST 失敗（HTTP ${r.status}）`, r.status);
    };
    const send = async (method: string, params: unknown) => {
      const id = this.nextId++;
      const p = new Promise<any>((resolve, reject) => waiters.set(id, { resolve, reject }));
      p.catch(() => {});
      await postMsg({ jsonrpc: "2.0", id, method, params });
      return p;
    };
    try {
      await endpointReady;
      this.lastInit = this.acceptInit(await send("initialize", this.initParams()));
      await postMsg({ jsonrpc: "2.0", method: "notifications/initialized" });
      return await fn(send);
    } finally {
      ac.abort();
      void pump;
    }
  }
}

/** Flatten a tools/call result into text for the model (images / audio summarized). */
export function toolResultText(r: any): { text: string; isError: boolean; structured?: unknown } {
  const parts: string[] = [];
  for (const c of Array.isArray(r?.content) ? r.content : []) {
    if (c?.type === "text") parts.push(String(c.text ?? ""));
    else if (c?.type === "image" || c?.type === "audio") parts.push(`[${c.type}: ${c.mimeType ?? "binary"}，已省略]`);
    else if (c?.type === "resource_link") parts.push(`[資源連結] ${c.name ?? ""} ${c.uri ?? ""}`.trim());
    else if (c?.type === "resource") {
      const res = c.resource ?? {};
      parts.push(typeof res.text === "string" ? `[資源 ${res.uri ?? ""}]\n${res.text}` : `[資源 ${res.uri ?? ""}：${res.mimeType ?? "binary"}，已省略]`);
    }
  }
  const structured = r?.structuredContent;
  if (!parts.length && structured !== undefined) parts.push(JSON.stringify(structured));
  return { text: parts.join("\n\n"), isError: r?.isError === true, ...(structured !== undefined ? { structured } : {}) };
}
