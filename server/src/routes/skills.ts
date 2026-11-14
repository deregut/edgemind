/**
 * Skills API:
 *   GET    /api/skills                         list
 *   POST   /api/skills                         { content }  create from the editor (strict SKILL.md)
 *   POST   /api/skills/upload?overwrite=1      raw zip body (application/zip, ≤ 6 MB) — one or many skill folders
 *   POST   /api/skills/import                  { url, overwrite? } GitHub import
 *   GET    /api/skills/:id                     detail incl. SKILL.md text + parsed front matter
 *   PATCH  /api/skills/:id                     { enabled }
 *   DELETE /api/skills/:id
 *   GET    /api/skills/:id/file?path=          raw file
 *   PUT    /api/skills/:id/file                { path, content }  text write (SKILL.md re-validated)
 *   DELETE /api/skills/:id/file?path=
 *   GET    /api/skills/:id/export              zip download
 *   GET/PUT /api/settings/github               { configured } / { token | null }  (encrypted, for private repos & rate limits)
 */
import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import { skills } from "../db/schema";
import type { SkillDetailDTO, SkillImportResult } from "@edgemind/shared";
import type { AppDeps, Ctx, HonoEnv } from "../context";
import { BadInput } from "../lib/errors";
import { decryptSecret, encryptSecret } from "../lib/crypto";
import { getSetting, setSetting } from "../lib/settings";
import { SKILL_MD, SkillConflict, SkillStore, toSkillDTO, unzipSkills, type SkillFiles, type SkillRow } from "../skills/store";
import { fetchGithubSkills } from "../skills/github";
import { s3For } from "./files";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_ZIP_UPLOAD_BYTES = 6 * 1024 * 1024;
const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: false });

export function skillStore(c: Ctx, deps: AppDeps): SkillStore {
  return new SkillStore(c.get("database"), s3For(c, deps));
}

export async function githubToken(c: Ctx): Promise<string | null> {
  const v = await getSetting<string>(c.get("database"), "github_token_enc");
  if (!v) return null;
  try {
    return await decryptSecret(v, c.get("encKey"), "github_token");
  } catch {
    return null;
  }
}

async function detail(store: SkillStore, r: SkillRow): Promise<SkillDetailDTO> {
  const md = dec.decode(await store.readFile(r, SKILL_MD));
  return { ...toSkillDTO(r), skillMd: md, frontmatter: r.frontmatter ?? {} };
}

async function importMany(store: SkillStore, found: { dir: string; files: SkillFiles; sourceUrl?: string }[], source: "upload" | "github", overwrite: boolean): Promise<SkillImportResult> {
  const result: SkillImportResult = { imported: [], skipped: [] };
  for (const f of found) {
    const fallbackName = f.dir.replace(/\/$/, "").split("/").pop() || "skill";
    try {
      const { row, fixed } = await store.saveFolder(f.files, { source, sourceUrl: f.sourceUrl ?? null, overwrite, fallbackName });
      result.imported.push(toSkillDTO(row));
      if (fixed.length) result.skipped.push({ name: row.name, reason: `已匯入，但自動修正：${fixed.join("；")}` });
    } catch (e) {
      if (!(e instanceof SkillConflict) && !(e instanceof BadInput)) throw e;
      result.skipped.push({ name: fallbackName, reason: e.message });
    }
  }
  return result;
}

export function mountSkills(app: Hono<HonoEnv>, deps: AppDeps) {
  const load = async (c: Ctx) => {
    const id = c.req.param("id") ?? "";
    if (!UUID.test(id)) throw new BadInput("無效的 Skill id");
    const store = skillStore(c, deps);
    const r = await store.byId(id);
    return { store, r };
  };
  const conflict = (c: Ctx, e: unknown) => {
    if (e instanceof SkillConflict) return c.json({ error: "conflict", message: e.message }, 409);
    throw e;
  };

  app.get("/skills", async (c) => c.json((await skillStore(c, deps).list()).map(toSkillDTO)));

  app.post("/skills", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (typeof body?.content !== "string" || !body.content.trim()) throw new BadInput("請輸入 SKILL.md 內容");
    const store = skillStore(c, deps);
    try {
      const { row } = await store.saveFolder(new Map([[SKILL_MD, enc.encode(body.content)]]), { source: "editor", strict: true });
      return c.json(await detail(store, row), 201);
    } catch (e) {
      return conflict(c, e);
    }
  });

  app.post("/skills/upload", async (c) => {
    const len = Number(c.req.header("content-length") ?? 0);
    if (len > MAX_ZIP_UPLOAD_BYTES) throw new BadInput("zip 上限 6 MB（較大的 Skill 請從 GitHub 匯入）");
    const buf = new Uint8Array(await c.req.arrayBuffer());
    if (!buf.byteLength) throw new BadInput("請上傳 zip 檔");
    if (buf.byteLength > MAX_ZIP_UPLOAD_BYTES) throw new BadInput("zip 上限 6 MB（較大的 Skill 請從 GitHub 匯入）");
    const found = unzipSkills(buf);
    return c.json(await importMany(skillStore(c, deps), found, "upload", c.req.query("overwrite") === "1"));
  });

  app.post("/skills/import", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (typeof body?.url !== "string") throw new BadInput("請輸入 GitHub 網址");
    const fetchFn = deps.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    const found = await fetchGithubSkills(fetchFn, body.url, await githubToken(c));
    return c.json(await importMany(skillStore(c, deps), found, "github", !!body.overwrite));
  });

  app.get("/skills/:id", async (c) => {
    const { store, r } = await load(c);
    if (!r) return c.json({ error: "not_found" }, 404);
    return c.json(await detail(store, r));
  });

  app.patch("/skills/:id", async (c) => {
    const { store, r } = await load(c);
    if (!r) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    if (typeof body?.enabled !== "boolean") throw new BadInput("enabled 必須是布林值");
    const [row] = await store.database.db.update(skills).set({ enabled: body.enabled, updatedAt: new Date() }).where(eq(skills.id, r.id)).returning();
    return c.json(toSkillDTO(row));
  });

  app.delete("/skills/:id", async (c) => {
    const { store, r } = await load(c);
    if (!r) return c.json({ error: "not_found" }, 404);
    await store.remove(r);
    return c.json({ ok: true });
  });

  app.get("/skills/:id/file", async (c) => {
    const { store, r } = await load(c);
    if (!r) return c.json({ error: "not_found" }, 404);
    const path = c.req.query("path") ?? "";
    const data = await store.readFile(r, path);
    const mime = r.files.find((f) => f.path === path)?.mime ?? "application/octet-stream";
    return new Response(data as BodyInit, { headers: { "content-type": mime, "cache-control": "no-store", "x-content-type-options": "nosniff", "content-disposition": "inline" } });
  });

  app.put("/skills/:id/file", async (c) => {
    const { store, r } = await load(c);
    if (!r) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    if (typeof body?.path !== "string" || typeof body?.content !== "string") throw new BadInput("需要 path 與 content");
    try {
      const row = await store.writeFile(r, body.path, enc.encode(body.content), "editor");
      return c.json(await detail(store, row));
    } catch (e) {
      return conflict(c, e);
    }
  });

  app.delete("/skills/:id/file", async (c) => {
    const { store, r } = await load(c);
    if (!r) return c.json({ error: "not_found" }, 404);
    const row = await store.deleteFile(r, c.req.query("path") ?? "");
    return c.json(await detail(store, row));
  });

  app.get("/skills/:id/export", async (c) => {
    const { store, r } = await load(c);
    if (!r) return c.json({ error: "not_found" }, 404);
    const zip = await store.exportZip(r);
    return new Response(zip as BodyInit, {
      headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${r.name}.zip"`, "cache-control": "no-store" },
    });
  });

  app.get("/settings/github", async (c) => c.json({ configured: !!(await getSetting(c.get("database"), "github_token_enc")) }));

  app.put("/settings/github", async (c) => {
    const body = await c.req.json().catch(() => null);
    const token = body?.token;
    if (token !== null && (typeof token !== "string" || !token.trim() || token.length > 500)) throw new BadInput("token 必須是字串或 null");
    await setSetting(c.get("database"), "github_token_enc", token === null ? "" : await encryptSecret(token.trim(), c.get("encKey"), "github_token"));
    return c.json({ configured: token !== null });
  });
}
