// Bundled with the Cloudflare settings by build-functions.mjs: QuickJS via the workerd emscripten build + imported wasm module.
import quickjsWasm from "../../node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm";
import { useQuickJSWasmModule } from "../../server/src/platform/cloudflare";
import { runJavaScript } from "../../server/src/sandbox/quickjs";

useQuickJSWasmModule(quickjsWasm);
export const smoke = () => runJavaScript("fs.writeFile('o.txt', 'ok'); [1, 2, 3].map((x) => x * 2)", { timeoutMs: 3000 });
