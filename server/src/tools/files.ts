/** file_* tools over the project's S3 file space (projects/{pid}/files/). Only offered inside a project. */
import type { Tool, ToolContext } from "../agent/tools";
import { matchGlob } from "../agent/glob";
import { decodeUtf8Window, FileStore, isTextMime, MAX_FILE_WRITE_BYTES, normalizePath, type FileRow } from "../storage/files";

export const READ_DEFAULT_BYTES = 32 * 1024;
export const READ_MAX_BYTES = 100 * 1024;

function store(ctx: ToolContext): { s: FileStore; pid: string } {
  if (!ctx.projectId) throw new Error("檔案工具只能在專案內的對話使用。");
  if (!ctx.storage) throw new Error("物件儲存未設定");
  return { s: ctx.storage, pid: ctx.projectId };
}

const enc = new TextEncoder();
const info = (r: FileRow) => ({ path: r.path, size: r.size, mime: r.mime, version: r.version, updatedAt: r.updatedAt.toISOString() });

async function readAllText(s: FileStore, r: FileRow, max = MAX_FILE_WRITE_BYTES): Promise<string> {
  if (r.size > max) throw new Error(`檔案過大（${r.size} 位元組），無法整份載入編輯`);
  if (!isTextMime(r.mime, r.path)) throw new Error("這不是文字檔");
  return new TextDecoder().decode(await s.readBytes(r));
}

export const fileListTool: Tool = {
  name: "file_list",
  description: "列出專案檔案（路徑、大小、版本）。可指定資料夾與是否遞迴。",
  risk: "read",
  projectOnly: true,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "資料夾路徑（預設根目錄）" },
      recursive: { type: "boolean", description: "是否包含子資料夾（預設 true）" },
    },
  },
  async execute(args, ctx) {
    const { s, pid } = store(ctx);
    const dir = args?.path ? normalizePath(args.path, { allowEmpty: true }) : "";
    const rows = await s.list(pid, dir, args?.recursive !== false);
    const limited = rows.slice(0, 500);
    return { path: dir || "/", count: rows.length, files: limited.map(info), ...(rows.length > limited.length ? { truncated: true } : {}) };
  },
};

export const fileReadTool: Tool = {
  name: "file_read",
  description: `讀取專案文字檔。大檔案分段讀取：offset 是位元組位置，每次最多 ${READ_MAX_BYTES / 1024} KB；用回傳的 nextOffset 繼續。`,
  risk: "read",
  projectOnly: true,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      offset: { type: "integer", minimum: 0, description: "起始位元組（預設 0）" },
      length: { type: "integer", minimum: 1, maximum: READ_MAX_BYTES, description: `讀取位元組數（預設 ${READ_DEFAULT_BYTES}）` },
    },
    required: ["path"],
  },
  async execute(args, ctx) {
    const { s, pid } = store(ctx);
    const r = await s.get(pid, normalizePath(args?.path));
    if (!isTextMime(r.mime, r.path)) return { ...info(r), binary: true, content: null, note: "二進位檔案無法以文字讀取。" };
    const offset = Math.max(0, Number.isInteger(args?.offset) ? args.offset : 0);
    const length = Math.min(READ_MAX_BYTES, Math.max(1, Number.isInteger(args?.length) ? args.length : READ_DEFAULT_BYTES));
    if (offset >= r.size) return { ...info(r), offset, nextOffset: null, content: "" };
    const end = Math.min(r.size, offset + length) - 1;
    const bytes = await s.readBytes(r, { start: offset, end });
    const last = end >= r.size - 1;
    const w = decodeUtf8Window(bytes, last);
    const nextOffset = last && w.used === bytes.length ? null : offset + w.used;
    return { ...info(r), offset: offset + w.skipped, nextOffset, content: w.text };
  },
};

export const fileWriteTool: Tool = {
  name: "file_write",
  description: "建立或覆寫專案文字檔（舊內容自動保留為歷史版本）。mode=append 會接在檔尾。",
  risk: "write",
  projectOnly: true,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
      mode: { type: "string", enum: ["overwrite", "append"], description: "預設 overwrite" },
    },
    required: ["path", "content"],
  },
  async execute(args, ctx) {
    const { s, pid } = store(ctx);
    const path = normalizePath(args?.path);
    let content = String(args?.content ?? "");
    if (args?.mode === "append") {
      const cur = await s.find(pid, path);
      if (cur && cur.status === "ready") content = (await readAllText(s, cur)) + content;
    }
    const r = await s.write(pid, path, enc.encode(content), undefined, ctx.conversationId);
    return { ok: true, ...info(r) };
  },
};

export const fileEditTool: Tool = {
  name: "file_edit",
  description: "以字串取代編輯專案文字檔：old_string 必須完全符合且唯一（除非 replace_all=true）。",
  risk: "write",
  projectOnly: true,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      old_string: { type: "string" },
      new_string: { type: "string" },
      replace_all: { type: "boolean" },
    },
    required: ["path", "old_string", "new_string"],
  },
  async execute(args, ctx) {
    const { s, pid } = store(ctx);
    const r = await s.get(pid, normalizePath(args?.path));
    const oldS = String(args?.old_string ?? "");
    const newS = String(args?.new_string ?? "");
    if (!oldS) throw new Error("old_string 不可為空");
    const text = await readAllText(s, r);
    const count = text.split(oldS).length - 1;
    if (count === 0) throw new Error("找不到 old_string，請先用 file_read 確認目前內容");
    if (count > 1 && !args?.replace_all) throw new Error(`old_string 出現 ${count} 次；請提供更多上下文讓它唯一，或設定 replace_all=true`);
    const next = args?.replace_all ? text.split(oldS).join(newS) : text.replace(oldS, () => newS);
    const w = await s.write(pid, r.path, enc.encode(next), r.mime ?? undefined, ctx.conversationId);
    return { ok: true, replacements: args?.replace_all ? count : 1, ...info(w) };
  },
};

export const fileDeleteTool: Tool = {
  name: "file_delete",
  description: "刪除專案檔案（內容保留在歷史版本中，可從檔案管理還原）。",
  risk: "write",
  projectOnly: true,
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  async execute(args, ctx) {
    const { s, pid } = store(ctx);
    const r = await s.delete(pid, args?.path);
    return { ok: true, deleted: r.path, version: r.version };
  },
};

export const fileSearchTool: Tool = {
  name: "file_search",
  description: "在專案檔案中搜尋：比對檔名與文字內容，回傳符合的行（含行號）。glob 可限制範圍，例如 docs/**/*.md。",
  risk: "read",
  projectOnly: true,
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "要找的文字（不分大小寫），regex=true 時為正規表示式" },
      glob: { type: "string", description: "路徑篩選（glob）" },
      regex: { type: "boolean" },
      max_results: { type: "integer", minimum: 1, maximum: 200, description: "最多回傳幾行（預設 50）" },
    },
    required: ["query"],
  },
  targets: (args) => (typeof args?.glob === "string" ? { paths: [args.glob] } : {}),
  async execute(args, ctx) {
    const { s, pid } = store(ctx);
    const q = String(args?.query ?? "");
    if (!q) throw new Error("query 不可為空");
    let re: RegExp;
    try {
      re = args?.regex ? new RegExp(q, "i") : new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    } catch (e) {
      throw new Error(`正規表示式錯誤：${(e as Error).message}`);
    }
    const max = Math.min(200, Math.max(1, Number.isInteger(args?.max_results) ? args.max_results : 50));
    let rows = await s.list(pid);
    if (typeof args?.glob === "string" && args.glob) rows = rows.filter((r) => matchGlob(r.path, args.glob));
    const nameMatches = rows.filter((r) => re.test(r.path)).map((r) => r.path).slice(0, 50);
    const matches: { path: string; line: number; text: string }[] = [];
    let scanned = 0;
    const skipped: string[] = [];
    for (const r of rows) {
      if (matches.length >= max) break;
      if (!isTextMime(r.mime, r.path)) continue;
      if (r.size > 1024 * 1024 || scanned >= 200) {
        skipped.push(r.path);
        continue;
      }
      scanned++;
      const lines = new TextDecoder().decode(await s.readBytes(r)).split(/\r?\n/);
      for (let i = 0; i < lines.length && matches.length < max; i++) {
        if (re.test(lines[i])) matches.push({ path: r.path, line: i + 1, text: lines[i].length > 300 ? `${lines[i].slice(0, 300)}…` : lines[i] });
      }
    }
    return { query: q, nameMatches, matches, ...(skipped.length ? { skipped: skipped.slice(0, 20), note: "部分檔案過大或超過掃描上限，未搜尋內容" } : {}) };
  },
};

export const fileTools = [fileListTool, fileReadTool, fileWriteTool, fileEditTool, fileDeleteTool, fileSearchTool];
