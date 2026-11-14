import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { createTestDatabase, testEnv } from "./helpers";

let t: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => { t = await createTestDatabase(); });
afterAll(async () => t?.drop());

describe("status endpoint", () => {
  it("reports env problems without touching the DB, and other routes return 503", async () => {
    const app = createApp({ getDatabase: () => { throw new Error("should not be called"); } });
    const res = await app.request("/api/status", {}, {});
    const body = await res.json();
    expect(body.env.ok).toBe(false);
    expect(body.env.issues.length).toBe(8);
    const r2 = await app.request("/api/health", {}, {});
    expect(r2.status).toBe(503);
    expect((await r2.json()).error).toBe("env_invalid");
  });

  it("auto-migrates and reports setupRequired on a fresh DB", async () => {
    const app = createApp({ getDatabase: () => t.database });
    const res = await app.request("/api/status", {}, testEnv(t.url));
    const body = await res.json();
    expect(body.env.ok).toBe(true);
    expect(body.db).toEqual({ ok: true, migrated: true });
    expect(body.setupRequired).toBe(true);
  });
});
