import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { chunkDocument, csvRecords, markdownSections } from "../../shared/src/index";
import { kbChunks, kbCollections, messages } from "../src/db/schema";
import { documentTokens, queryTerms, toTsqueryLiteral, toTsvectorLiteral } from "../src/lib/textsearch";
import { embedTexts, rerankDocuments, type ProbeTarget } from "../src/providers/probe";
import { indexStep } from "../src/rag/kb";
import { Harness, callsReply, textReply } from "./harness";
import { S3Mock } from "./s3-mock";

// ---------- deterministic mock embeddings: hashed token bag, L2-normalized ----------
function fakeEmbed(text: string, dim: number): number[] {
  const v = new Array(dim).fill(0);
  for (const t of documentTokens(text)) {
    let h = 2166136261;
    for (const ch of t) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619) >>> 0;
    v[h % dim] += 1;
  }
  const n = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
  return v.map((x) => x / n);
}

const s3 = new S3Mock();
const h = new Harness({ deps: { s3Fetch: s3.fetch } });
const embedBodies: any[] = [];
let failEmbeds = 0;
let rerankCalls = 0;

h.routes.push((async (url: URL, init: RequestInit): Promise<Response | undefined> => {
  if (url.href === "https://mock.embed/v1/embeddings") {
    const body = JSON.parse(String(init.body));
    embedBodies.push(body);
    if (failEmbeds > 0) {
      failEmbeds--;
      return new Response('{"error":"overloaded"}', { status: 503 });
    }
    const dim = body.model === "emb-small" ? 8 : body.dimensions ?? 64;
    return Response.json({ data: (body.input as string[]).map((t, i) => ({ index: i, embedding: fakeEmbed(t, dim) })) });
  }
  if (url.href === "https://mock.rerank/v1/rerank") {
    rerankCalls++;
    const body = JSON.parse(String(init.body));
    // prefers documents mentioning 「退貨」
    const scored = (body.documents as string[]).map((d, i) => ({ index: i, relevance_score: d.includes("退貨") ? 0.9 : 0.1 }));
    return Response.json({ results: scored.sort((a, b) => b.relevance_score - a.relevance_score).slice(0, body.top_n) });
  }
  return undefined;
}) as never);

let embProvider = "";
let rerankProvider = "";
let pid = "";

beforeAll(async () => {
  await h.setup();
  const c = h.client();
  embProvider = (await c.post("/providers", { type: "embedding", kind: "openai_compatible", name: "MockEmb", baseUrl: "https://mock.embed/v1", apiKey: "emb-key-123456" })).body.id;
  rerankProvider = (await c.post("/providers", { type: "rerank", kind: "jina", name: "MockRerank", baseUrl: "https://mock.rerank/v1", apiKey: "rr-key-123456" })).body.id;
  pid = (await c.post("/projects", { name: "知識專案" })).body.id;
});
afterAll(() => h.teardown());
beforeEach(() => {
  h.script = [];
  h.llmBodies = [];
});

// ---------- unit: chunking ----------

describe("chunking (browser-side, shared)", () => {
  it("markdown is heading-aware, keeps code fences whole, respects size and overlaps", () => {
    const md = [
      "# 產品手冊", "介紹文字。", "## 安裝", "第一步：下載。".repeat(30), "", "```sh", "# not a heading", "", "npm i", "```", "", "## 退貨政策", "七天內可退貨。",
    ].join("\n");
    const secs = markdownSections(md);
    expect(secs.map((s) => s.headings.join(">"))).toEqual(["產品手冊", "產品手冊>安裝", "產品手冊>退貨政策"]);
    const chunks = chunkDocument({ format: "markdown", segments: [{ text: md }] }, { size: 200, overlap: 40 });
    for (const ch of chunks) expect(ch.content.length).toBeLessThanOrEqual(200);
    expect(chunks.some((c) => c.content.startsWith("產品手冊 > 安裝") && c.content.includes("```sh\n# not a heading\n\nnpm i\n```"))).toBe(true);
    const ret = chunks.find((c) => c.content.includes("七天內可退貨"))!;
    expect(ret.metadata.headings).toEqual(["產品手冊", "退貨政策"]);
    // overlap: consecutive chunks of the long section share text
    const install = chunks.filter((c) => (c.metadata.headings as string[])?.[1] === "安裝" && c.content.includes("第一步"));
    expect(install.length).toBeGreaterThan(1);
    const tail = install[0].content.slice(-20);
    expect(install[1].content).toContain(tail.slice(-8));
  });

  it("csv repeats the header with row ranges; code keeps line numbers; pdf pages carry through", () => {
    const csv = 'name,note\n"甲","多行\n備註"\n乙,b\n丙,c\n';
    expect(csvRecords(csv)).toEqual(["name,note", '"甲","多行\n備註"', "乙,b", "丙,c"]);
    const rows = csvRecords(csv);
    const cc = chunkDocument({ format: "csv", segments: [{ text: rows.slice(1).join("\n") }], csvHeader: rows[0] }, { size: 100 });
    expect(cc[0].content.startsWith("name,note\n")).toBe(true);
    expect(cc[0].metadata.rows).toEqual([1, 3]);
    const code = Array.from({ length: 60 }, (_, i) => `const v${i} = ${i};`).join("\n");
    const kc = chunkDocument({ format: "code", segments: [{ text: code }] }, { size: 200, overlap: 40 });
    expect(kc[0].metadata.lines).toEqual([1, expect.any(Number)]);
    expect((kc[1].metadata.lines as number[])[0]).toBeLessThanOrEqual((kc[0].metadata.lines as number[])[1]);
    const pc = chunkDocument({ format: "text", segments: [{ text: "第一頁內容", page: 1 }, { text: "第二頁內容", page: 2 }] });
    expect(pc.map((c) => c.metadata.page)).toEqual([1, 2]);
  });
});

// ---------- unit: CJK text search ----------

describe("CJK-friendly full-text (app tokenization → tsvector)", () => {
  it("tokenizes CJK into unigrams + bigrams and Latin into words", () => {
    expect(documentTokens("RAG 知識庫")).toEqual(["rag", "知", "知識", "識", "識庫", "庫"]);
    expect(queryTerms("知識庫 RAG")).toEqual([{ term: "知識", latin: false }, { term: "識庫", latin: false }, { term: "rag", latin: true }]);
    expect(toTsqueryLiteral("it's", "and")).toBe("'it':* & 's':*");
    expect(toTsqueryLiteral("。，", "or")).toBeNull();
  });

  it("Postgres accepts the literals and matches partial CJK words (which 'simple' cannot)", async () => {
    const db = h.t.database;
    const doc = "我們正在設計知識庫的檢索功能，支援 Hybrid Search 與 O'Reilly 的書。";
    const lit = toTsvectorLiteral(doc);
    const q = async (query: string, mode: "and" | "or") =>
      (await db.query<{ m: boolean }>(`SELECT $1::tsvector @@ $2::tsquery AS m`, [lit, toTsqueryLiteral(query, mode)]))[0].m;
    expect(await q("知識", "and")).toBe(true);
    expect(await q("檢索功能", "and")).toBe(true);
    expect(await q("hybrid sea", "and")).toBe(true); // prefix
    expect(await q("知識 圖譜", "and")).toBe(false);
    expect(await q("知識 圖譜", "or")).toBe(true);
    expect(await q("o'reilly", "and")).toBe(true);
    const simple = (await db.query<{ m: boolean }>(`SELECT to_tsvector('simple', $1) @@ plainto_tsquery('simple', '知識') AS m`, [doc]))[0].m;
    expect(simple).toBe(false); // the bug this fixes
  });
});

// ---------- unit: adapters ----------

describe("embedding / rerank adapters (native fetch)", () => {
  const capture = () => {
    const calls: { url: string; body: any; headers: any }[] = [];
    const f = (async (u: any, init: any) => {
      const body = JSON.parse(init.body);
      calls.push({ url: String(u), body, headers: init.headers });
      const n = body.input?.length ?? body.texts?.length ?? body.text?.length ?? body.requests?.length ?? 1;
      const vecs = Array.from({ length: n }, () => [0.1, 0.2, 0.3]);
      if (String(u).includes("batchEmbedContents")) return Response.json({ embeddings: vecs.map((values) => ({ values })) });
      if (String(u).includes("/v2/embed")) return Response.json({ embeddings: { float: vecs } });
      if (String(u).includes("/ai/run/")) return Response.json({ result: { data: vecs } });
      if (String(u).includes("/rerank")) {
        const res = [{ index: 1, relevance_score: 0.8 }, { index: 0, relevance_score: 0.3 }];
        return Response.json(String(u).includes("voyage") ? { data: res } : { results: res });
      }
      return Response.json({ data: vecs.map((embedding, index) => ({ embedding, index })) });
    }) as typeof fetch;
    return { calls, f };
  };
  const T = (kind: string, baseUrl = "", config: Record<string, string> = {}): ProbeTarget => ({ type: "embedding", kind, baseUrl, apiKey: "k", config });

  it("sends task types and requested dimensions in each provider's dialect", async () => {
    const { calls, f } = capture();
    await embedTexts(f, T("openai"), "text-embedding-3-small", ["a"], "document", { dimensions: 256 });
    await embedTexts(f, T("jina"), "jina-embeddings-v3", ["a"], "query", { dimensions: 512 });
    await embedTexts(f, T("voyage"), "voyage-3.5", ["a"], "query", { dimensions: 1024 });
    await embedTexts(f, T("cohere"), "embed-v4.0", ["a"], "document", { dimensions: 1536 });
    await embedTexts(f, T("mistral"), "codestral-embed", ["a"], "document", { dimensions: 256 });
    await embedTexts(f, T("gemini"), "gemini-embedding-001", ["a", "b"], "query", { dimensions: 768 });
    await embedTexts(f, T("workers_ai", "", { accountId: "acc" }), "@cf/baai/bge-m3", ["a"]);
    expect(calls[0]).toMatchObject({ url: "https://api.openai.com/v1/embeddings", body: { dimensions: 256 } });
    expect(calls[1].body).toMatchObject({ task: "retrieval.query", dimensions: 512 });
    expect(calls[2].body).toMatchObject({ input_type: "query", output_dimension: 1024 });
    expect(calls[3]).toMatchObject({ url: "https://api.cohere.com/v2/embed", body: { input_type: "search_document", output_dimension: 1536 } });
    expect(calls[4].body).toMatchObject({ output_dimension: 256 });
    expect(calls[5].body.requests[0]).toMatchObject({ taskType: "RETRIEVAL_QUERY", outputDimensionality: 768 });
    expect(calls[6].url).toBe("https://api.cloudflare.com/client/v4/accounts/acc/ai/run/@cf/baai/bge-m3");
    expect(calls[0].body).not.toHaveProperty("task");
  });

  it("uses the Workers AI binding when present (no REST call)", async () => {
    const { calls, f } = capture();
    const ai = { run: async (_m: string, input: any) => ({ data: input.text.map(() => [1, 0]) }) };
    const v = await embedTexts(f, { ...T("workers_ai", "", { accountId: "acc" }), apiKey: null }, "@cf/baai/bge-m3", ["x", "y"], "document", { ai });
    expect(v).toEqual([[1, 0], [1, 0]]);
    expect(calls).toHaveLength(0);
  });

  it("parses rerank results from Jina, Cohere and Voyage", async () => {
    const { calls, f } = capture();
    for (const [kind, base] of [["jina", "https://api.jina.ai/v1"], ["cohere", "https://api.cohere.com"], ["voyage", "https://api.voyageai.com/v1"]]) {
      const r = await rerankDocuments(f, { type: "rerank", kind, baseUrl: base, apiKey: "k", config: {} }, "m", "q", ["a", "b"], 2);
      expect(r).toEqual([{ index: 1, score: 0.8 }, { index: 0, score: 0.3 }]);
    }
    expect(calls.map((c) => c.url)).toEqual(["https://api.jina.ai/v1/rerank", "https://api.cohere.com/v2/rerank", "https://api.voyageai.com/v1/rerank"]);
    expect(calls[2].body.top_k).toBe(2);
  });
});

// ---------- integration ----------

async function uploadDoc(colId: string, name: string, content: string, chunks: { content: string; metadata?: any }[], opts: { background?: boolean } = {}) {
  const c = h.client();
  const r = await c.post(`/kb/collections/${colId}/documents`, { name, size: new TextEncoder().encode(content).length, mime: "text/markdown" });
  expect(r.status).toBe(201);
  const t = r.body.ticket;
  expect(t.method).toBe("put");
  expect((await s3.fetch(t.url, { method: "PUT", body: content, headers: t.headers })).status).toBe(200);
  expect((await c.post(`/uploads/${t.fileId}/complete`, {})).status).toBe(200);
  const s = await c.post(`/kb/documents/${r.body.document.id}/chunks`, { start: 0, chunks, done: true, background: opts.background ?? false });
  expect(s.status).toBe(200);
  return r.body.document as { id: string; fileId: string };
}

async function drain(colId: string) {
  const c = h.client();
  for (let i = 0; i < 50; i++) {
    const st = await c.post(`/kb/collections/${colId}/index/step`, {});
    if (st.body.remaining === 0 && !st.body.skipped) return st.body;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("indexing did not finish");
}

describe("knowledge base API + retrieval", () => {
  let colId = "";
  let docA = { id: "", fileId: "" };

  it("creates a collection bound to an embedding model (dimension probed) and rejects a bad one", async () => {
    const c = h.client();
    const bad = await c.post("/kb/collections", { name: "壞", embeddingProviderId: embProvider, embeddingModel: "emb-small", requestedDim: 64 });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toContain("8 維");
    const r = await c.post("/kb/collections", { name: "客服手冊", description: "退換貨與保固", projectId: pid, embeddingProviderId: embProvider, embeddingModel: "emb-large", chunkSize: 500 });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ embeddingDim: 64, indexStatus: "idle", projectId: pid, chunkSize: 500 });
    colId = r.body.id;
  });

  it("browser-direct upload to kb/{collection}/, chunk ingest, batched embedding steps", async () => {
    const chunksA = chunkDocument({ format: "markdown", segments: [{ text: "# 退貨政策\n商品於七天內可以申請退貨，需保留發票。\n\n# 保固\n電子產品享有一年保固，人為損壞除外。" }] });
    docA = await uploadDoc(colId, "policy.md", "# 退貨政策 …", chunksA);
    const filler = Array.from({ length: 70 }, (_, i) => ({ content: `第 ${i} 則雜項說明：營業時間與門市地址資訊 ${i}` }));
    await uploadDoc(colId, "misc.md", "filler", [{ content: "配送：訂單成立後三個工作天內出貨。" }, ...filler]);
    expect([...s3.objects.keys()].filter((k) => k.startsWith(`kb/${colId}/`))).toHaveLength(2);

    const before = await h.client().get(`/kb/collections/${colId}/progress`);
    expect(before.body).toMatchObject({ total: chunksA.length + 71, done: 0 });
    embedBodies.length = 0;
    const done = await drain(colId);
    expect(done).toMatchObject({ remaining: 0, done: chunksA.length + 71, status: "idle" });
    expect(Math.max(...embedBodies.map((b) => b.input.length))).toBeLessThanOrEqual(32); // batched
    const docs = await h.client().get(`/kb/collections/${colId}/documents`);
    expect(docs.body.find((d: any) => d.name === "policy.md")).toMatchObject({ status: "ready", chunkCount: chunksA.length, embeddedCount: chunksA.length });
  });

  it("re-posting a chunk batch is idempotent and drops stale tail chunks", async () => {
    const c = h.client();
    const d = await c.post(`/kb/collections/${colId}/documents`, { name: "tmp.txt", size: 1 });
    const id = d.body.document.id;
    await c.post(`/kb/documents/${id}/chunks`, { start: 0, chunks: [{ content: "一" }, { content: "二" }, { content: "三" }], done: true, background: false });
    await c.post(`/kb/documents/${id}/chunks`, { start: 0, chunks: [{ content: "一" }, { content: "貳" }], done: true, background: false });
    const v = await c.get(`/kb/documents/${id}/chunks`);
    expect(v.body.chunks.map((x: any) => x.content)).toEqual(["一", "貳"]);
    expect(v.body.chunks.every((x: any) => x.embedded === false)).toBe(true);
    expect((await c.req("DELETE", `/kb/documents/${id}`)).status).toBe(200);
  });

  it("hybrid search (vector + CJK full-text, RRF) finds the right chunk; rerank reorders", async () => {
    const c = h.client();
    const r = await c.post("/kb/search", { query: "可以退貨嗎", collectionIds: [colId], topK: 3 });
    expect(r.status).toBe(200);
    expect(r.body.modes.sort()).toEqual(["text", "vector"]);
    expect(r.body.hits[0]).toMatchObject({ source: "policy.md", collection: "客服手冊" });
    expect(r.body.hits[0].content).toContain("七天內");
    expect(r.body.hits[0].via.sort()).toEqual(["text", "vector"]);

    // full-text alone still works when the embedding call fails
    failEmbeds = 2;
    const t = await c.post("/kb/search", { query: "保固", collectionIds: [colId] });
    failEmbeds = 0;
    expect(t.body.modes).toEqual(["text"]);
    expect(t.body.notes[0]).toContain("向量檢索失敗");
    expect(t.body.hits[0].content).toContain("一年保固");

    // rerank
    expect((await c.req("PATCH", `/kb/collections/${colId}`, { rerankProviderId: rerankProvider, rerankModel: "jina-reranker-v2-base-multilingual" })).status).toBe(200);
    rerankCalls = 0;
    const rr = await c.post("/kb/search", { query: "售後服務", collectionIds: [colId], topK: 2 });
    expect(rerankCalls).toBe(1);
    expect(rr.body.modes).toContain("rerank");
    if (rr.body.hits.length) expect(rr.body.hits[0].via).toContain("rerank");
  });

  it("kb_search tool: project collections auto-attached, citations + source + score, length-capped", async () => {
    h.script = [callsReply([{ id: "k1", name: "kb_search", args: { query: "退貨期限", top_k: 3 } }]), textReply("七天內可退貨 [1]")];
    const r = await h.chat({ content: "退貨期限是多久？", projectId: pid });
    expect(r.status).toBe(200);
    expect(h.llmBodies[0].messages[0].content).toContain("# 知識庫");
    expect(h.llmBodies[0].messages[0].content).toContain("客服手冊（本專案）");
    const toolMsg = h.llmBodies[1].messages.find((m: any) => m.role === "tool");
    const out = JSON.parse(toolMsg.content);
    expect(out.results[0]).toMatchObject({ ref: "[1]", source: "policy.md", collection: "客服手冊" });
    expect(out.results[0].location).toContain("退貨政策");
    expect(typeof out.results[0].score).toBe("number");
    expect(out.citation).toContain("[n]");
    expect(JSON.stringify(out.results).length).toBeLessThan(14_000);

    // outside the project the project collection is not attached
    h.script = [callsReply([{ id: "k2", name: "kb_search", args: { query: "退貨" } }]), textReply("無")];
    await h.chat({ content: "退貨？" });
    const out2 = JSON.parse(h.llmBodies[3].messages.find((m: any) => m.role === "tool").content);
    expect(out2.results).toEqual([]);
    expect(out2.note).toContain("沒有可用的知識庫");
  });

  it("changing the model triggers a resumable background re-index", async () => {
    const c = h.client();
    const p = await c.req("PATCH", `/kb/collections/${colId}`, { embeddingModel: "emb-small", embeddingProviderId: embProvider });
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ embeddingDim: 8, indexStatus: "reindexing", embeddedCount: 0 });
    // background (in-process) worker finishes; poll progress like the UI does
    let prog: any;
    for (let i = 0; i < 100; i++) {
      prog = (await c.get(`/kb/collections/${colId}/progress`)).body;
      if (prog.remaining === 0 && !prog.busy) break;
      await new Promise((r) => setTimeout(r, 30));
    }
    expect(prog).toMatchObject({ remaining: 0, status: "idle" });
    const dims = await h.t.database.query<{ d: number }>(`SELECT DISTINCT embedding_dim AS d FROM kb_chunks WHERE collection_id = $1`, [colId]);
    expect(dims.map((x) => x.d)).toEqual([8]);
    const idx = await h.t.database.query(`SELECT indexname FROM pg_indexes WHERE indexname = 'kb_chunks_emb_hnsw_8'`);
    expect(idx).toHaveLength(1);
  });

  it("indexing failure → status error; resume continues where it stopped; lease blocks a second worker", async () => {
    const c = h.client();
    await c.req("PATCH", `/kb/collections/${colId}`, { embeddingModel: "emb-large", embeddingProviderId: embProvider });
    // wait for the background worker started by PATCH, then make the next run fail
    for (let i = 0; i < 100; i++) {
      const pr = (await c.get(`/kb/collections/${colId}/progress`)).body;
      if (!pr.busy && pr.remaining === 0) break;
      await new Promise((r) => setTimeout(r, 30));
    }
    await h.t.database.query(`UPDATE kb_chunks SET embedding = NULL WHERE collection_id = $1`, [colId]);
    failEmbeds = 2; // first batch + its retry
    const st = await c.post(`/kb/collections/${colId}/index/step`, {});
    expect(st.body.status).toBe("error");
    expect(st.body.error).toContain("503");
    // a held lease makes another worker skip
    await h.t.database.db.update(kbCollections).set({ indexLeaseUntil: new Date(Date.now() + 60_000) }).where(eq(kbCollections.id, colId));
    const sk = await indexStep({ database: h.t.database, encKey: new Uint8Array(32), fetch: h.fetch }, colId, 5000);
    expect(sk.skipped).toBe(true);
    await h.t.database.db.update(kbCollections).set({ indexLeaseUntil: null }).where(eq(kbCollections.id, colId));
    const fin = await drain(colId);
    expect(fin).toMatchObject({ remaining: 0, status: "idle", error: null });
  });

  it("internal indexer endpoint requires the HMAC token", async () => {
    const r = await h.client().post(`/internal/kb/${colId}/index`, {});
    expect(r.status).toBe(401);
  });

  it("chunk viewer and document delete (S3 object + chunks removed)", async () => {
    const c = h.client();
    const v = await c.get(`/kb/documents/${docA.id}/chunks?limit=1`);
    expect(v.body.chunks).toHaveLength(1);
    expect(v.body.chunks[0].embedded).toBe(true);
    const key = [...s3.objects.keys()].find((k) => k.startsWith(`kb/${colId}/`) && k.endsWith("policy.md"))!;
    expect((await c.req("DELETE", `/kb/documents/${docA.id}`)).status).toBe(200);
    expect(s3.objects.has(key)).toBe(false);
    const left = await h.t.database.db.select().from(kbChunks).where(eq(kbChunks.documentId, docA.id));
    expect(left).toHaveLength(0);
  });

  it("deleting a collection purges its S3 prefix", async () => {
    const c = h.client();
    expect((await c.req("DELETE", `/kb/collections/${colId}`)).status).toBe(200);
    expect([...s3.objects.keys()].some((k) => k.startsWith(`kb/${colId}/`))).toBe(false);
    expect((await c.get(`/kb/collections/${colId}`)).status).toBe(404);
  });

  it("a collection without an embedding model still works with full-text only", async () => {
    const c = h.client();
    const col = (await c.post("/kb/collections", { name: "純文字" })).body;
    expect(col.embeddingDim).toBeNull();
    await uploadDoc(col.id, "a.txt", "x", [{ content: "東京的拉麵很好吃" }, { content: "大阪的章魚燒" }]);
    const r = await c.post("/kb/search", { query: "拉麵", collectionIds: [col.id] });
    expect(r.body.modes).toEqual(["text"]);
    expect(r.body.hits).toHaveLength(1);
    expect(r.body.hits[0].content).toContain("拉麵");
  });
});

describe("conversation search uses the CJK tokenizer", () => {
  it("matches partial Chinese words, non-contiguous terms, and backfills old rows", async () => {
    h.script = [textReply("好的，我們來討論向量資料庫的索引策略。")];
    await h.chat({ content: "請說明 pgvector 的 HNSW 索引" });
    const c = h.client();
    const s1 = await c.get(`/conversations?q=${encodeURIComponent("資料庫")}`);
    expect(s1.body.length).toBe(1);
    expect(s1.body[0].snippet ?? JSON.stringify(s1.body[0])).toContain("資料庫");
    const s2 = await c.get(`/conversations?q=${encodeURIComponent("索引 向量")}`);
    expect(s2.body.length).toBe(1);
    const s3r = await c.get(`/conversations?q=${encodeURIComponent("hnsw")}`);
    expect(s3r.body.length).toBe(1);
    const none = await c.get(`/conversations?q=${encodeURIComponent("知識圖譜")}`);
    expect(none.body.length).toBe(0);
    // pre-M7 rows (no search_tsv) are backfilled on search
    await h.t.database.db.update(messages).set({ searchTsv: null });
    const s4 = await c.get(`/conversations?q=${encodeURIComponent("策略")}`);
    expect(s4.body.length).toBe(1);
    const nulls = await h.t.database.query(`SELECT id FROM messages WHERE search_tsv IS NULL AND search_text IS NOT NULL`);
    expect(nulls).toHaveLength(0);
  });
});
