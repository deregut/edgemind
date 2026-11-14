/** QuickJS loader for Node runtimes (Netlify Functions, dev server, tests): single-file variant (wasm embedded). */
import variant from "@jitl/quickjs-singlefile-mjs-release-sync";
import { loaderFromVariant, setQuickJSLoader } from "./quickjs";

export function useNodeQuickJS() {
  setQuickJSLoader(loaderFromVariant(variant));
}
