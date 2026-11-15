import type { Page } from "@playwright/test";

export const PASSWORD = "e2e-password-123";
export const MOCK_LLM = process.env.MOCK_LLM_URL ?? "http://127.0.0.1:8790";

/** fetch /api/* from inside the page (session cookie + CSRF double-submit). */
export async function api<T = any>(page: Page, path: string, method = "GET", body?: unknown): Promise<T> {
  return page.evaluate(async ({ path, method, body }) => {
    const csrf = document.cookie.split("; ").find((c) => c.startsWith("em_csrf="))?.slice(8);
    const r = await fetch(`/api${path}`, {
      method, credentials: "same-origin",
      headers: { "content-type": "application/json", ...(csrf ? { "x-csrf-token": decodeURIComponent(csrf) } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const t = await r.text();
    if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${t}`);
    return t ? JSON.parse(t) : null;
  }, { path, method, body });
}

/** First-run setup (or login), mock provider + model, once per database. Returns the model row id. */
export async function ensureSetup(page: Page): Promise<string> {
  await page.goto("/");
  const status = await api(page, "/status");
  if (status.setupRequired) await api(page, "/auth/setup", "POST", { password: PASSWORD });
  else if (!status.authenticated) await api(page, "/auth/login", "POST", { password: PASSWORD });
  const provs: any[] = await api(page, "/providers?type=llm");
  let prov = provs.find((p) => p.name === "Mock LLM");
  if (!prov) prov = await api(page, "/providers", "POST", { type: "llm", kind: "openai", name: "Mock LLM", baseUrl: `${MOCK_LLM}/v1` });
  const models: any[] = await api(page, `/providers/${prov.id}/models`, "PUT", { models: [{ modelId: "mock-model", capabilities: { tools: true } }] });
  await page.goto("/");
  return models[0].id;
}

export async function createProject(page: Page, name: string, permissionMode?: string): Promise<string> {
  const p = await api(page, "/projects", "POST", { name, ...(permissionMode ? { permissionMode } : {}) });
  return p.id;
}

/**
 * Serve the Pyodide CDN (cdn.jsdelivr.net/pyodide/…) from a local cache filled with curl. The sandbox browser has
 * no direct internet access; curl does (it honours the proxy env). Set E2E_PYODIDE=direct to skip this.
 */
export async function routePyodide(context: import("@playwright/test").BrowserContext) {
  if (process.env.E2E_PYODIDE === "direct") return;
  const { execFileSync } = await import("node:child_process");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const dir = process.env.E2E_PYODIDE_CACHE ?? "/tmp/edgemind-e2e/pyodide-cache";
  fs.mkdirSync(dir, { recursive: true });
  await context.route(/https:\/\/cdn\.jsdelivr\.net\/pyodide\//, async (route) => {
    const url = route.request().url();
    const file = path.join(dir, encodeURIComponent(url));
    if (!fs.existsSync(file)) {
      try {
        execFileSync("curl", ["-sfL", "-m", "120", "-o", `${file}.part`, url]);
        fs.renameSync(`${file}.part`, file);
      } catch {
        return route.fulfill({ status: 502, body: "offline" });
      }
    }
    const ct = url.endsWith(".wasm") ? "application/wasm" : /\.m?js$/.test(url) ? "text/javascript" : url.endsWith(".json") ? "application/json" : "application/octet-stream";
    return route.fulfill({ status: 200, body: fs.readFileSync(file), headers: { "content-type": ct, "access-control-allow-origin": "*" } });
  });
}

/** Direct SQL against the E2E database (to put a run into states that are hard to reach through the UI). */
export async function sql(text: string, params: unknown[] = []): Promise<any[]> {
  const pg = (await import("pg")).default;
  const c = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await c.connect();
  try {
    return (await c.query(text, params)).rows;
  } finally {
    await c.end();
  }
}

/** What the mock LLM received as the code_run result for the conversation started with `prompt`. */
export async function toolResultFor(prompt: string): Promise<any> {
  const r = await (await fetch(`${MOCK_LLM}/tool-result?prompt=${encodeURIComponent(prompt)}`)).json();
  try {
    return typeof r.result === "string" ? JSON.parse(r.result) : r.result;
  } catch {
    return r.result;
  }
}
