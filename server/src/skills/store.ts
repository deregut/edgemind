/**
 * Skills: Agent Skills folders (SKILL.md + scripts / references / assets) stored on S3 under `skills/{id}/`,
 * with a manifest + parsed front matter in the `skills` table. Sources: zip upload, online editor,
 * GitHub import, or the model itself (skill_write).
 */
import { asc, eq } from "drizzle-orm";
import { unzipSync, zipSync } from "fflate";
import { SKILL_DESCRIPTION_MAX, SKILL_NAME_RE, type SkillDTO, type SkillFileDTO, type SkillSource } from "@edgemind/shared";
import type { Database } from "../db/client";
import { projects, skills } from "../db/schema";
import { BadInput } from "../lib/errors";
import type { S3 } from "../storage/s3";
import { guessMime, normalizePath } from "../storage/files";
import { parseSkillMd, setFrontmatterFields } from "./frontmatter";

export type SkillRow = typeof skills.$inferSelect;
export type SkillFiles = Map<string, Uint8Array>;

export const SKILL_MD = "SKILL.md";
export const MAX_SKILL_FILES = 200;
export const MAX_SKILL_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_SKILL_TOTAL_BYTES = 20 * 1024 * 1024;
export const MAX_SKILLS_PER_IMPORT = 30;

export class SkillConflict extends Error {}

const enc = new TextEncoder();
const dec = new TextDecoder();

export function toSkillDTO(r: SkillRow): SkillDTO {
  return {
    id: r.id, name: r.name, description: r.description, source: r.source as SkillSource, sourceUrl: r.sourceUrl, enabled: r.enabled,
    files: r.files ?? [], createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
  };
}

/** Lowercase-hyphen slug that satisfies SKILL_NAME_RE ("" when nothing usable remains). */
export function slugifySkillName(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 64).replace(/-$/, "");
}

const IGNORED = (p: string) => p.split("/").some((s) => s === "__MACOSX" || s === ".git" || s === ".DS_Store" || s === "Thumbs.db");

/** Validate a SKILL.md. strict: reject problems; lenient (imports): repair the name/description and rewrite the file. */
export function checkSkillMd(text: string, opts: { strict: boolean; fallbackName?: string }): { name: string; description: string; frontmatter: Record<string, unknown>; text: string; fixed: string[] } {
  const parsed = parseSkillMd(text);
  const fm = parsed.frontmatter;
  const fixed: string[] = [];
  let name = typeof fm.name === "string" ? fm.name.trim() : "";
  let description = typeof fm.description === "string" ? fm.description.trim() : "";
  if (opts.strict) {
    if (!parsed.hasFrontmatter) throw new BadInput("SKILL.md 必須以 YAML front matter（--- 開頭）宣告 name 與 description");
    if (!SKILL_NAME_RE.test(name)) throw new BadInput("name 只能使用小寫英文字母、數字與單一連字號（-），長度 1–64，且不能以連字號開頭或結尾");
    if (!description) throw new BadInput("description 不可為空：說明這個 Skill 做什麼、何時使用");
    if (description.length > SKILL_DESCRIPTION_MAX) throw new BadInput(`description 最多 ${SKILL_DESCRIPTION_MAX} 字元`);
    return { name, description, frontmatter: fm, text, fixed };
  }
  if (!SKILL_NAME_RE.test(name)) {
    const slug = slugifySkillName(name) || slugifySkillName(opts.fallbackName ?? "") || "skill";
    fixed.push(`name「${name || "（空白）"}」改為「${slug}」`);
    name = slug;
  }
  if (!description) {
    const line = parsed.body.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#") && !l.startsWith("```"));
    description = (line ?? name).slice(0, SKILL_DESCRIPTION_MAX);
    fixed.push("缺少 description，已用內文第一段代替");
  } else if (description.length > SKILL_DESCRIPTION_MAX) {
    description = description.slice(0, SKILL_DESCRIPTION_MAX);
    fixed.push(`description 超過 ${SKILL_DESCRIPTION_MAX} 字元，已截斷`);
  }
  const out = fixed.length ? setFrontmatterFields(text, { name, description }) : text;
  return { name, description, frontmatter: { ...parseSkillMd(out).frontmatter }, text: out, fixed };
}

/** Directories (with trailing slash, "" = root) that contain a SKILL.md, outermost only. */
export function skillDirs(paths: string[]): string[] {
  const dirs = paths
    .filter((p) => p.split("/").pop()?.toLowerCase() === "skill.md")
    .map((p) => p.slice(0, p.length - "SKILL.md".length))
    .sort((a, b) => a.length - b.length);
  const out: string[] = [];
  for (const d of dirs) if (!out.some((o) => d.startsWith(o))) out.push(d);
  return out;
}

/** Files of one skill dir, relative to it (SKILL.md normalized to that exact name). */
export function filesUnder(all: SkillFiles, dir: string): SkillFiles {
  const out: SkillFiles = new Map();
  for (const [p, data] of all) {
    if (!p.startsWith(dir) || IGNORED(p)) continue;
    let rel = p.slice(dir.length);
    if (rel.toLowerCase() === "skill.md") rel = SKILL_MD;
    out.set(rel, data);
  }
  return out;
}

export function unzipSkills(zip: Uint8Array): { dir: string; files: SkillFiles }[] {
  let total = 0;
  let count = 0;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zip, {
      filter: (f) => {
        if (f.name.endsWith("/") || IGNORED(f.name)) return false;
        total += f.originalSize;
        count++;
        if (f.originalSize > MAX_SKILL_FILE_BYTES) throw new BadInput(`zip 內的檔案過大：${f.name}（單檔上限 5 MB）`);
        if (total > MAX_SKILL_TOTAL_BYTES * 2 || count > MAX_SKILL_FILES * MAX_SKILLS_PER_IMPORT) throw new BadInput("zip 解壓後過大");
        return true;
      },
    });
  } catch (e) {
    if (e instanceof BadInput) throw e;
    throw new BadInput(`無法解壓縮 zip：${(e as Error).message}`);
  }
  const all: SkillFiles = new Map(Object.entries(entries).map(([k, v]) => [k.replace(/^\/+/, ""), v]));
  const dirs = skillDirs([...all.keys()]);
  if (!dirs.length) throw new BadInput("zip 裡找不到 SKILL.md");
  if (dirs.length > MAX_SKILLS_PER_IMPORT) throw new BadInput(`一次最多匯入 ${MAX_SKILLS_PER_IMPORT} 個 Skills`);
  return dirs.map((dir) => ({ dir, files: filesUnder(all, dir) }));
}

export class SkillStore {
  constructor(public database: Database, public s3: S3) {}

  private get db() {
    return this.database.db;
  }

  key(r: Pick<SkillRow, "s3Prefix">, path: string) {
    return `${r.s3Prefix}${path}`;
  }

  async list(): Promise<SkillRow[]> {
    return this.db.select().from(skills).orderBy(asc(skills.name));
  }

  async byId(id: string): Promise<SkillRow | undefined> {
    const [r] = await this.db.select().from(skills).where(eq(skills.id, id)).limit(1);
    return r;
  }

  async byName(name: string): Promise<SkillRow | undefined> {
    const [r] = await this.db.select().from(skills).where(eq(skills.name, name)).limit(1);
    return r;
  }

  /** Enabled skills visible to a conversation (project `enabledSkills`: null = all, else skill ids). */
  async available(projectId: string | null): Promise<SkillRow[]> {
    let allowed: string[] | null = null;
    if (projectId) {
      const [p] = await this.db.select({ s: projects.enabledSkills }).from(projects).where(eq(projects.id, projectId)).limit(1);
      allowed = Array.isArray(p?.s) ? p.s : null;
    }
    return (await this.list()).filter((r) => r.enabled && (allowed === null || allowed.includes(r.id)));
  }

  /**
   * Create or replace a whole skill folder. `strict` validates SKILL.md as-is (editor / model);
   * otherwise name/description are repaired (imports). Existing skill with the same name: replaced when
   * `overwrite`, else SkillConflict. `replaceId` replaces that skill (rename allowed).
   */
  async saveFolder(
    input: SkillFiles,
    opts: { source: SkillSource; sourceUrl?: string | null; overwrite?: boolean; strict?: boolean; fallbackName?: string; replaceId?: string },
  ): Promise<{ row: SkillRow; fixed: string[] }> {
    const files: SkillFiles = new Map();
    for (const [raw, data] of input) {
      if (IGNORED(raw)) continue;
      const p = normalizePath(raw);
      if (data.byteLength > MAX_SKILL_FILE_BYTES) throw new BadInput(`檔案過大：${p}（單檔上限 5 MB）`);
      files.set(p, data);
    }
    const md = files.get(SKILL_MD);
    if (!md) throw new BadInput("Skill 資料夾必須包含 SKILL.md");
    if (files.size > MAX_SKILL_FILES) throw new BadInput(`一個 Skill 最多 ${MAX_SKILL_FILES} 個檔案`);
    const total = [...files.values()].reduce((n, d) => n + d.byteLength, 0);
    if (total > MAX_SKILL_TOTAL_BYTES) throw new BadInput("Skill 總大小上限 20 MB");

    const checked = checkSkillMd(dec.decode(md), { strict: !!opts.strict, fallbackName: opts.fallbackName });
    files.set(SKILL_MD, enc.encode(checked.text));

    const sameName = await this.byName(checked.name);
    let target = opts.replaceId ? await this.byId(opts.replaceId) : undefined;
    if (opts.replaceId && !target) throw new BadInput("找不到這個 Skill");
    if (sameName && sameName.id !== target?.id) {
      if (!opts.overwrite || target) throw new SkillConflict(`已經有名為「${checked.name}」的 Skill`);
      target = sameName;
    }

    const id = target?.id ?? crypto.randomUUID();
    const prefix = target?.s3Prefix ?? `skills/${id}/`;
    const manifest: SkillFileDTO[] = [];
    for (const [p, data] of [...files].sort(([a], [b]) => (a === SKILL_MD ? -1 : b === SKILL_MD ? 1 : a.localeCompare(b)))) {
      const mime = guessMime(p);
      await this.s3.put(`${prefix}${p}`, data, mime);
      manifest.push({ path: p, size: data.byteLength, mime });
    }
    if (target) {
      for (const old of target.files ?? []) if (!files.has(old.path)) await this.s3.delete(`${prefix}${old.path}`).catch(() => {});
    }
    const values = {
      name: checked.name, description: checked.description, frontmatter: checked.frontmatter, files: manifest,
      source: opts.source, sourceUrl: opts.sourceUrl ?? target?.sourceUrl ?? null, updatedAt: new Date(),
    };
    let row: SkillRow;
    if (target) [row] = await this.db.update(skills).set(values).where(eq(skills.id, id)).returning();
    else [row] = await this.db.insert(skills).values({ id, s3Prefix: prefix, ...values }).returning();
    return { row, fixed: checked.fixed };
  }

  async readFile(r: SkillRow, path: string): Promise<Uint8Array> {
    const p = normalizePath(path);
    if (!(r.files ?? []).some((f) => f.path === p)) throw new BadInput(`Skill「${r.name}」沒有檔案 ${p}`);
    const res = await this.s3.get(this.key(r, p));
    if (!res) throw new BadInput(`儲存空間找不到 ${p}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async readAll(r: SkillRow): Promise<SkillFiles> {
    const out: SkillFiles = new Map();
    for (const f of r.files ?? []) out.set(f.path, await this.readFile(r, f.path));
    return out;
  }

  /** Write one file; SKILL.md is re-validated strictly (name may change if unique). */
  async writeFile(r: SkillRow, path: string, data: Uint8Array, source?: SkillSource): Promise<SkillRow> {
    const p = normalizePath(path);
    if (data.byteLength > MAX_SKILL_FILE_BYTES) throw new BadInput("單檔上限 5 MB");
    const manifest = (r.files ?? []).filter((f) => f.path !== p);
    if (manifest.length + 1 > MAX_SKILL_FILES) throw new BadInput(`一個 Skill 最多 ${MAX_SKILL_FILES} 個檔案`);
    if (manifest.reduce((n, f) => n + f.size, 0) + data.byteLength > MAX_SKILL_TOTAL_BYTES) throw new BadInput("Skill 總大小上限 20 MB");
    const patch: Partial<typeof skills.$inferInsert> = { updatedAt: new Date() };
    if (source) patch.source = source;
    if (p === SKILL_MD) {
      const checked = checkSkillMd(dec.decode(data), { strict: true });
      const other = await this.byName(checked.name);
      if (other && other.id !== r.id) throw new SkillConflict(`已經有名為「${checked.name}」的 Skill`);
      Object.assign(patch, { name: checked.name, description: checked.description, frontmatter: checked.frontmatter });
    }
    const mime = guessMime(p);
    await this.s3.put(this.key(r, p), data, mime);
    manifest.push({ path: p, size: data.byteLength, mime });
    manifest.sort((a, b) => (a.path === SKILL_MD ? -1 : b.path === SKILL_MD ? 1 : a.path.localeCompare(b.path)));
    patch.files = manifest;
    const [row] = await this.db.update(skills).set(patch).where(eq(skills.id, r.id)).returning();
    return row;
  }

  async deleteFile(r: SkillRow, path: string): Promise<SkillRow> {
    const p = normalizePath(path);
    if (p === SKILL_MD) throw new BadInput("不能刪除 SKILL.md（要移除整個 Skill 請刪除 Skill）");
    if (!(r.files ?? []).some((f) => f.path === p)) throw new BadInput(`沒有檔案 ${p}`);
    await this.s3.delete(this.key(r, p)).catch(() => {});
    const [row] = await this.db.update(skills).set({ files: r.files.filter((f) => f.path !== p), updatedAt: new Date() }).where(eq(skills.id, r.id)).returning();
    return row;
  }

  async remove(r: SkillRow): Promise<void> {
    for (const f of r.files ?? []) await this.s3.delete(this.key(r, f.path)).catch(() => {});
    await this.db.delete(skills).where(eq(skills.id, r.id));
    // drop it from project allow-lists
    const ps = await this.db.select({ id: projects.id, s: projects.enabledSkills }).from(projects);
    for (const p of ps) if (Array.isArray(p.s) && p.s.includes(r.id)) await this.db.update(projects).set({ enabledSkills: p.s.filter((x) => x !== r.id) }).where(eq(projects.id, p.id));
  }

  async exportZip(r: SkillRow): Promise<Uint8Array> {
    const files = await this.readAll(r);
    const tree: Record<string, Uint8Array> = {};
    for (const [p, d] of files) tree[`${r.name}/${p}`] = d;
    return zipSync(tree, { level: 6 });
  }
}
