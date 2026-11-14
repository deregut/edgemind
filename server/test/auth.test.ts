import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { createTestDatabase, testEnv, TestClient } from "./helpers";

let t: Awaited<ReturnType<typeof createTestDatabase>>;
let app: ReturnType<typeof createApp>;
let env: Record<string, string>;
beforeAll(async () => {
  t = await createTestDatabase();
  app = createApp({ getDatabase: () => t.database });
  env = testEnv(t.url);
});
afterAll(async () => t?.drop());

const PW = "s3cret-password!";

describe("single-user auth", () => {
  it("first-run setup, CSRF required, cookies are HttpOnly/SameSite", async () => {
    const c = new TestClient(app, env);
    const s = await c.get("/status");
    expect(s.body.setupRequired).toBe(true);
    expect(c.cookies.has("em_csrf")).toBe(true);
    // protected routes need auth
    expect((await c.get("/providers")).status).toBe(401);
    // no CSRF header -> 403
    expect((await c.post("/auth/setup", { password: PW }, { csrf: false })).status).toBe(403);
    // cross-origin -> 403
    expect((await c.post("/auth/setup", { password: PW }, { headers: { origin: "https://evil.example" } })).status).toBe(403);
    // weak password
    expect((await c.post("/auth/setup", { password: "short" })).status).toBe(400);
    const ok = await c.post("/auth/setup", { password: PW });
    expect(ok.status).toBe(200);
    const sc = ok.headers.getSetCookie().find((x) => x.startsWith("em_session="))!;
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/SameSite=Strict/i);
    expect((await c.get("/status")).body).toMatchObject({ setupRequired: false, authenticated: true });
    expect((await c.get("/auth/me")).status).toBe(200);
    // setup can't be repeated
    const other = new TestClient(app, env, "9.9.9.9");
    await other.get("/status");
    expect((await other.post("/auth/setup", { password: "another-password" })).status).toBe(409);
  });

  it("login, logout revokes session, tampered JWT rejected", async () => {
    const c = new TestClient(app, env, "5.5.5.5");
    await c.get("/status");
    expect((await c.post("/auth/login", { password: "nope-nope-nope" })).status).toBe(401);
    expect((await c.post("/auth/login", { password: PW })).status).toBe(200);
    expect((await c.get("/auth/me")).status).toBe(200);
    const token = c.cookies.get("em_session")!;
    const evil = new TestClient(app, env);
    evil.cookies.set("em_session", token.slice(0, -3) + "abc");
    expect((await evil.get("/auth/me")).status).toBe(401);
    expect((await c.post("/auth/logout")).status).toBe(200);
    // replay the old cookie after logout
    const replay = new TestClient(app, env);
    replay.cookies.set("em_session", token);
    expect((await replay.get("/auth/me")).status).toBe(401);
  });

  it("rate-limits failed logins per IP", async () => {
    const c = new TestClient(app, env, "7.7.7.7");
    await c.get("/status");
    for (let i = 0; i < 5; i++) expect((await c.post("/auth/login", { password: "wrong-password" })).status).toBe(401);
    const blocked = await c.post("/auth/login", { password: PW });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("900");
    // other IPs unaffected
    const d = new TestClient(app, env, "8.8.8.8");
    await d.get("/status");
    expect((await d.post("/auth/login", { password: PW })).status).toBe(200);
  });

  it("password change invalidates other sessions", async () => {
    const a = new TestClient(app, env, "10.0.0.1");
    const b = new TestClient(app, env, "10.0.0.2");
    for (const x of [a, b]) {
      await x.get("/status");
      expect((await x.post("/auth/login", { password: PW })).status).toBe(200);
    }
    expect((await a.post("/auth/password", { currentPassword: "bad", newPassword: "new-password-123" })).status).toBe(401);
    expect((await a.post("/auth/password", { currentPassword: PW, newPassword: "new-password-123" })).status).toBe(200);
    expect((await a.get("/auth/me")).status).toBe(200);
    expect((await b.get("/auth/me")).status).toBe(401);
    expect((await b.post("/auth/login", { password: PW })).status).toBe(401);
    expect((await b.post("/auth/login", { password: "new-password-123" })).status).toBe(200);
  });
});
