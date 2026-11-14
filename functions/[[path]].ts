import quickjsWasm from "../node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm";
import { handlePages, useQuickJSWasmModule } from "../server/src/platform/cloudflare";

// code_run javascript: QuickJS wasm imported as a module (wrangler bundles *.wasm as WebAssembly.Module).
useQuickJSWasmModule(quickjsWasm);

// Cloudflare Pages Functions: one catch-all mounting the same Hono app as Netlify.
export const onRequest = (context: Parameters<typeof handlePages>[0]) => handlePages(context);
