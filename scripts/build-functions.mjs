// Verifies both serverless targets bundle cleanly (Netlify bundles on its own at deploy time;
// this catches import/runtime-compat problems locally). Output: build-out/ (git-ignored).
import { build } from "esbuild";
import { builtinModules, register } from "node:module";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { basename } from "node:path";

rmSync("build-out", { recursive: true, force: true });
const common = { bundle: true, format: "esm", target: "es2022", logLevel: "warning", metafile: true, legalComments: "none" };

// Netlify Functions (Node 20+ runtime)
const n = await build({
  ...common,
  entryPoints: { api: "netlify/functions/api.ts", "agent-background": "netlify/functions/agent-background.ts", "cron-tick": "netlify/functions/cron-tick.ts", "quickjs-node": "scripts/smoke/quickjs-node.ts" },
  outdir: "build-out/netlify",
  outExtension: { ".js": ".mjs" },
  platform: "node",
});

// Cloudflare Pages Functions (workerd): no Node builtins allowed.
const nodeBuiltins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
// *.wasm imports stay module imports (wrangler turns them into WebAssembly.Module); copy the file next to the bundle.
const wasmAsModule = {
  name: "wasm-module-import",
  setup(b) {
    b.onResolve({ filter: /\.wasm$/ }, (args) => {
      const abs = new URL(args.path, `file://${args.resolveDir}/`).pathname;
      mkdirSync("build-out/cloudflare", { recursive: true });
      copyFileSync(abs, `build-out/cloudflare/${basename(abs)}`);
      return { path: `./${basename(abs)}`, external: true };
    });
  },
};
const cf = await build({
  ...common,
  entryPoints: { functions: "functions/[[path]].ts", "smoke-quickjs": "scripts/smoke/quickjs-cf.ts" },
  outdir: "build-out/cloudflare",
  outExtension: { ".js": ".mjs" },
  platform: "browser",
  conditions: ["workerd", "worker", "browser"],
  minify: true,
  plugins: [wasmAsModule, {
    name: "forbid-node-builtins",
    setup(b) {
      b.onResolve({ filter: /.*/ }, (args) => {
        if (nodeBuiltins.has(args.path)) return { errors: [{ text: `Node builtin "${args.path}" imported by ${args.importer} (not available on Cloudflare without nodejs_compat)` }] };
      });
    },
  }],
});

const out = (m, f) => Object.entries(m.outputs).find(([k]) => k.endsWith(f))?.[1].bytes ?? 0;
const { gzipSync } = await import("node:zlib");
const { readFileSync, statSync } = await import("node:fs");
console.log(`netlify bundle: api ${(out(n.metafile, "api.mjs") / 1024).toFixed(0)} KiB, agent-background ${(out(n.metafile, "agent-background.mjs") / 1024).toFixed(0)} KiB`);
const cfJs = readFileSync("build-out/cloudflare/functions.mjs");
const cfWasm = readFileSync("build-out/cloudflare/emscripten-module.wasm");
const gz = gzipSync(cfJs).length + gzipSync(cfWasm).length;
console.log(`cloudflare bundle: functions.mjs ${(cfJs.length / 1024).toFixed(0)} KiB (minified) + QuickJS wasm ${(statSync("build-out/cloudflare/emscripten-module.wasm").size / 1024).toFixed(0)} KiB; gzip total ${(gz / 1024).toFixed(0)} KiB (CF free limit 3 MiB compressed)`);
if (gz > 3 * 1024 * 1024) {
  console.error("Cloudflare bundle exceeds the 3 MiB compressed free-plan limit");
  process.exit(1);
}

// Node cannot import .wasm as a module: emulate wrangler (default export = WebAssembly.Module) for the smoke runs.
register("data:text/javascript," + encodeURIComponent(`
export async function load(url, context, next) {
  if (url.endsWith(".wasm")) return { format: "module", shortCircuit: true, source: "import fs from 'node:fs'; export default new WebAssembly.Module(fs.readFileSync(new URL(" + JSON.stringify(url) + ")));" };
  return next(url, context);
}`));

// Smoke test: both bundles answer /api/status with an env report (no env set here).
const { pathToFileURL } = await import("node:url");
const net = await import(pathToFileURL("build-out/netlify/api.mjs").href);
for (const k of ["DATABASE_URL", "ENCRYPTION_KEY", "JWT_SECRET"]) delete process.env[k];
const r1 = await (await net.default(new Request("http://localhost/api/status"), {})).json();
const bg = await import(pathToFileURL("build-out/netlify/agent-background.mjs").href);
const rb = await bg.default(new Request("http://localhost/.netlify/functions/agent-background", { method: "POST", body: "{}" }), {});
if (rb.status !== 503) { console.error("background smoke failed", rb.status, await rb.text()); process.exit(1); }
process.env.URL = "http://localhost";
const ct = await import(pathToFileURL("build-out/netlify/cron-tick.mjs").href);
if (ct.config?.schedule !== "*/15 * * * *") { console.error("cron-tick config.schedule missing"); process.exit(1); }
const rc = await ct.default(new Request("http://localhost/.netlify/functions/cron-tick", { method: "POST", body: "{}" }), {});
if (rc.status !== 503) { console.error("cron-tick smoke failed", rc.status, await rc.text()); process.exit(1); }
const cfm = await import(pathToFileURL("build-out/cloudflare/functions.mjs").href);
const r2 = await (await cfm.onRequest({
  request: new Request("http://localhost/api/status"), env: {}, waitUntil() {}, passThroughOnException() {},
  next: async () => new Response("static"),
})).json();
const r3 = await (await cfm.onRequest({
  request: new Request("http://localhost/settings"), env: {}, waitUntil() {}, passThroughOnException() {},
  next: async () => new Response("static"),
})).text();
if (r1.env?.ok !== false || r2.env?.ok !== false || r3 !== "static") {
  console.error("smoke test failed", r1, r2, r3);
  process.exit(1);
}
console.log("smoke: both bundles serve /api/status; CF falls through to static for non-/api paths");

// code_run javascript: QuickJS runs from both bundles (CF: workerd emscripten build + wasm module import).
for (const f of ["build-out/netlify/quickjs-node.mjs", "build-out/cloudflare/smoke-quickjs.mjs"]) {
  const m = await import(pathToFileURL(f).href);
  const r = await m.smoke();
  if (!r.ok || JSON.stringify(r.value) !== "[2,4,6]" || !r.written.includes("o.txt")) {
    console.error("QuickJS smoke failed", f, r);
    process.exit(1);
  }
}
console.log("smoke: QuickJS code_run works from the Netlify and Cloudflare bundles");
