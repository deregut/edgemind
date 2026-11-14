/// <reference lib="webworker" />
/**
 * Pyodide in a module Web Worker (code_run python, client-side tool). Pyodide itself is loaded from the jsDelivr CDN
 * (browser-cached) once per worker; every run gets a fresh globals dict and its own working directory with the
 * mounted project files. After the run: matplotlib figures are saved as PNG, new / changed files are returned.
 * The main thread enforces the timeout by terminating the worker (no SharedArrayBuffer / cross-origin isolation needed).
 */
import { PYODIDE_INDEX_URL } from "@edgemind/shared";

export type WorkerIn = { type: "run"; id: string; code: string; files: { path: string; data: ArrayBuffer }[] };
export type WorkerOut =
  | { type: "status"; id: string; phase: "loading" | "packages" | "running" | "collecting" }
  | {
      type: "done"; id: string; ok: boolean; stdout: string; stderr: string; result: string | null; error: string | null;
      files: { path: string; data: ArrayBuffer; kind: "file" | "figure" }[]; durationMs: number;
    };

declare const self: DedicatedWorkerGlobalScope;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Py = any;
let pyodidePromise: Promise<Py> | null = null;

function getPyodide(): Promise<Py> {
  if (!pyodidePromise) {
    pyodidePromise = (async () => {
      const mod = await import(/* @vite-ignore */ `${PYODIDE_INDEX_URL}pyodide.mjs`);
      return mod.loadPyodide({ indexURL: PYODIDE_INDEX_URL });
    })().catch((e) => {
      pyodidePromise = null;
      throw e;
    });
  }
  return pyodidePromise;
}

const MAX_CAPTURE = 2_000_000;

self.onmessage = async (ev: MessageEvent<WorkerIn>) => {
  const msg = ev.data;
  if (msg.type !== "run") return;
  const { id } = msg;
  const post = (m: WorkerOut, transfer: Transferable[] = []) => self.postMessage(m, transfer);
  let stdout = "";
  let stderr = "";
  const started = Date.now();
  try {
    post({ type: "status", id, phase: "loading" });
    const py = await getPyodide();
    const FS = py.FS;
    const root = `/home/pyodide/run-${id.replace(/[^a-zA-Z0-9_-]/g, "")}`;
    FS.mkdirTree(root);
    const before = new Map<string, number>();
    for (const f of msg.files) {
      const full = `${root}/${f.path}`;
      FS.mkdirTree(full.slice(0, full.lastIndexOf("/")));
      const bytes = new Uint8Array(f.data);
      FS.writeFile(full, bytes);
      before.set(f.path, hash(bytes));
    }
    py.setStdout({ batched: (s: string) => { if (stdout.length < MAX_CAPTURE) stdout += s + "\n"; } });
    py.setStderr({ batched: (s: string) => { if (stderr.length < MAX_CAPTURE) stderr += s + "\n"; } });

    post({ type: "status", id, phase: "packages" });
    // numpy / pandas / matplotlib … are installed on import (micropip is importable for anything else).
    await py.loadPackagesFromImports(msg.code, { messageCallback: () => {}, errorCallback: (s: string) => { stderr += s + "\n"; } });
    py.runPython(`import os, sys\nos.environ["MPLBACKEND"] = "AGG"\nos.chdir(${JSON.stringify(root)})\nif ${JSON.stringify(root)} not in sys.path: sys.path.insert(0, ${JSON.stringify(root)})`);

    post({ type: "status", id, phase: "running" });
    const globals = py.globals.get("dict")();
    let result: string | null = null;
    let error: string | null = null;
    try {
      const value = await py.runPythonAsync(msg.code, { globals, filename: "main.py" });
      if (value !== undefined && value !== null) {
        const repr = py.globals.get("repr");
        result = String(repr(value));
        if (typeof value.destroy === "function") value.destroy();
        repr.destroy?.();
      }
    } catch (e) {
      error = String((e as Error)?.message ?? e);
    }

    post({ type: "status", id, phase: "collecting" });
    // Save open matplotlib figures as PNG (figures/fig-<run>-<n>.png).
    try {
      py.runPython(`
import sys
if "matplotlib.pyplot" in sys.modules:
    import matplotlib.pyplot as _plt, os as _os
    _nums = _plt.get_fignums()
    if _nums:
        _os.makedirs("figures", exist_ok=True)
        for _n in _nums:
            _plt.figure(_n).savefig(f"figures/fig-${id.slice(-6)}-{_n}.png", dpi=110, bbox_inches="tight")
        _plt.close("all")
`);
    } catch (e) {
      stderr += `（儲存圖表失敗：${String((e as Error)?.message ?? e)}）\n`;
    }
    globals.destroy?.();

    const files: { path: string; data: ArrayBuffer; kind: "file" | "figure" }[] = [];
    const walk = (dir: string, rel: string) => {
      for (const name of FS.readdir(dir) as string[]) {
        if (name === "." || name === ".." || name === "__pycache__") continue;
        const full = `${dir}/${name}`;
        const p = rel ? `${rel}/${name}` : name;
        const st = FS.stat(full);
        if (FS.isDir(st.mode)) walk(full, p);
        else if (FS.isFile(st.mode)) {
          const bytes: Uint8Array = FS.readFile(full);
          const prev = before.get(p);
          if (prev === undefined || prev !== hash(bytes)) {
            const copy = bytes.slice();
            files.push({ path: p, data: copy.buffer, kind: p.startsWith("figures/fig-") && p.endsWith(".png") ? "figure" : "file" });
          }
        }
      }
    };
    walk(root, "");
    // Clean up this run's directory (the interpreter is reused).
    try {
      py.runPython(`import shutil, os\nos.chdir("/home/pyodide")\nshutil.rmtree(${JSON.stringify(root)}, ignore_errors=True)`);
    } catch {
      /* ignore */
    }
    post({ type: "done", id, ok: !error, stdout, stderr, result, error, files, durationMs: Date.now() - started }, files.map((f) => f.data));
  } catch (e) {
    post({ type: "done", id, ok: false, stdout, stderr, result: null, error: `Pyodide 載入或執行失敗：${String((e as Error)?.message ?? e)}`, files: [], durationMs: Date.now() - started });
  }
};

/** FNV-1a over the bytes + length (change detection only). */
function hash(b: Uint8Array): number {
  let h = 0x811c9dc5 ^ b.length;
  for (let i = 0; i < b.length; i++) {
    h ^= b[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
