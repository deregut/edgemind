import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { decodeKey32 } from "../src/env";
import type { ToolContext } from "../src/agent/tools";
import { checkUrlShape, isPrivateIp, BlockedUrlError } from "../src/tools/ssrf";
import { capResults, SNIPPET_MAX, webFetchTool, webSearchTool } from "../src/tools/web";
import { htmlToMarkdown } from "../src/tools/html";
import { Harness } from "./harness";

const h = new Harness();
let ctx: ToolContext;
const dns: Record<string, string[]> = {};

beforeAll(async () => {
  await h.setup();
  ctx = {
    runId: "00000000-0000-4000-8000-000000000001", conversationId: "00000000-0000-4000-8000-000000000002", projectId: null,
    signal: new AbortController().signal, database: h.t.database, encKey: decodeKey32(h.env.ENCRYPTION_KEY)!, fetch: h.fetch,
  };
  // DNS-over-HTTPS mock
  h.routes.push((url) => {
    if (url.hostname !== "cloudflare-dns.com") return undefined;
    const name = url.searchParams.get("name")!;
    const type = url.searchParams.get("type");
    const ips = (dns[name] ?? []).filter((ip) => (type === "A" ? !ip.includes(":") : ip.includes(":")));
    return Response.json({ Status: 0, Answer: ips.map((data) => ({ type: type === "A" ? 1 : 28, data })) });
  });
});
afterAll(() => h.teardown());
beforeEach(() => {
  h.outbound = [];
});

describe("SSRF guard", () => {
  it("classifies private / reserved addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::a00:1"])
      expect(isPrivateIp(ip), ip).toBe(true);
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700::1111", "::ffff:8.8.8.8"]) expect(isPrivateIp(ip), ip).toBe(false);
  });
  it("rejects non-http schemes, credentials, literal private IPs (incl. integer/hex forms) and internal names", () => {
    for (const u of ["file:///etc/passwd", "ftp://x.com/a", "gopher://x.com", "http://user:pw@example.com/", "http://127.0.0.1/", "http://2130706433/", "http://0x7f000001/", "http://[::1]:8080/", "http://localhost:3000", "http://metadata.google.internal/", "http://intranet/"])
      expect(() => checkUrlShape(u), u).toThrow(BlockedUrlError);
    expect(checkUrlShape("https://example.com/a").hostname).toBe("example.com");
  });
});

describe("web_search", () => {
  it("errors helpfully without providers", async () => {
    await expect(webSearchTool.execute({ query: "x" }, ctx)).rejects.toThrow("尚未設定任何網頁搜尋供應商");
  });

  it("uses providers in priority order with fallback; caps snippets and total size", async () => {
    const c = h.client();
    await c.post("/providers", { type: "search", kind: "tavily", name: "Tavily", apiKey: "tvly-123456", priority: 1 });
    await c.post("/providers", { type: "search", kind: "serper", name: "Serper", apiKey: "serper-123456", priority: 2 });
    const long = "很長的摘要".repeat(200);
    h.routes.unshift((url, init) => {
      if (url.hostname === "api.tavily.com") return new Response('{"error":"quota"}', { status: 429 });
      if (url.hostname === "google.serper.dev") {
        const body = JSON.parse(String(init.body));
        expect(body).toMatchObject({ q: "台北 天氣", num: 10 });
        return Response.json({ organic: Array.from({ length: 10 }, (_, i) => ({ title: `結果 ${i}`, link: `https://ex.com/${i}`, snippet: long })) });
      }
      return undefined;
    });
    const r: any = await webSearchTool.execute({ query: "台北 天氣", max_results: 10 }, ctx);
    expect(r.provider).toBe("Serper");
    expect(r.fallbackFrom[0]).toContain("Tavily");
    expect(r.results.length).toBeGreaterThan(0);
    const total = r.results.reduce((n: number, x: any) => n + x.title.length + x.url.length + x.snippet.length, 0);
    expect(total).toBeLessThanOrEqual(4000);
    for (const x of r.results) expect(x.snippet.length).toBeLessThanOrEqual(SNIPPET_MAX);
    expect(JSON.stringify(r.results).length).toBeLessThan(6000);
    h.routes.shift();
  });

  it("maps every provider's response shape", async () => {
    const c = h.client();
    await h.t.database.query("DELETE FROM providers WHERE type = 'search'");
    await c.post("/providers", { type: "search", kind: "searxng", name: "SX", baseUrl: "https://sx.example.org", priority: 1 });
    await c.post("/providers", { type: "search", kind: "jina", name: "JS", apiKey: "jina_123456", priority: 2 });
    await c.post("/providers", { type: "search", kind: "google_pse", name: "PSE", apiKey: "AIza123456", config: { cx: "cx1" }, priority: 3 });
    let fail = ["sx.example.org", "s.jina.ai"];
    h.routes.unshift((url) => {
      if (fail.includes(url.hostname)) return new Response("down", { status: 503 });
      if (url.hostname === "sx.example.org") return Response.json({ results: [{ title: "SX", url: "https://a.com", content: "sx snippet" }] });
      if (url.hostname === "s.jina.ai") return Response.json({ data: [{ title: "JS", url: "https://b.com", description: "jina snippet" }] });
      if (url.hostname === "www.googleapis.com") {
        expect(url.searchParams.get("cx")).toBe("cx1");
        return Response.json({ items: [{ title: "G", link: "https://c.com", snippet: "pse snippet" }, { title: "bad", link: "javascript:alert(1)" }] });
      }
      return undefined;
    });
    let r: any = await webSearchTool.execute({ query: "q" }, ctx);
    expect(r).toMatchObject({ provider: "PSE", results: [{ title: "G", url: "https://c.com", snippet: "pse snippet" }] });
    fail = ["sx.example.org"];
    r = await webSearchTool.execute({ query: "q" }, ctx);
    expect(r.results[0]).toEqual({ title: "JS", url: "https://b.com", snippet: "jina snippet" });
    fail = [];
    r = await webSearchTool.execute({ query: "q" }, ctx);
    expect(r.results[0].url).toBe("https://a.com");
    h.routes.shift();
  });

  it("capResults keeps at least one result and stops at the total budget", () => {
    expect(capResults([{ title: "a", url: "u", snippet: "x".repeat(300) }], 10)).toHaveLength(1);
    const many = Array.from({ length: 30 }, (_, i) => ({ title: `t${i}`, url: `https://x/${i}`, snippet: "s".repeat(290) }));
    expect(capResults(many).length).toBe(13);
  });
});

describe("web_fetch", () => {
  const article = `<!doctype html><html><head><title>測試文章</title></head><body>
    <nav>選單 首頁 關於</nav>
    <article><h1>標題一</h1><p>${"這是第一段內容，說明重點。".repeat(30)}</p>
    <h2>小節</h2><ul><li>項目 A</li><li>項目 <a href="/b">B</a></li></ul>
    <pre><code>const x = 1;</code></pre>
    <table><tr><th>名稱</th><th>值</th></tr><tr><td>a</td><td>1</td></tr></table>
    <p>${"第二段文字。".repeat(200)}</p></article>
    <script>alert(1)</script><footer>版權</footer></body></html>`;

  beforeAll(() => {
    dns["news.example.com"] = ["93.184.216.34"];
    dns["evil.example.com"] = ["10.0.0.5"];
    dns["redir.example.com"] = ["93.184.216.35"];
    dns["blocked.example.com"] = ["93.184.216.36"];
    h.routes.unshift((url) => {
      if (url.hostname === "news.example.com") return new Response(article, { headers: { "content-type": "text/html; charset=utf-8" } });
      if (url.hostname === "redir.example.com") return new Response(null, { status: 302, headers: { location: "http://evil.example.com/x" } });
      if (url.hostname === "blocked.example.com") return new Response("forbidden", { status: 403 });
      if (url.hostname === "r.jina.ai") return new Response(`Title: 從 Jina 來的\n\nURL Source: ${url.pathname.slice(1)}\n\nMarkdown Content:\n# Jina 內容\n\n${"文字".repeat(100)}`);
      if (url.hostname === "evil.example.com") throw new Error("must never be fetched");
      return undefined;
    });
  });

  it("converts the main content to Markdown and reads it in chunks", async () => {
    const r1: any = await webFetchTool.execute({ url: "https://news.example.com/a", max_chars: 1000 }, ctx);
    expect(r1).toMatchObject({ source: "direct", offset: 0, nextOffset: 1000 });
    expect(r1.title).toBe("測試文章");
    expect(r1.content).toContain("# 標題一");
    expect(r1.content).not.toContain("alert(1)");
    expect(r1.content).not.toContain("選單");
    const full = htmlToMarkdown(article, "https://news.example.com/a").markdown;
    expect(full).toContain("## 小節");
    expect(full).toContain("- 項目 [B](https://news.example.com/b)");
    expect(full).toContain("```\nconst x = 1;\n```");
    expect(full).toContain("| 名稱 | 值 |");
    expect(r1.totalChars).toBe(full.length);
    const r2: any = await webFetchTool.execute({ url: "https://news.example.com/a", offset: 1000, max_chars: 1000 }, ctx);
    expect(r2.offset).toBe(1000);
    expect(r1.content + r2.content).toBe(full.slice(0, 2000));
    const end: any = await webFetchTool.execute({ url: "https://news.example.com/a", offset: full.length - 10 }, ctx);
    expect(end.nextOffset).toBeNull();
  });

  it("blocks private targets, DNS rebinding to internal IPs and redirects into the private network", async () => {
    await expect(webFetchTool.execute({ url: "http://169.254.169.254/latest/meta-data" }, ctx)).rejects.toThrow(/內部或保留位址/);
    await expect(webFetchTool.execute({ url: "file:///etc/passwd" }, ctx)).rejects.toThrow(/通訊協定/);
    await expect(webFetchTool.execute({ url: "https://evil.example.com/" }, ctx)).rejects.toThrow(/10\.0\.0\.5/);
    await expect(webFetchTool.execute({ url: "https://redir.example.com/" }, ctx)).rejects.toThrow(/10\.0\.0\.5/);
    expect(h.outbound.some((o) => o.url.includes("r.jina.ai"))).toBe(false);
  });

  it("falls back to Jina Reader when the site refuses", async () => {
    const r: any = await webFetchTool.execute({ url: "https://blocked.example.com/p" }, ctx);
    expect(r.source).toBe("jina");
    expect(r.title).toBe("從 Jina 來的");
    expect(r.content.startsWith("# Jina 內容")).toBe(true);
    expect(r.note).toContain("HTTP 403");
    const jinaCall = h.outbound.find((o) => o.url.startsWith("https://r.jina.ai/"))!;
    expect(new Headers(jinaCall.init.headers).get("authorization")).toBe("Bearer jina_123456");
  });
});
