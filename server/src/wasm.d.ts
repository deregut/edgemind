/** Cloudflare (wrangler) bundles `*.wasm` imports as precompiled WebAssembly.Module objects. */
declare module "*.wasm" {
  const mod: WebAssembly.Module;
  export default mod;
}
