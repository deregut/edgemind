/**
 * Browser-side document parsing for the knowledge base (the server never sees raw files):
 * txt / md / code / csv / json / html, PDF via pdfjs-dist (lazy, own worker), DOCX via mammoth (lazy) → HTML → Markdown.
 * Output feeds the shared chunker (heading-aware for markdown, page numbers for PDF, row ranges for CSV).
 */
import { chunkDocument, csvRecords, kbFormatOf, type Chunk, type ChunkOptions, type ParsedDocument } from "@edgemind/shared";

export const KB_ACCEPT = ".txt,.md,.markdown,.mdx,.csv,.tsv,.json,.jsonl,.html,.htm,.pdf,.docx,.log,.rst,.tex,.js,.mjs,.ts,.tsx,.jsx,.py,.go,.rs,.java,.kt,.swift,.c,.h,.cpp,.hpp,.cs,.php,.rb,.sh,.sql,.yaml,.yml,.toml,.ini,.xml,.css,.scss,.vue,.svelte";

const MAX_TEXT_BYTES = 50 * 1024 * 1024;

/** DOM → Markdown-ish text keeping headings (for heading-aware chunking), lists, tables and code. */
export function htmlToMarkdown(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script,style,noscript,template,svg,iframe,nav,footer").forEach((n) => n.remove());
  const out: string[] = [];
  const inline = (n: Node): string => {
    if (n.nodeType === Node.TEXT_NODE) return (n.textContent ?? "").replace(/\s+/g, " ");
    if (!(n instanceof Element)) return "";
    const t = n.tagName.toLowerCase();
    const inner = [...n.childNodes].map(inline).join("");
    if (t === "br") return "\n";
    if (t === "code") return `\`${inner}\``;
    if (t === "strong" || t === "b") return `**${inner.trim()}**`;
    if (t === "a") return inner;
    return inner;
  };
  const block = (el: Element) => {
    for (const n of [...el.childNodes]) {
      if (n.nodeType === Node.TEXT_NODE) {
        const s = (n.textContent ?? "").trim();
        if (s) out.push(s);
        continue;
      }
      if (!(n instanceof Element)) continue;
      const t = n.tagName.toLowerCase();
      const h = t.match(/^h([1-6])$/);
      if (h) out.push(`${"#".repeat(Number(h[1]))} ${inline(n).trim()}`);
      else if (t === "p" || t === "blockquote" || t === "figcaption" || t === "dt" || t === "dd") {
        const s = inline(n).trim();
        if (s) out.push(s);
      } else if (t === "pre") out.push("```\n" + (n.textContent ?? "").replace(/\n$/, "") + "\n```");
      else if (t === "ul" || t === "ol") {
        const items = [...n.children].filter((c) => c.tagName.toLowerCase() === "li");
        out.push(items.map((li, i) => `${t === "ol" ? `${i + 1}.` : "-"} ${inline(li).trim()}`).join("\n"));
      } else if (t === "table") {
        const rows = [...n.querySelectorAll("tr")].map((tr) => [...tr.children].map((td) => inline(td).trim().replace(/\|/g, "\\|")));
        if (rows.length) {
          const w = Math.max(...rows.map((r) => r.length));
          const line = (r: string[]) => `| ${[...r, ...Array(w - r.length).fill("")].join(" | ")} |`;
          out.push([line(rows[0]), `|${" --- |".repeat(w)}`, ...rows.slice(1).map(line)].join("\n"));
        }
      } else if (t === "img") {
        const alt = n.getAttribute("alt");
        if (alt) out.push(`[圖片：${alt}]`);
      } else block(n);
    }
  };
  block(doc.body);
  return out.join("\n\n");
}

async function parsePdf(file: File): Promise<ParsedDocument> {
  const pdfjs = await import("pdfjs-dist");
  const worker = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = worker;
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const segments: ParsedDocument["segments"] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    let text = "";
    let lastY: number | null = null;
    for (const item of content.items as { str?: string; transform?: number[]; hasEOL?: boolean }[]) {
      if (typeof item.str !== "string") continue;
      const y = item.transform?.[5] ?? null;
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 2 && !text.endsWith("\n")) text += "\n";
      text += item.str;
      if (item.hasEOL) text += "\n";
      lastY = y;
    }
    // paragraphs: blank line where a line ends with sentence punctuation
    text = text.replace(/([。！？.!?:：])\n/g, "$1\n\n").trim();
    if (text) segments.push({ text, page: i });
    page.cleanup();
  }
  await pdf.destroy();
  if (!segments.length) throw new Error("PDF 中沒有可擷取的文字（可能是掃描影像，需先 OCR）");
  return { format: "text", segments };
}

async function parseDocx(file: File): Promise<ParsedDocument> {
  const mod: any = await import("mammoth/mammoth.browser.js");
  const mammoth = mod.default ?? mod;
  const { value } = await mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() });
  return { format: "markdown", segments: [{ text: htmlToMarkdown(value) }] };
}

function parseJson(text: string): ParsedDocument {
  try {
    return { format: "code", segments: [{ text: JSON.stringify(JSON.parse(text), null, 2) }] };
  } catch {
    return { format: "code", segments: [{ text }] }; // JSONL / invalid: keep lines
  }
}

/** Parse a file into a ParsedDocument (throws a 正體中文 message for unsupported / empty files). */
export async function parseFile(file: File): Promise<ParsedDocument> {
  const fmt = kbFormatOf(file.name) ?? (file.type.startsWith("text/") ? "text" : null);
  if (!fmt) throw new Error("不支援的檔案類型（支援 txt、md、程式碼、csv、json、html、pdf、docx）");
  if (fmt === "pdf") return parsePdf(file);
  if (fmt === "docx") return parseDocx(file);
  if (file.size > MAX_TEXT_BYTES) throw new Error("文字檔超過 50 MB，請先分割");
  const text = (await file.text()).replace(/^\uFEFF/, "");
  if (!text.trim()) throw new Error("檔案沒有文字內容");
  if (fmt === "html") return { format: "markdown", segments: [{ text: htmlToMarkdown(text) }] };
  if (fmt === "json") return parseJson(text);
  if (fmt === "csv") {
    const rows = csvRecords(file.name.toLowerCase().endsWith(".tsv") ? text : text);
    return { format: "csv", csvHeader: rows[0] ?? "", segments: [{ text: rows.slice(1).join("\n") }] };
  }
  return { format: fmt, segments: [{ text }] };
}

export async function parseAndChunk(file: File, o: ChunkOptions): Promise<Chunk[]> {
  const chunks = chunkDocument(await parseFile(file), o);
  if (!chunks.length) throw new Error("切塊後沒有內容");
  return chunks;
}
