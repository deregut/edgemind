/**
 * kb_search [read]: hybrid (vector + full-text, RRF, optional rerank) retrieval over the knowledge bases
 * attached to this conversation: global collections + the project's own collections (auto-attached).
 * Returns numbered citations [n] with source file, collection, location and score; output is length-capped.
 */
import { attachedCollections, searchCollections } from "../rag/kb";
import type { Tool } from "../agent/tools";

const MAX_CHUNK_CHARS = 1500;
const MAX_TOTAL_CHARS = 12_000;

function locationOf(meta: Record<string, unknown> | null): string | undefined {
  if (!meta) return undefined;
  const parts: string[] = [];
  if (typeof meta.page === "number") parts.push(`第 ${meta.page} 頁`);
  if (Array.isArray(meta.headings) && meta.headings.length) parts.push(meta.headings.join(" > "));
  if (Array.isArray(meta.lines)) parts.push(`第 ${meta.lines[0]}–${meta.lines[1]} 行`);
  if (Array.isArray(meta.rows)) parts.push(`第 ${meta.rows[0]}–${meta.rows[1]} 列`);
  return parts.length ? parts.join("，") : undefined;
}

export const kbSearchTool: Tool = {
  name: "kb_search",
  description:
    "在知識庫中檢索相關段落（語意＋全文混合搜尋）。回傳帶編號的引用 [n]、來源檔名與分數；回答時請以 [n] 標註引用並附上來源檔名。" +
    "預設搜尋全域知識庫與本專案的知識庫；可用 collections 指定知識庫名稱或 id。",
  risk: "read",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "檢索問題或關鍵字（完整句子效果較好）" },
      collections: { type: "array", items: { type: "string" }, description: "限定的知識庫名稱或 id（選填）" },
      top_k: { type: "integer", minimum: 1, maximum: 20, description: "回傳段落數，預設 6" },
    },
    required: ["query"],
  },
  async execute(args, ctx) {
    const query = String(args?.query ?? "").trim().slice(0, 2000);
    if (!query) throw new Error("query 不可為空");
    const topK = Math.min(20, Math.max(1, Number.isInteger(args?.top_k) ? args.top_k : 6));
    let cols = await attachedCollections(ctx.database, ctx.projectId);
    if (!cols.length) return { results: [], note: "目前沒有可用的知識庫（請先在設定或專案中建立知識庫並上傳文件）" };
    if (Array.isArray(args?.collections) && args.collections.length) {
      const want = new Set(args.collections.map((x: unknown) => String(x).trim().toLowerCase()));
      const picked = cols.filter((c) => want.has(c.id.toLowerCase()) || want.has(c.name.toLowerCase()));
      if (!picked.length) return { results: [], note: `找不到指定的知識庫；可用：${cols.map((c) => c.name).join("、")}` };
      cols = picked;
    }
    const r = await searchCollections({ database: ctx.database, encKey: ctx.encKey, fetch: ctx.fetch, ai: ctx.ai }, cols, query, { topK });
    let used = 0;
    const results: Record<string, unknown>[] = [];
    for (const [i, h] of r.hits.entries()) {
      if (used >= MAX_TOTAL_CHARS) break;
      const room = Math.min(MAX_CHUNK_CHARS, MAX_TOTAL_CHARS - used);
      const text = h.content.length > room ? `${h.content.slice(0, room)}…` : h.content;
      used += text.length;
      const loc = locationOf(h.metadata);
      results.push({ ref: `[${i + 1}]`, source: h.source, collection: h.collection, ...(loc ? { location: loc } : {}), chunk: h.chunkIndex, score: h.score, content: text });
    }
    return {
      query,
      mode: r.modes.join("+") || "none",
      results,
      ...(results.length < r.hits.length ? { truncated: true } : {}),
      ...(r.notes.length ? { notes: r.notes } : {}),
      ...(results.length ? { citation: "回答時以 [n] 標註引用，並在結尾列出 [n] 來源檔名（與位置）" } : { note: "沒有找到相關段落" }),
    };
  },
};
