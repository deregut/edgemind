import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  // changeOrigin: false keeps the browser Host so the API's Origin (CSRF) check matches in dev.
  server: { proxy: { "/api": { target: "http://127.0.0.1:8787", changeOrigin: false } } },
  build: { outDir: "dist", emptyOutDir: true },
});
