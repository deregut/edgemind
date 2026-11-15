/**
 * Client-side tools (M11a): code_run python runs here, in Pyodide inside a Web Worker. The server paused the run with
 * a `client` pending item (args = ClientToolArgs incl. resolved file mounts); we fetch the mounted files through
 * presigned GETs, run with a timeout (package loading not counted), upload new / changed files + figures straight to
 * S3 as project files, then POST the result to /api/runs/:id/client-results.
 */
import { useSyncExternalStore } from "react";
import { CODE_OUTPUT_CAP, type ClientToolArgs, type ClientToolResult, type PendingApprovalDTO } from "@edgemind/shared";
import { api } from "./api";
import { uploadFile } from "./upload";
import type { WorkerIn, WorkerOut } from "./pyodide.worker";

export type ClientPhase = "fetching" | "loading" | "packages" | "running" | "collecting" | "uploading" | "sending" | "done" | "error" | "cancelled";
export interface ClientStatus {
  phase: ClientPhase;
  message?: string;
}

// ---------- tiny status store (per toolCallId) ----------
const statuses = new Map<string, ClientStatus>();
const listeners = new Set<() => void>();
const cancels = new Map<string, () => void>();
function setStatus(id: string, s: ClientStatus) {
  statuses.set(id, s);
  listeners.forEach((l) => l());
}
export function useClientStatus(toolCallId: string): ClientStatus | undefined {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => statuses.get(toolCallId),
  );
}
export function cancelClientTool(toolCallId: string) {
  cancels.get(toolCallId)?.();
}

// ---------- worker ----------
let worker: Worker | null = null;
function getWorker(): Worker {
  if (!worker) worker = new Worker(new URL("./pyodide.worker.ts", import.meta.url), { type: "module" });
  return worker;
}
function killWorker() {
  worker?.terminate();
  worker = null;
}

const started = new Set<string>();

// ---------- completion listeners ----------
// The page that should continue the run may not be the one that started the tool (navigation / remount / resync),
// so completions are broadcast and the currently mounted chat page decides what to do with them.
export type ClientToolOutcome = { status: string; resume: boolean };
type DoneListener = (runId: string, toolCallId: string, outcome: ClientToolOutcome) => void;
const doneListeners = new Set<DoneListener>();
export function onClientToolDone(l: DoneListener): () => void {
  doneListeners.add(l);
  return () => void doneListeners.delete(l);
}
/** True when this tab already started (or finished) the item; false = nothing is executing it here. */
export function clientToolStarted(toolCallId: string): boolean {
  return started.has(toolCallId);
}
const MAX_OUTPUT_FILE = 5 * 1024 * 1024;
const MAX_UPLOAD_FILES = 50;
/** Loading Pyodide + packages from the CDN is not counted in the run timeout, but must not hang forever either. */
const LOAD_TIMEOUT_MS = 180_000;

function cap(s: string): { text: string; truncated: boolean } {
  return s.length <= CODE_OUTPUT_CAP ? { text: s, truncated: false } : { text: `${s.slice(0, CODE_OUTPUT_CAP)}\n…[已截斷，原長 ${s.length} 字元]`, truncated: true };
}

async function fetchMount(fileId: string): Promise<ArrayBuffer> {
  const { url } = await api<{ url: string }>(`/files/${fileId}/download`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下載掛載檔案失敗（HTTP ${res.status}）`);
  return res.arrayBuffer();
}

function runInWorker(id: string, code: string, files: { path: string; data: ArrayBuffer }[], timeoutMs: number, onPhase: (p: ClientPhase) => void, signal: AbortSignal) {
  return new Promise<Extract<WorkerOut, { type: "done" }>>((resolve, reject) => {
    const w = getWorker();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let loadTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      cleanup();
      killWorker();
      reject(new Error(`載入 Python 環境超過 ${LOAD_TIMEOUT_MS / 1000} 秒仍未完成（請確認可連線到 cdn.jsdelivr.net），已中止`));
    }, LOAD_TIMEOUT_MS);
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (loadTimer) clearTimeout(loadTimer);
      w.removeEventListener("message", onMsg);
      w.removeEventListener("error", onErr);
    };
    const onMsg = (ev: MessageEvent<WorkerOut>) => {
      const m = ev.data;
      if (m.id !== id) return;
      if (m.type === "status") {
        onPhase(m.phase);
        // The timeout covers execution only (Pyodide / package downloads can take a while on first use).
        if (m.phase === "running" && loadTimer) {
          clearTimeout(loadTimer);
          loadTimer = undefined;
        }
        if (m.phase === "running" && !timer) {
          timer = setTimeout(() => {
            cleanup();
            killWorker();
            reject(new Error(`執行超過 ${timeoutMs / 1000} 秒逾時，已中止（Python 環境已重設）`));
          }, timeoutMs);
        }
        return;
      }
      cleanup();
      resolve(m);
    };
    const onErr = (e: ErrorEvent) => {
      cleanup();
      killWorker();
      reject(new Error(`Pyodide Worker 錯誤：${e.message || "無法載入（請確認可連線到 cdn.jsdelivr.net）"}`));
    };
    signal.addEventListener("abort", () => {
      cleanup();
      killWorker();
      reject(new DOMException("cancelled", "AbortError"));
    }, { once: true });
    w.addEventListener("message", onMsg);
    w.addEventListener("error", onErr);
    const msg: WorkerIn = { type: "run", id, code, files };
    w.postMessage(msg, files.map((f) => f.data));
  });
}

/**
 * Execute one pending client item. Returns the /client-results response (resume = re-POST /chat to continue),
 * or null when it was already started in this tab (`force` re-runs an item whose earlier attempt could not report).
 * Every completion is also broadcast to `onClientToolDone` listeners.
 */
export async function runClientTool(runId: string, a: PendingApprovalDTO, opts: { force?: boolean } = {}): Promise<ClientToolOutcome | null> {
  if (started.has(a.toolCallId)) {
    if (!opts.force || cancels.has(a.toolCallId)) return null; // never run the same item twice at once
  }
  started.add(a.toolCallId);
  const r = await execClientTool(runId, a);
  if (r) doneListeners.forEach((l) => l(runId, a.toolCallId, r));
  return r;
}

async function execClientTool(runId: string, a: PendingApprovalDTO): Promise<ClientToolOutcome | null> {
  const args = a.args as ClientToolArgs;
  const ac = new AbortController();
  cancels.set(a.toolCallId, () => ac.abort());
  const phase = (p: ClientPhase, message?: string) => setStatus(a.toolCallId, { phase: p, message });
  try {
    if (args?.language !== "python") throw new Error("不支援的瀏覽器端工具");
    phase("fetching");
    const files = await Promise.all((args.mounts ?? []).map(async (m) => ({ path: m.path, data: await fetchMount(m.fileId) })));
    let out: Extract<WorkerOut, { type: "done" }>;
    try {
      out = await runInWorker(a.toolCallId, args.code, files, (args.timeoutSec ?? 30) * 1000, (p) => phase(p), ac.signal);
    } catch (e) {
      if ((e as Error).name === "AbortError") throw e;
      out = { type: "done", id: a.toolCallId, ok: false, stdout: "", stderr: "", result: null, error: (e as Error).message, files: [], durationMs: 0 };
    }

    phase("uploading");
    const saved: NonNullable<ClientToolResult["files"]> = [];
    const notSaved: NonNullable<ClientToolResult["notSaved"]> = [];
    const target = (path: string) => ({ scope: "project" as const, projectId: args.projectId, conversationId: args.conversationId, path });
    for (const [i, f] of out.files.entries()) {
      if (!args.projectId) notSaved.push({ path: f.path, reason: "不在專案中，產生的檔案沒有保存" });
      else if (i >= MAX_UPLOAD_FILES) notSaved.push({ path: f.path, reason: `一次最多保存 ${MAX_UPLOAD_FILES} 個檔案` });
      else if (f.data.byteLength > MAX_OUTPUT_FILE) notSaved.push({ path: f.path, reason: "超過單檔 5 MB 上限" });
      else {
        try {
          const dto = await uploadFile(new File([f.data], f.path.split("/").pop() || "file"), target(f.path), undefined, ac.signal);
          saved.push({ path: dto.path, fileId: dto.id, size: dto.size, kind: f.kind });
        } catch (e) {
          notSaved.push({ path: f.path, reason: `上傳失敗：${(e as Error).message}` });
        }
      }
    }
    const so = cap(out.stdout);
    const se = cap(out.stderr);
    const re = out.result === null ? { text: null as string | null, truncated: false } : cap(out.result);
    let fullOutput: ClientToolResult["fullOutput"] = null;
    if ((so.truncated || se.truncated || re.truncated) && args.projectId) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const text = `===== stdout =====\n${out.stdout}\n\n===== stderr =====\n${out.stderr}\n\n===== result =====\n${out.result ?? ""}`;
      try {
        const dto = await uploadFile(new File([text], "output.txt", { type: "text/plain" }), target(`code_run_outputs/${stamp}-python.txt`), undefined, ac.signal);
        fullOutput = { path: dto.path, fileId: dto.id };
      } catch {
        /* keep the truncated output only */
      }
    }
    const result: ClientToolResult = {
      ok: out.ok, stdout: so.text, stderr: se.text, result: re.text, error: out.error, durationMs: out.durationMs,
      ...(so.truncated ? { stdoutTruncated: true } : {}), ...(se.truncated ? { stderrTruncated: true } : {}),
      fullOutput, files: saved, ...(notSaved.length ? { notSaved } : {}),
    };
    phase("sending");
    const r = await api<{ status: string; resume: boolean }>(`/runs/${runId}/client-results`, { method: "POST", body: { toolCallId: a.toolCallId, result } });
    phase("done");
    return r;
  } catch (e) {
    if ((e as Error).name === "AbortError") {
      phase("cancelled");
      return api<ClientToolOutcome>(`/runs/${runId}/client-results`, { method: "POST", body: { toolCallId: a.toolCallId, cancel: true } }).catch((err) => {
        phase("error", `取消後回報失敗：${(err as Error).message}`);
        return null;
      });
    }
    phase("error", (e as Error).message);
    // Report the failure to the model instead of leaving the run hanging.
    return api<ClientToolOutcome>(`/runs/${runId}/client-results`, {
      method: "POST", body: { toolCallId: a.toolCallId, result: { ok: false, error: `瀏覽器端執行失敗：${(e as Error).message}` } },
    }).catch((err) => {
      phase("error", `${(e as Error).message}（回報結果也失敗：${(err as Error).message}）`);
      return null;
    });
  } finally {
    cancels.delete(a.toolCallId);
  }
}
