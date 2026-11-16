/**
 * Browser E2E tests (not part of `npm test`): `npm run test:e2e` (see e2e/README.md).
 * Starts a mock OpenAI-compatible LLM, a mock S3, the API dev server on a fresh Postgres database, and the web app
 * (Vite dev by default, the production build with E2E_WEB=preview).
 */
import { defineConfig, devices } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const preview = process.env.E2E_WEB === "preview";
const webPort = preview ? 4173 : 5173;

// Readiness is checked by port: an HTTP(S)_PROXY in the environment would answer url probes itself.
// A fresh database per run (created once, in the runner process; workers inherit the env).
if (!process.env.E2E_DATABASE_URL) {
  const admin = process.env.E2E_PG_URL ?? process.env.TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:54329/postgres";
  const name = `edgemind_e2e_${Date.now()}`;
  execFileSync(process.execPath, ["-e", `
    const pg = require("pg");
    const c = new pg.Client({ connectionString: process.argv[1] });
    c.connect().then(() => c.query('CREATE DATABASE "' + process.argv[2] + '"')).then(() => c.end()).catch((e) => { console.error(e.message); process.exit(1); });
  `, admin, name], { cwd: `${root}/server`, stdio: "inherit" });
  const u = new URL(admin);
  u.pathname = `/${name}`;
  process.env.E2E_DATABASE_URL = u.toString();
}

const env = {
  DATABASE_URL: process.env.E2E_DATABASE_URL!,
  S3_ENDPOINT: "http://127.0.0.1:9000", S3_BUCKET: "edgemind", S3_REGION: "us-east-1", S3_ACCESS_KEY_ID: "test", S3_SECRET_ACCESS_KEY: "testsecret",
  ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  JWT_SECRET: "e2e-jwt-secret-e2e-jwt-secret-e2e-jwt-secret",
};
const reuse = process.env.E2E_REUSE === "1";
// E2E_DB=neon: the API talks to Postgres through the production neon-http driver (via a local Neon HTTP endpoint).
const neon = process.env.E2E_DB === "neon";
const apiEnv = neon ? { ...env, DEV_DB_DRIVER: "neon", NEON_FETCH_ENDPOINT: "http://127.0.0.1:4444/sql" } : env;

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  use: { baseURL: `http://localhost:${webPort}`, trace: "retain-on-failure", ...devices["Desktop Chrome"] },
  webServer: [
    { command: "node e2e/support/mock-llm.mjs", cwd: root, port: 8790, reuseExistingServer: reuse, stdout: "pipe" },
    { command: "npx tsx e2e/support/s3-server.ts", cwd: root, port: 9000, reuseExistingServer: reuse, stdout: "pipe" },
    ...(neon ? [{ command: "node e2e/support/neon-http-proxy.mjs", cwd: root, env: { PG_URL: env.DATABASE_URL }, port: 4444, reuseExistingServer: reuse, stdout: "pipe" as const }] : []),
    { command: "npx tsx scripts/dev-server.ts", cwd: `${root}/server`, env: apiEnv, port: 8787, reuseExistingServer: reuse, timeout: 60_000, stdout: "pipe" },
    preview
      ? { command: `npx vite build && npx vite preview --port ${webPort} --strictPort`, cwd: `${root}/web`, port: webPort, reuseExistingServer: reuse, timeout: 240_000 }
      : { command: `npx vite --port ${webPort} --strictPort`, cwd: `${root}/web`, port: webPort, reuseExistingServer: reuse, timeout: 60_000, stdout: "pipe" },
  ],
});
