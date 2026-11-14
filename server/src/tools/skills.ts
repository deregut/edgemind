/**
 * Skills with progressive disclosure: the system prompt lists only name + description of the skills available
 * to the conversation; skill_load [read] returns the full SKILL.md (and, on request, any bundled file);
 * skill_write [write] lets the model create or update a skill (permission-gated, targets `skills/{name}/{path}`).
 */
import { asc, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { projects, skills } from "../db/schema";
import type { Tool, ToolContext } from "../agent/tools";
import { isTextMime } from "../storage/files";
import { decodeUtf8Window } from "../storage/files";
import { parseSkillMd } from "../skills/frontmatter";
import { SKILL_MD, SkillConflict, SkillStore, type SkillRow } from "../skills/store";
import { ensureBuiltinSkills } from "../skills/builtin";

const MAX_CHARS = 40_000;
const enc = new TextEncoder();

async function storeOf(ctx: ToolContext): Promise<SkillStore> {
  if (!ctx.storage) throw new Error("物件儲存未設定（S3_* 環境變數），無法使用 Skills");
  const store = new SkillStore(ctx.database, ctx.storage.s3);
  await ensureBuiltinSkills(store);
  return store;
}

/** How bundled scripts can be run (M11a). */
export const SCRIPT_NOTE =
  "附檔可用 skill_load 並指定 path 讀取。Skill 內的腳本不會自動執行：JavaScript 腳本可讀取內容後用 code_run（language=javascript，伺服器端 QuickJS，無網路）執行；" +
  "Python 腳本可用 code_run（language=python，在使用者瀏覽器的 Pyodide 執行，需開啟中的聊天分頁）或載入 e2b-sandbox Skill 在雲端沙盒執行；其他語言可用 self-hosted-runner Skill。";

async function findAvailable(store: SkillStore, ctx: ToolContext, name: string): Promise<SkillRow> {
  const all = await store.available(ctx.projectId);
  const r = all.find((s) => s.name === name) ?? all.find((s) => s.name.toLowerCase() === name.toLowerCase());
  if (!r) throw new Error(`找不到可用的 Skill「${name}」。可用的有：${all.map((s) => s.name).join("、") || "（無）"}`);
  return r;
}

function windowText(bytes: Uint8Array, offset: number): { text: string; nextOffset: number | null; totalBytes: number } {
  const start = Math.max(0, Math.min(offset, bytes.length));
  const slice = bytes.subarray(start, start + MAX_CHARS * 3);
  const last = start + slice.length >= bytes.length;
  const w = decodeUtf8Window(slice, last);
  let text = w.text;
  let used = w.used;
  if (text.length > MAX_CHARS) {
    text = text.slice(0, MAX_CHARS);
    used = w.skipped + enc.encode(text).length;
  }
  const next = start + used;
  return { text, nextOffset: next < bytes.length ? next : null, totalBytes: bytes.length };
}

export const skillLoadTool: Tool = {
  name: "skill_load",
  description:
    "載入一個 Skill 的完整說明（SKILL.md）與附檔清單。任務符合系統提示「可用的 Skills」中某個描述時，先載入它再依照指示做。" +
    "SKILL.md 提到的參考檔或腳本可用 path 讀取；內容很長時用 offset 續讀（回傳 nextOffset）。",
  risk: "read",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Skill 名稱" },
      path: { type: "string", description: "要讀的附檔路徑（相對於 Skill 資料夾），省略則讀 SKILL.md" },
      offset: { type: "integer", minimum: 0, description: "位元組位移（續讀用）" },
    },
    required: ["name"],
  },
  targets: () => ({}),
  async execute(args, ctx) {
    const store = await storeOf(ctx);
    const r = await findAvailable(store, ctx, String(args?.name ?? "").trim());
    const path = typeof args?.path === "string" && args.path.trim() ? args.path.trim().replace(/^\.\//, "") : SKILL_MD;
    const offset = Number.isInteger(args?.offset) ? args.offset : 0;
    const meta = r.files.find((f) => f.path === path);
    if (!meta) throw new Error(`Skill「${r.name}」沒有檔案 ${path}。檔案：${r.files.map((f) => f.path).join("、")}`);
    if (!isTextMime(meta.mime, path)) return { name: r.name, path, mime: meta.mime, size: meta.size, note: "這是二進位檔，無法以文字讀取。" };
    const bytes = await store.readFile(r, path);
    const w = windowText(bytes, offset);
    if (path !== SKILL_MD) return { name: r.name, path, content: w.text, nextOffset: w.nextOffset, totalBytes: w.totalBytes };
    const body = offset === 0 ? parseSkillMd(w.text).body : w.text;
    return {
      name: r.name,
      description: r.description,
      instructions: body,
      nextOffset: w.nextOffset,
      files: r.files.filter((f) => f.path !== SKILL_MD).map((f) => ({ path: f.path, size: f.size })),
      note: SCRIPT_NOTE,
    };
  },
};

export const skillWriteTool: Tool = {
  name: "skill_write",
  description:
    "建立或修改 Skill（寫入一個檔案）。新 Skill 先寫 SKILL.md：必須以 YAML front matter 開頭，含 name（小寫英數與連字號）與 description（做什麼、何時使用），" +
    "之後可加參考檔（例如 references/guide.md）。修改既有 Skill 時 name 填目前名稱。",
  risk: "write",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Skill 名稱（新建時須與 SKILL.md 的 name 相同）" },
      path: { type: "string", description: "檔案路徑，預設 SKILL.md" },
      content: { type: "string", description: "完整檔案內容（整份覆寫）" },
    },
    required: ["name", "content"],
  },
  targets: (args: any) => ({ paths: [`skills/${String(args?.name ?? "")}/${typeof args?.path === "string" && args.path ? args.path : SKILL_MD}`] }),
  async execute(args, ctx) {
    const store = await storeOf(ctx);
    const name = String(args?.name ?? "").trim();
    const path = typeof args?.path === "string" && args.path.trim() ? args.path.trim().replace(/^\.\//, "") : SKILL_MD;
    if (typeof args?.content !== "string") throw new Error("content 必須是字串");
    const data = enc.encode(args.content);
    const existing = await store.byName(name);
    try {
      if (!existing) {
        if (path !== SKILL_MD) throw new Error(`Skill「${name}」不存在：請先寫入 SKILL.md 建立它`);
        const parsed = parseSkillMd(args.content);
        const fm = parsed.frontmatter;
        if (parsed.hasFrontmatter && fm.name !== name) throw new Error(`SKILL.md 的 name（${String(fm.name ?? "")}）必須與參數 name（${name}）相同`);
        const { row } = await store.saveFolder(new Map([[SKILL_MD, data]]), { source: "model", strict: true });
        return { ok: true, created: true, name: row.name, files: row.files.map((f) => f.path), note: "新 Skill 已建立並啟用。" };
      }
      const row = await store.writeFile(existing, path, data, "model");
      return { ok: true, created: false, name: row.name, path, files: row.files.map((f) => f.path) };
    } catch (e) {
      if (e instanceof SkillConflict) throw new Error(e.message);
      throw e;
    }
  },
};

export const skillTools: Tool[] = [skillLoadTool, skillWriteTool];

/** System-prompt section: names + descriptions only (progressive disclosure). */
export async function skillsSection(database: Database, projectId: string | null): Promise<string> {
  let allowed: string[] | null = null;
  if (projectId) {
    const [p] = await database.db.select({ s: projects.enabledSkills }).from(projects).where(eq(projects.id, projectId)).limit(1);
    allowed = Array.isArray(p?.s) ? p.s : null;
  }
  const rows = (await database.db.select({ id: skills.id, name: skills.name, description: skills.description, enabled: skills.enabled }).from(skills).orderBy(asc(skills.name)))
    .filter((r) => r.enabled && (allowed === null || allowed.includes(r.id)));
  if (!rows.length) return "";
  const lines = rows.slice(0, 100).map((r) => `- ${r.name}：${r.description.replace(/\s+/g, " ").slice(0, 300)}`);
  return `任務符合下列某個 Skill 的描述時，先用 skill_load 載入它的完整指示再執行；不相關時不要載入。\n${lines.join("\n")}`;
}
