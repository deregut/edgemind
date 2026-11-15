/**
 * code_run [dangerous]:
 *   - javascript → server-side QuickJS-WASM (sandbox/quickjs.ts): no network / real FS, memory + stack + time limits,
 *     a virtual FS preloaded with the requested project files; files the script writes become new project file versions.
 *   - python → client-side tool: the agent loop pauses the run and the open browser tab runs it in Pyodide, then POSTs
 *     the result to /api/runs/:id/client-results (see routes/chat.ts). Background runs get a tool error instead.
 * Outputs are capped (CODE_OUTPUT_CAP chars each); when something was cut, the full output is saved as a project file.
 */
import {
  CODE_OUTPUT_CAP, CODE_RUN_DEFAULT_TIMEOUT_SEC, CODE_RUN_MAX_TIMEOUT_SEC, PYTHON_DEFAULT_TIMEOUT_SEC, PYTHON_MAX_TIMEOUT_SEC,
  type ClientMount, type ClientToolArgs,
} from "../../../shared/src/index";
import { ToolDeferred, type Tool, type ToolContext } from "../agent/tools";
import { runJavaScript, type VfsFile } from "../sandbox/quickjs";
import { normalizePath, type FileRow, type FileStore } from "../storage/files";

export const MAX_MOUNT_BYTES = 10 * 1024 * 1024;
export const MAX_MOUNT_FILES = 200;
const MAX_WRITE_FILES = 50;
const MAX_WRITE_TOTAL = 20 * 1024 * 1024;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const OUTPUT_DIR = "code_run_outputs";

export const PYTHON_NEEDS_BROWSER =
  "Python（Pyodide）在使用者的瀏覽器中執行，但這次執行是背景模式，沒有開啟的瀏覽器分頁可用。" +
  "請改用 code_run 的 javascript（伺服器端 QuickJS），或載入 e2b-sandbox Skill 透過 http_request 在雲端沙盒執行 Python。";

export function cap(s: string, max = CODE_OUTPUT_CAP): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false };
  return { text: `${s.slice(0, max)}\n…[已截斷，原長 ${s.length} 字元]`, truncated: true };
}

function clampTimeout(v: unknown, def: number, max: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : def;
  return Math.min(max, Math.max(1, n));
}

/** Resolve requested project paths (a trailing `/` mounts a whole folder) under the mount caps. */
export async function resolveMounts(store: FileStore, projectId: string, requested: unknown): Promise<FileRow[]> {
  if (requested === undefined || requested === null) return [];
  if (!Array.isArray(requested)) throw new Error("files 必須是專案檔案路徑陣列");
  const rows = new Map<string, FileRow>();
  for (const raw of requested.slice(0, MAX_MOUNT_FILES)) {
    const s = String(raw ?? "").trim();
    if (!s) continue;
    if (s.endsWith("/") || s === "." || s === "/") {
      const dir = s === "." || s === "/" ? "" : normalizePath(s.replace(/\/+$/, ""), { allowEmpty: true });
      for (const r of await store.list(projectId, dir, true)) rows.set(r.path, r);
    } else {
      const r = await store.get(projectId, normalizePath(s));
      rows.set(r.path, r);
    }
  }
  const list = [...rows.values()];
  if (list.length > MAX_MOUNT_FILES) throw new Error(`一次最多掛載 ${MAX_MOUNT_FILES} 個檔案`);
  const total = list.reduce((n, r) => n + r.size, 0);
  if (total > MAX_MOUNT_BYTES) throw new Error(`掛載的檔案共 ${(total / 1024 / 1024).toFixed(1)} MB，超過 ${MAX_MOUNT_BYTES / 1024 / 1024} MB 上限`);
  return list;
}

export function toClientMounts(rows: FileRow[]): ClientMount[] {
  return rows.map((r) => ({ path: r.path, fileId: r.id, size: r.size, mime: r.mime }));
}

async function saveFullOutput(ctx: ToolContext, sections: [string, string][]): Promise<{ path: string; fileId: string } | null> {
  if (!ctx.projectId || !ctx.storage) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = `${OUTPUT_DIR}/${stamp}-${(ctx.callId ?? "call").replace(/[^a-zA-Z0-9_-]/g, "").slice(-12) || "call"}.txt`;
  const text = sections.map(([k, v]) => `===== ${k} =====\n${v}`).join("\n\n");
  const row = await ctx.storage.write(ctx.projectId, path, new TextEncoder().encode(text.slice(0, MAX_FILE_BYTES)), "text/plain; charset=utf-8", ctx.conversationId);
  return { path: row.path, fileId: row.id };
}

function stringifyValue(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

async function runJs(args: any, ctx: ToolContext) {
  const code = String(args?.code ?? "");
  if (!code.trim()) throw new Error("code 不可為空");
  if (code.length > 200_000) throw new Error("程式碼過長（上限 200,000 字元）");
  const timeoutMs = clampTimeout(args?.timeoutSec, CODE_RUN_DEFAULT_TIMEOUT_SEC, CODE_RUN_MAX_TIMEOUT_SEC) * 1000;
  // The sync interpreter blocks the isolate: never start a run that cannot finish before the segment's hard deadline.
  if (ctx.deadline !== undefined && ctx.deadline - Date.now() - 1500 < timeoutMs) throw new ToolDeferred();

  const files = new Map<string, VfsFile>();
  const mounted = new Map<string, FileRow>();
  const notes: string[] = [];
  if (Array.isArray(args?.files) && args.files.length) {
    if (!ctx.projectId || !ctx.storage) throw new Error("files 只能在專案內的對話使用（掛載專案檔案）");
    for (const r of await resolveMounts(ctx.storage, ctx.projectId, args.files)) {
      files.set(r.path, { data: await ctx.storage.readBytes(r), mime: r.mime });
      mounted.set(r.path, r);
    }
  }

  const r = await runJavaScript(code, { timeoutMs, files, memoryLimitBytes: 64 * 1024 * 1024, maxVfsBytes: MAX_WRITE_TOTAL + MAX_MOUNT_BYTES });

  // Persist written / deleted files back to the project (new versions; old content kept).
  const saved: { path: string; size: number; version: number; fileId: string }[] = [];
  const notSaved: { path: string; reason: string }[] = [];
  const deletedSaved: string[] = [];
  const written = r.written; // unchanged content is a no-op in FileStore.write (same sha → no new version)
  if (written.length || r.deleted.length) {
    if (!ctx.projectId || !ctx.storage) {
      for (const p of written) notSaved.push({ path: p, reason: "不在專案中，寫入的檔案沒有保存" });
    } else {
      let total = 0;
      for (const p of written.slice(0, MAX_WRITE_FILES)) {
        const f = r.files.get(p)!;
        total += f.data.length;
        if (f.data.length > MAX_FILE_BYTES) notSaved.push({ path: p, reason: `超過單檔 ${MAX_FILE_BYTES / 1024 / 1024} MB 上限` });
        else if (total > MAX_WRITE_TOTAL) notSaved.push({ path: p, reason: `寫入總量超過 ${MAX_WRITE_TOTAL / 1024 / 1024} MB 上限` });
        else {
          try {
            const row = await ctx.storage.write(ctx.projectId, p, f.data, undefined, ctx.conversationId);
            saved.push({ path: row.path, size: row.size, version: row.version, fileId: row.id });
          } catch (e) {
            notSaved.push({ path: p, reason: (e as Error).message });
          }
        }
      }
      for (const p of written.slice(MAX_WRITE_FILES)) notSaved.push({ path: p, reason: `一次最多保存 ${MAX_WRITE_FILES} 個檔案` });
      for (const p of r.deleted) {
        if (!mounted.has(p)) continue; // only files that came from the project
        try {
          await ctx.storage.delete(ctx.projectId, p);
          deletedSaved.push(p);
        } catch (e) {
          notSaved.push({ path: p, reason: `刪除失敗：${(e as Error).message}` });
        }
      }
    }
  }

  const valueText = stringifyValue(r.value);
  const so = cap(r.stdout);
  const se = cap(r.stderr);
  const va = valueText === null ? { text: null as string | null, truncated: false } : cap(valueText);
  const truncated = so.truncated || se.truncated || va.truncated || r.stdoutDropped || r.stderrDropped;
  let fullOutput: { path: string; fileId: string } | null = null;
  if (truncated) {
    fullOutput = await saveFullOutput(ctx, [["stdout", r.stdout], ["stderr", r.stderr], ["result", valueText ?? ""]]).catch(() => null);
    if (!fullOutput) notes.push("輸出過長已截斷（不在專案中，無法保存完整輸出）。");
    if (r.stdoutDropped || r.stderrDropped) notes.push("主控台輸出超過 1 MB，之後的輸出已捨棄。");
  }
  return {
    ok: r.ok,
    language: "javascript",
    durationMs: r.durationMs,
    stdout: so.text,
    stderr: se.text,
    result: va.text,
    error: r.error,
    ...(r.errorKind ? { errorKind: r.errorKind } : {}),
    ...(r.errorKind === "timeout" ? { note: `超過 ${timeoutMs / 1000} 秒逾時，已中止` } : {}),
    ...(r.errorKind === "memory" ? { note: "超過 64 MB 記憶體上限，已中止" } : {}),
    ...(saved.length ? { savedFiles: saved } : {}),
    ...(deletedSaved.length ? { deletedFiles: deletedSaved } : {}),
    ...(notSaved.length ? { notSaved } : {}),
    ...(truncated ? { truncated: true } : {}),
    ...(fullOutput ? { fullOutput } : {}),
    ...(notes.length ? { notes } : {}),
  };
}

export const codeRunTool: Tool = {
  name: "code_run",
  description:
    "執行程式碼。language=javascript：在伺服器端 QuickJS 沙盒執行（ES2023、無網路、無 Node API、無 setTimeout；記憶體 64 MB；預設 10 秒、最長 30 秒）。" +
    "最後一個運算式的值會回傳；使用 await 時請用 return 回傳。可用 console.log；虛擬檔案系統：fs.readFile(path[, 'utf8'|'base64'|'binary'])、" +
    "fs.writeFile(path, string|Uint8Array[, 'base64'])、fs.listFiles(prefix)、fs.exists、fs.deleteFile。" +
    "files 參數可掛載專案檔案（路徑；結尾加 / 掛載整個資料夾；合計 ≤10 MB），寫入的檔案會存回專案（保留舊版本）。" +
    "language=python：在使用者瀏覽器的 Pyodide 執行（需要開啟中的聊天分頁，背景模式不可用；預設 30 秒、最長 120 秒；import numpy/pandas/matplotlib 會自動安裝，可用 micropip）；" +
    "掛載的檔案位於工作目錄，新增或修改的檔案與 matplotlib 圖表（自動存成 PNG）會上傳回專案。輸出各上限 20,000 字元，過長時完整輸出另存為專案檔。",
  risk: "dangerous",
  nonIdempotent: true,
  parameters: {
    type: "object",
    properties: {
      language: { type: "string", enum: ["javascript", "python"] },
      code: { type: "string", description: "要執行的程式碼" },
      files: { type: "array", items: { type: "string" }, description: "要掛載的專案檔案路徑（僅限專案內對話）" },
      timeoutSec: { type: "number", minimum: 1, maximum: PYTHON_MAX_TIMEOUT_SEC, description: "逾時秒數" },
    },
    required: ["language", "code"],
  },
  clientSide: (args) => args?.language === "python",
  clientUnavailable: PYTHON_NEEDS_BROWSER,
  async prepareClient(args, ctx): Promise<ClientToolArgs> {
    const code = String(args?.code ?? "");
    if (!code.trim()) throw new Error("code 不可為空");
    if (code.length > 200_000) throw new Error("程式碼過長（上限 200,000 字元）");
    let mounts: ClientMount[] = [];
    if (Array.isArray(args?.files) && args.files.length) {
      if (!ctx.projectId || !ctx.storage) throw new Error("files 只能在專案內的對話使用（掛載專案檔案）");
      mounts = toClientMounts(await resolveMounts(ctx.storage, ctx.projectId, args.files));
    }
    return {
      language: "python", code, ...(Array.isArray(args?.files) ? { files: args.files.map(String) } : {}),
      timeoutSec: pythonTimeout(args), projectId: ctx.projectId, conversationId: ctx.conversationId, mounts,
    };
  },
  targets: (args: any) => (Array.isArray(args?.files) ? { paths: args.files.filter((p: unknown) => typeof p === "string") } : {}),
  async execute(args, ctx) {
    if (args?.language === "javascript") return runJs(args, ctx);
    if (args?.language === "python") throw new Error("Python 由瀏覽器端執行（執行迴圈處理）");
    throw new Error("language 必須是 javascript 或 python");
  },
};

export function pythonTimeout(args: any): number {
  return clampTimeout(args?.timeoutSec, PYTHON_DEFAULT_TIMEOUT_SEC, PYTHON_MAX_TIMEOUT_SEC);
}
