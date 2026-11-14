/**
 * Knowledge base (RAG) shared types + the chunker. Chunking runs in the BROWSER (files are parsed client-side,
 * the server only stores and embeds chunks) and is unit-tested on the server side through this module.
 */

// ---------- DTOs ----------

export interface KbCollectionDTO {
  id: string;
  projectId: string | null;
  name: string;
  description: string | null;
  embeddingProviderId: string | null;
  embeddingProviderName: string | null;
  embeddingModel: string | null;
  embeddingDim: number | null;
  /** Requested output dimension (null = model default). */
  requestedDim: number | null;
  rerankProviderId: string | null;
  rerankModel: string | null;
  chunkSize: number;
  chunkOverlap: number;
  indexStatus: "idle" | "indexing" | "reindexing" | "error";
  indexError: string | null;
  documentCount: number;
  chunkCount: number;
  /** Chunks embedded with the collection's current model + dimension. */
  embeddedCount: number;
  /** True while a worker holds the index lease (another tab / background job is embedding). */
  busy: boolean;
  updatedAt: string;
}

export interface KbDocumentDTO {
  id: string;
  collectionId: string;
  fileId: string | null;
  name: string;
  mime: string | null;
  size: number;
  /** uploading | parsing | ready | error (ready = chunks stored; see embeddedCount for vectors) */
  status: string;
  error: string | null;
  chunkCount: number;
  embeddedCount: number;
  createdAt: string;
}

export interface KbChunkDTO {
  id: string;
  chunkIndex: number;
  content: string;
  metadata: Record<string, unknown> | null;
  embedded: boolean;
}

export interface KbIndexProgress {
  collectionId: string;
  status: KbCollectionDTO["indexStatus"];
  total: number;
  done: number;
  remaining: number;
  busy: boolean;
  error: string | null;
}

export interface KbSearchHit {
  chunkId: string;
  documentId: string | null;
  collectionId: string;
  collection: string;
  source: string;
  chunkIndex: number;
  content: string;
  metadata: Record<string, unknown> | null;
  score: number;
  /** Which retrievers found it (vector / text) and whether it was reranked. */
  via: string[];
}

// ---------- chunking ----------

export interface ChunkOptions {
  /** Target max characters per chunk (CJK ≈ 1 token/char, English ≈ 4 chars/token). */
  size?: number;
  /** Characters repeated from the end of the previous chunk (same section only). */
  overlap?: number;
}

export interface Chunk {
  content: string;
  metadata: Record<string, unknown>;
}

/** Output of a browser-side parser. `segments` keep page boundaries for PDFs. */
export interface ParsedDocument {
  format: "markdown" | "text" | "code" | "csv";
  segments: { text: string; page?: number }[];
  /** CSV only: header row repeated in every chunk. */
  csvHeader?: string;
}

export const KB_DEFAULT_CHUNK_SIZE = 1000;
export const KB_DEFAULT_CHUNK_OVERLAP = 150;
export const KB_MAX_CHUNK_SIZE = 8000;

function opts(o?: ChunkOptions) {
  const size = Math.min(KB_MAX_CHUNK_SIZE, Math.max(100, Math.floor(o?.size ?? KB_DEFAULT_CHUNK_SIZE)));
  const overlap = Math.min(Math.floor(size / 2), Math.max(0, Math.floor(o?.overlap ?? KB_DEFAULT_CHUNK_OVERLAP)));
  return { size, overlap };
}

const SENTENCE_END = /(?<=[。！？!?；;])|(?<=\.)(?=\s)|\n/u;

/** Split an over-long block: sentences first, then hard cuts. Never returns a piece longer than `size`. */
function splitLong(block: string, size: number): string[] {
  if (block.length <= size) return [block];
  const out: string[] = [];
  let cur = "";
  for (const sentence of block.split(SENTENCE_END)) {
    if (!sentence) continue;
    if (sentence.length > size) {
      if (cur) out.push(cur), (cur = "");
      for (let i = 0; i < sentence.length; i += size) out.push(sentence.slice(i, i + size));
      continue;
    }
    if (cur.length + sentence.length > size) out.push(cur), (cur = "");
    cur += sentence;
  }
  if (cur) out.push(cur);
  return out;
}

/** Tail of `text` of about `n` chars, starting at a sentence/word boundary when one is near. */
export function overlapTail(text: string, n: number): string {
  if (n <= 0 || !text) return "";
  if (text.length <= n) return text;
  let tail = text.slice(text.length - n);
  const m = tail.slice(0, Math.floor(n / 2)).search(/[。！？!?；;.\n]\s*|\s/u);
  if (m >= 0) tail = tail.slice(m).replace(/^[。！？!?；;.\s]+/u, "");
  return tail;
}

/** Pack blocks (paragraphs / lines / rows) into chunks ≤ size with overlap. */
function pack(blocks: string[], size: number, overlap: number, joiner: string): string[] {
  const pieces = blocks.flatMap((b) => splitLong(b, size));
  const out: string[] = [];
  let cur = "";
  for (const p of pieces) {
    if (cur && cur.length + joiner.length + p.length > size) {
      out.push(cur);
      const tail = overlapTail(cur, overlap);
      cur = tail && tail.length + joiner.length + p.length <= size ? tail + joiner + p : p;
    } else {
      cur = cur ? cur + joiner + p : p;
    }
  }
  if (cur.trim()) out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

const paragraphs = (t: string) => t.split(/\n[ \t]*\n+/).map((p) => p.replace(/\s+$/g, "")).filter((p) => p.trim());

interface Section {
  headings: string[];
  text: string;
}

/** Split markdown by ATX headings (ignoring fenced code), tracking the heading path. */
export function markdownSections(md: string): Section[] {
  const sections: Section[] = [];
  const stack: { level: number; title: string }[] = [];
  let buf: string[] = [];
  let fence: string | null = null;
  const flush = () => {
    const text = buf.join("\n").trim();
    if (text) sections.push({ headings: stack.map((s) => s.title), text });
    buf = [];
  };
  for (const line of md.replace(/\r\n?/g, "\n").split("\n")) {
    const f = line.match(/^\s{0,3}(```+|~~~+)/);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      buf.push(line);
      continue;
    }
    const h = !fence && line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) {
      flush();
      const level = h[1].length;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, title: h[2] });
      continue;
    }
    buf.push(line);
  }
  flush();
  return sections;
}

/** Keep fenced code blocks whole as paragraphs (they may contain blank lines). */
function mdBlocks(text: string): string[] {
  const out: string[] = [];
  let fence: string | null = null;
  let buf: string[] = [];
  const lines = text.split("\n");
  const flush = () => {
    if (buf.length) out.push(...(fence === null ? paragraphs(buf.join("\n")) : [buf.join("\n")]));
    buf = [];
  };
  for (const line of lines) {
    const f = line.match(/^\s{0,3}(```+|~~~+)/);
    if (f && !fence) {
      flush();
      fence = f[1][0];
      buf.push(line);
    } else if (f && fence && f[1][0] === fence) {
      buf.push(line);
      out.push(buf.join("\n"));
      buf = [];
      fence = null;
    } else buf.push(line);
  }
  if (fence) fence = null;
  flush();
  return out.filter((b) => b.trim());
}

/** Minimal RFC 4180 CSV record splitter (quoted fields may contain newlines). Returns raw record lines. */
export function csvRecords(csv: string): string[] {
  const out: string[] = [];
  let start = 0;
  let q = false;
  const s = csv.replace(/\r\n?/g, "\n");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') q = !q;
    else if (ch === "\n" && !q) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  if (start < s.length) out.push(s.slice(start));
  return out.filter((r) => r.trim());
}

/** Chunk a parsed document. Every chunk's metadata carries what's known: headings, page, line range, rows. */
export function chunkDocument(doc: ParsedDocument, o?: ChunkOptions): Chunk[] {
  const { size, overlap } = opts(o);
  const chunks: Chunk[] = [];
  for (const seg of doc.segments) {
    const page = seg.page !== undefined ? { page: seg.page } : {};
    if (doc.format === "markdown") {
      for (const sec of markdownSections(seg.text)) {
        const crumb = sec.headings.length ? sec.headings.join(" > ") : "";
        const prefix = crumb ? `${crumb}\n\n` : "";
        for (const body of pack(mdBlocks(sec.text), Math.max(100, size - prefix.length), overlap, "\n\n")) {
          chunks.push({ content: prefix + body, metadata: { ...page, ...(crumb ? { headings: sec.headings } : {}) } });
        }
      }
    } else if (doc.format === "csv") {
      const header = doc.csvHeader ?? "";
      const rows = csvRecords(seg.text);
      const budget = Math.max(100, size - header.length - 1);
      let cur: string[] = [];
      let len = 0;
      let first = 1;
      const emit = (end: number) => {
        if (cur.length) chunks.push({ content: (header ? header + "\n" : "") + cur.join("\n"), metadata: { ...page, rows: [first, end] } });
      };
      rows.forEach((r, i) => {
        const row = r.length > budget ? r.slice(0, budget) : r;
        if (cur.length && len + row.length + 1 > budget) {
          emit(i);
          cur = [];
          len = 0;
          first = i + 1;
        }
        cur.push(row);
        len += row.length + 1;
      });
      emit(rows.length);
    } else if (doc.format === "code") {
      // line-based packing keeps line numbers for citations
      const lines = seg.text.replace(/\r\n?/g, "\n").split("\n");
      let start = 0;
      while (start < lines.length) {
        let end = start;
        let len = 0;
        while (end < lines.length && (end === start || len + lines[end].length + 1 <= size)) len += lines[end++].length + 1;
        const body = lines.slice(start, end).join("\n");
        if (body.trim()) chunks.push({ content: body.length > size ? body.slice(0, size) : body, metadata: { ...page, lines: [start + 1, end] } });
        if (end >= lines.length) break;
        // overlap: step back whole lines worth ~overlap chars
        let back = end;
        let ol = 0;
        while (back - 1 > start && ol + lines[back - 1].length + 1 <= overlap) ol += lines[--back].length + 1;
        start = back;
      }
    } else {
      for (const body of pack(paragraphs(seg.text.replace(/\r\n?/g, "\n")), size, overlap, "\n\n")) chunks.push({ content: body, metadata: { ...page } });
    }
  }
  return chunks;
}

/** File extension → parser format. Unknown text files are treated as plain text. */
export function kbFormatOf(name: string): ParsedDocument["format"] | "pdf" | "docx" | "html" | "json" | null {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (["md", "markdown", "mdx"].includes(ext)) return "markdown";
  if (["txt", "text", "log", "rst", "adoc", "org", "tex"].includes(ext)) return "text";
  if (["csv", "tsv"].includes(ext)) return "csv";
  if (ext === "pdf") return "pdf";
  if (ext === "docx") return "docx";
  if (["html", "htm", "xhtml"].includes(ext)) return "html";
  if (ext === "json" || ext === "jsonl" || ext === "ndjson") return "json";
  if (/^(js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|java|kt|kts|swift|c|h|cc|cpp|hpp|cs|php|scala|sh|bash|zsh|ps1|sql|r|lua|pl|dart|vue|svelte|css|scss|less|yaml|yml|toml|ini|xml|graphql|proto|dockerfile|makefile|gradle|tf)$/.test(ext)) return "code";
  return null;
}
