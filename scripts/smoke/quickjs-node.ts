// Bundled with the Netlify settings by build-functions.mjs: QuickJS single-file variant (wasm embedded).
import { useNodeQuickJS } from "../../server/src/sandbox/quickjs-node";
import { runJavaScript } from "../../server/src/sandbox/quickjs";

useNodeQuickJS();
export const smoke = () => runJavaScript("fs.writeFile('o.txt', 'ok'); [1, 2, 3].map((x) => x * 2)", { timeoutMs: 3000 });
