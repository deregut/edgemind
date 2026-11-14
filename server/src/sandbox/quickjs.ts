/**
 * Server-side JavaScript sandbox: QuickJS compiled to WebAssembly (quickjs-emscripten, sync variant).
 * Runs inside the request isolate on both Netlify (Node) and Cloudflare (workerd: no eval / new Function needed —
 * QuickJS interprets the code inside wasm). No network, no real FS: only `console.*` and a virtual `fs` whose
 * contents live on the host side (preloaded project files; written files are reported back).
 *
 * The variant (how the .wasm is obtained) differs per platform, so it is injected with setQuickJSLoader():
 *   - Node / Netlify / tests: sandbox/quickjs-node.ts (single-file variant, wasm embedded as base64)
 *   - Cloudflare Pages: platform/cloudflare.ts (wasmfile variant + `import wasm from "….wasm"` → WebAssembly.Module,
 *     because workerd forbids compiling wasm from bytes at runtime)
 */
import { newQuickJSWASMModuleFromVariant, shouldInterruptAfterDeadline, type QuickJSContext, type QuickJSHandle, type QuickJSWASMModule } from "quickjs-emscripten-core";

type Loader = () => Promise<QuickJSWASMModule>;
let loader: Loader | null = null;
let modulePromise: Promise<QuickJSWASMModule> | null = null;

/** Register how to build the QuickJS wasm module on this platform (called once by the platform adapter). */
export function setQuickJSLoader(l: Loader) {
  loader = l;
  modulePromise = null;
}

/** Convenience: build a loader from a quickjs-emscripten variant. */
export function loaderFromVariant(variant: Parameters<typeof newQuickJSWASMModuleFromVariant>[0]): Loader {
  return () => newQuickJSWASMModuleFromVariant(variant);
}

export const quickJSConfigured = () => loader !== null;

async function getModule(): Promise<QuickJSWASMModule> {
  if (!loader) throw new Error("此部署未設定 QuickJS 執行環境");
  if (!modulePromise) modulePromise = loader().catch((e) => {
    modulePromise = null;
    throw e;
  });
  return modulePromise;
}

export interface VfsFile {
  data: Uint8Array;
  mime?: string | null;
}

export interface JsRunOptions {
  timeoutMs: number;
  memoryLimitBytes?: number;
  maxStackBytes?: number;
  /** Initial virtual FS (path → bytes). */
  files?: Map<string, VfsFile>;
  /** Cap on the bytes a script may hold in its virtual FS (writes beyond fail inside the script). */
  maxVfsBytes?: number;
  /** Cap on captured console bytes per stream (excess dropped, flagged). */
  maxConsoleBytes?: number;
}

export interface JsRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  stdoutDropped: boolean;
  stderrDropped: boolean;
  /** JSON-ish dump of the completion value / returned value (undefined → null). */
  value: unknown;
  error: string | null;
  /** "timeout" | "memory" | "stack" | "error" */
  errorKind: string | null;
  durationMs: number;
  /** Paths written / deleted by the script (final state in `files`). */
  written: string[];
  deleted: string[];
  files: Map<string, VfsFile>;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function latin1ToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}
function bytesToLatin1(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return s;
}
function b64(b: Uint8Array): string {
  return btoa(bytesToLatin1(b));
}
function unb64(s: string): Uint8Array {
  return latin1ToBytes(atob(s.replace(/\s+/g, "")));
}

export function normalizeVfsPath(p: string): string {
  const parts: string[] = [];
  for (const seg of String(p).replace(/\\/g, "/").split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  const out = parts.join("/");
  if (!out) throw new Error("路徑不可為空");
  if (out.length > 500) throw new Error("路徑過長");
  return out;
}

/** In-VM prelude: console, fs, and a tiny Buffer-free text/binary bridge over the single `__host` function. */
const PRELUDE = String.raw`
(() => {
  const host = globalThis.__host; delete globalThis.__host;
  const fmt = (v) => {
    if (typeof v === "string") return v;
    if (v instanceof Error) return (v.stack ? v.name + ": " + v.message + "\n" + v.stack : v.name + ": " + v.message);
    if (typeof v === "undefined") return "undefined";
    if (typeof v === "function") return "[Function " + (v.name || "anonymous") + "]";
    if (typeof v === "bigint") return v.toString() + "n";
    try { const s = JSON.stringify(v, (k, x) => typeof x === "bigint" ? x.toString() + "n" : x, 2); return s === undefined ? String(v) : s; } catch { return String(v); }
  };
  const line = (a) => a.map(fmt).join(" ");
  globalThis.console = {
    log: (...a) => host("out", line(a)), info: (...a) => host("out", line(a)), debug: (...a) => host("out", line(a)),
    error: (...a) => host("err", line(a)), warn: (...a) => host("err", line(a)),
    table: (x) => host("out", fmt(x)),
  };
  const toLatin1 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 4096) s += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + 4096))); return s; };
  const fromLatin1 = (s) => { const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };
  const call = (op, ...args) => { const r = JSON.parse(host(op, JSON.stringify(args))); if (r.error) throw new Error(r.error); return r.value; };
  globalThis.fs = Object.freeze({
    /** encoding: "utf8" (default) | "base64" | "binary" (Uint8Array) */
    readFile(path, encoding = "utf8") {
      if (encoding === "binary" || encoding === "bytes") return fromLatin1(call("read", path, "latin1"));
      return call("read", path, encoding);
    },
    /** data: string | Uint8Array | ArrayBuffer; encoding "utf8" (default) or "base64" for string data */
    writeFile(path, data, encoding = "utf8") {
      if (data instanceof ArrayBuffer) data = new Uint8Array(data);
      if (data instanceof Uint8Array) return call("write", path, toLatin1(data), "latin1");
      if (typeof data !== "string") data = typeof data === "object" ? JSON.stringify(data, null, 2) : String(data);
      return call("write", path, data, encoding);
    },
    appendFile(path, data) { const prev = fs.exists(path) ? fs.readFile(path) : ""; return fs.writeFile(path, prev + String(data)); },
    exists(path) { return call("exists", path); },
    deleteFile(path) { return call("delete", path); },
    /** [{ path, size }] (optionally under a folder prefix) */
    listFiles(prefix = "") { return call("list", prefix); },
  });
  globalThis.readFile = fs.readFile; globalThis.writeFile = fs.writeFile; globalThis.listFiles = fs.listFiles;
})();
`;

export async function runJavaScript(code: string, opts: JsRunOptions): Promise<JsRunResult> {
  const QuickJS = await getModule();
  const started = Date.now();
  const files = new Map<string, VfsFile>(opts.files ?? []);
  const written = new Set<string>();
  const deleted = new Set<string>();
  const maxConsole = opts.maxConsoleBytes ?? 1_000_000;
  const maxVfs = opts.maxVfsBytes ?? 20 * 1024 * 1024;
  const out = { stdout: "", stderr: "", stdoutDropped: false, stderrDropped: false };
  const push = (k: "stdout" | "stderr", s: string) => {
    if (out[k].length >= maxConsole) {
      out[k === "stdout" ? "stdoutDropped" : "stderrDropped"] = true;
      return;
    }
    out[k] += s + "\n";
  };
  const vfsBytes = () => [...files.values()].reduce((n, f) => n + f.data.length, 0);

  const hostOp = (op: string, raw: string): string => {
    if (op === "out" || op === "err") {
      push(op === "out" ? "stdout" : "stderr", raw);
      return "";
    }
    try {
      const args = JSON.parse(raw) as unknown[];
      const p = () => normalizeVfsPath(String(args[0] ?? ""));
      switch (op) {
        case "read": {
          const path = p();
          const f = files.get(path);
          if (!f) return JSON.stringify({ error: `ENOENT: 找不到檔案 ${path}` });
          const e = String(args[1] ?? "utf8");
          const value = e === "base64" ? b64(f.data) : e === "latin1" ? bytesToLatin1(f.data) : dec.decode(f.data);
          return JSON.stringify({ value });
        }
        case "write": {
          const path = p();
          const e = String(args[2] ?? "utf8");
          const s = String(args[1] ?? "");
          const data = e === "base64" ? unb64(s) : e === "latin1" ? latin1ToBytes(s) : enc.encode(s);
          const prev = files.get(path)?.data.length ?? 0;
          if (vfsBytes() - prev + data.length > maxVfs) return JSON.stringify({ error: `虛擬檔案系統超過 ${Math.round(maxVfs / 1024 / 1024)} MB 上限` });
          files.set(path, { data });
          written.add(path);
          deleted.delete(path);
          return JSON.stringify({ value: { path, size: data.length } });
        }
        case "exists":
          return JSON.stringify({ value: files.has(p()) });
        case "delete": {
          const path = p();
          const had = files.delete(path);
          if (had) {
            written.delete(path);
            deleted.add(path);
          }
          return JSON.stringify({ value: had });
        }
        case "list": {
          const prefix = String(args[0] ?? "").replace(/^\/+/, "");
          const value = [...files.entries()].filter(([k]) => !prefix || k.startsWith(prefix)).map(([path, f]) => ({ path, size: f.data.length })).sort((a, b) => a.path.localeCompare(b.path));
          return JSON.stringify({ value });
        }
      }
      return JSON.stringify({ error: `unknown op ${op}` });
    } catch (e) {
      return JSON.stringify({ error: (e as Error).message });
    }
  };

  const deadline = started + opts.timeoutMs;
  const rt = QuickJS.newRuntime();
  rt.setMemoryLimit(opts.memoryLimitBytes ?? 64 * 1024 * 1024);
  // 256 KiB: QuickJS must hit its own limit before the host's native stack does (a host RangeError corrupts the runtime).
  rt.setMaxStackSize(opts.maxStackBytes ?? 256 * 1024);
  rt.setInterruptHandler(shouldInterruptAfterDeadline(deadline));
  let vm: QuickJSContext | undefined;
  const result: JsRunResult = { ok: false, stdout: "", stderr: "", stdoutDropped: false, stderrDropped: false, value: null, error: null, errorKind: null, durationMs: 0, written: [], deleted: [], files };

  const classify = (msg: string): string => {
    if (/interrupted/i.test(msg) || Date.now() >= deadline) return "timeout";
    if (/out of memory/i.test(msg)) return "memory";
    if (/stack overflow|call stack size/i.test(msg)) return "stack";
    return "error";
  };
  const describeError = (h: QuickJSHandle): string => {
    const d = vm!.dump(h);
    if (d && typeof d === "object") {
      const o = d as { name?: string; message?: string; stack?: string };
      const head = `${o.name ?? "Error"}: ${o.message ?? ""}`;
      const stack = String(o.stack ?? "").trim().split("\n");
      return stack[0] ? `${head}\n${stack.slice(0, 12).join("\n")}${stack.length > 12 ? `\n    …（另 ${stack.length - 12} 層）` : ""}` : head;
    }
    return String(d);
  };

  try {
    vm = rt.newContext();
    const hostFn = vm.newFunction("__host", (opH, argH) => {
      const r = hostOp(vm!.getString(opH), argH ? vm!.getString(argH) : "");
      return vm!.newString(r);
    });
    vm.setProp(vm.global, "__host", hostFn);
    hostFn.dispose();
    const pre = vm.evalCode(PRELUDE, "prelude.js");
    if (pre.error) {
      const m = describeError(pre.error);
      pre.error.dispose();
      throw new Error(`prelude failed: ${m}`);
    }
    pre.value.dispose();

    let r = vm.evalCode(code, "main.js");
    if (r.error) {
      const m = vm.dump(r.error) as { name?: string; message?: string } | undefined;
      // Top-level await / return: retry wrapped in an async function (value = explicit `return`).
      if (m?.name === "SyntaxError" && /\b(await|return)\b/.test(code)) {
        r.error.dispose();
        r = vm.evalCode(`(async () => {\n${code}\n})()`, "main.js");
      }
    }
    if (r.error) {
      const msg = describeError(r.error);
      r.error.dispose();
      result.error = msg;
      result.errorKind = classify(msg);
    } else {
      let h = r.value;
      // Drain the job queue; resolve a returned promise.
      const state0 = vm.getPromiseState(h);
      if (!(state0.type === "fulfilled" && state0.notAPromise)) {
        if (state0.type === "fulfilled") state0.value.dispose();
        else if (state0.type === "rejected") state0.error.dispose();
        for (;;) {
          const jobs = rt.executePendingJobs(-1);
          if (jobs.error) {
            const msg = describeError(jobs.error);
            jobs.error.dispose();
            result.error = msg;
            result.errorKind = classify(msg);
            break;
          }
          const st = vm.getPromiseState(h);
          if (st.type === "pending") {
            if (jobs.value === 0) {
              result.error = "Promise 永遠不會完成（沙盒沒有計時器與網路，請勿等待 setTimeout / fetch）";
              result.errorKind = "error";
              break;
            }
            if (Date.now() >= deadline) {
              result.error = "執行逾時";
              result.errorKind = "timeout";
              break;
            }
            continue;
          }
          if (st.type === "rejected") {
            const msg = describeError(st.error);
            st.error.dispose();
            result.error = msg;
            result.errorKind = classify(msg);
          } else if (!st.notAPromise) {
            h.dispose();
            h = st.value;
          }
          break;
        }
      } else {
        rt.executePendingJobs(-1);
      }
      if (!result.error) {
        const v = vm.dump(h);
        result.value = v === undefined ? null : v;
        result.ok = true;
      }
      h.alive && h.dispose();
    }
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    result.error = msg;
    result.errorKind = classify(msg);
  } finally {
    try {
      vm?.dispose();
      rt.dispose();
    } catch {
      // A runtime killed by OOM may not dispose cleanly; drop the module so the next run starts fresh.
      modulePromise = null;
    }
  }
  result.stdout = out.stdout;
  result.stderr = out.stderr;
  result.stdoutDropped = out.stdoutDropped;
  result.stderrDropped = out.stderrDropped;
  result.durationMs = Date.now() - started;
  result.written = [...written];
  result.deleted = [...deleted];
  return result;
}
