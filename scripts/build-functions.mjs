// Verifies both serverless targets bundle cleanly (Netlify bundles on its own at deploy time;
// this catches import/runtime-compat problems locally). Output: build-out/ (git-ignored).
import { build } from "esbuild";
import { builtinModules } from "node:module";

const common = { bundle: true, format: "esm", target: "es2022", logLevel: "warning", metafile: true, legalComments: "none" };

// Netlify Functions (Node 20+ runtime)
const n = await build({
  ...common,
  entryPoints: ["netlify/functions/api.ts", "netlify/functions/agent-background.ts"],
  outdir: "build-out/netlify",
  outExtension: { ".js": ".mjs" },
  platform: "node",
});

// Cloudflare Pages Functions (workerd): no Node builtins allowed.
const nodeBuiltins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
const cf = await build({
  ...common,
  entryPoints: ["functions/[[path]].ts"],
  outfile: "build-out/cloudflare/functions.mjs",
  platform: "browser",
  conditions: ["workerd", "worker", "browser"],
  minify: true,
  plugins: [{
    name: "forbid-node-builtins",
    setup(b) {
      b.onResolve({ filter: /.*/ }, (args) => {
        if (nodeBuiltins.has(args.path)) return { errors: [{ text: `Node builtin "${args.path}" imported by ${args.importer} (not available on Cloudflare without nodejs_compat)` }] };
      });
    },
  }],
});

const size = (m) => Object.values(m.outputs).reduce((a, o) => a + o.bytes, 0);
console.log(`netlify bundle: ${(size(n.metafile) / 1024).toFixed(0)} KiB`);
console.log(`cloudflare bundle: ${(size(cf.metafile) / 1024).toFixed(0)} KiB (minified)`);

// Smoke test: both bundles answer /api/status with an env report (no env set here).
const { pathToFileURL } = await import("node:url");
const net = await import(pathToFileURL("build-out/netlify/api.mjs").href);
for (const k of ["DATABASE_URL", "ENCRYPTION_KEY", "JWT_SECRET"]) delete process.env[k];
const r1 = await (await net.default(new Request("http://localhost/api/status"), {})).json();
const bg = await import(pathToFileURL("build-out/netlify/agent-background.mjs").href);
const rb = await bg.default(new Request("http://localhost/.netlify/functions/agent-background", { method: "POST", body: "{}" }), {});
if (rb.status !== 503) { console.error("background smoke failed", rb.status, await rb.text()); process.exit(1); }
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
