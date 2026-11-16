import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { strToU8, unzipSync, zipSync } from "fflate";
import { eq } from "drizzle-orm";
import { settings, skills } from "../src/db/schema";
import { resetBuiltinSkillsMemo } from "../src/skills/builtin";
import { parseSkillMd, parseYamlSubset, setFrontmatterFields } from "../src/skills/frontmatter";
import { checkSkillMd, skillDirs, slugifySkillName } from "../src/skills/store";
import { parseGithubUrl } from "../src/skills/github";
import { Harness, callsReply, textReply } from "./harness";
import { S3Mock } from "./s3-mock";

const s3 = new S3Mock();
const h = new Harness({ deps: { s3Fetch: s3.fetch } });

const md = (name: string, description: string, body = "# 標題\n內容\n") => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;
const toolMsgs = (body: any) => {
  const out: any[] = [];
  for (let i = body.messages.length - 1; i >= 0 && body.messages[i].role === "tool"; i--) { const m = body.messages[i].content; try { out.unshift(JSON.parse(m)); } catch { out.unshift(m); } }
  return out;
};

beforeAll(async () => {
  await h.setup();
  await h.client().req("PUT", "/permissions/mode", { scope: "global", mode: "auto_edit" });
});
afterAll(() => h.teardown());
beforeEach(() => {
  h.script = [];
  h.llmBodies = [];
  h.routes = [];
});

describe("SKILL.md parsing", () => {
  it("parses the YAML subset used by Agent Skills", () => {
    const y = parseYamlSubset(
      [
        "name: pdf-tools",
        'description: "處理 PDF: 合併、分割"',
        "license: Apache-2.0",
        "allowed-tools: [Read, Bash]",
        "metadata:",
        "  author: someone",
        "  version: 1.2",
        "notes: |",
        "  第一行",
        "  第二行",
        "folded: >-",
        "  a",
        "  b",
        "list:",
        "  - x",
        "  - y",
        "# comment",
      ].join("\n"),
    );
    expect(y).toEqual({
      name: "pdf-tools", description: "處理 PDF: 合併、分割", license: "Apache-2.0", "allowed-tools": ["Read", "Bash"],
      metadata: { author: "someone", version: 1.2 }, notes: "第一行\n第二行\n", folded: "a b", list: ["x", "y"],
    });
    const p = parseSkillMd("\uFEFF---\r\nname: a\r\ndescription: b\r\n---\r\nbody\r\n");
    expect(p).toMatchObject({ hasFrontmatter: true, frontmatter: { name: "a", description: "b" }, body: "body\n" });
    expect(parseSkillMd("# no front matter").hasFrontmatter).toBe(false);
  });

  it("validates strictly and repairs leniently", () => {
    expect(() => checkSkillMd("# x", { strict: true })).toThrow(/front matter/);
    expect(() => checkSkillMd(md("Bad Name", "d"), { strict: true })).toThrow(/小寫/);
    expect(() => checkSkillMd(md("ok-name", ""), { strict: true })).toThrow(/description/);
    const fixed = checkSkillMd("---\nname: My Cool Skill!\nmetadata:\n  a: 1\n---\n# H\n第一段說明。\n", { strict: false });
    expect(fixed.name).toBe("my-cool-skill");
    expect(fixed.description).toBe("第一段說明。");
    expect(parseSkillMd(fixed.text).frontmatter).toMatchObject({ name: "my-cool-skill", description: "第一段說明。", metadata: { a: 1 } });
    expect(slugifySkillName("中文")).toBe("");
    expect(checkSkillMd("# 只有內文\n", { strict: false, fallbackName: "From_Dir" }).name).toBe("from-dir");
    expect(setFrontmatterFields(md("a", "old: value"), { description: "new: value" })).toContain('description: "new: value"');
  });

  it("finds outermost skill folders and parses GitHub URLs", () => {
    expect(skillDirs(["a/SKILL.md", "a/sub/SKILL.md", "b/c/skill.md", "README.md"])).toEqual(["a/", "b/c/"]);
    expect(skillDirs(["SKILL.md", "x/SKILL.md"])).toEqual([""]);
    expect(parseGithubUrl("https://github.com/o/r")).toEqual({ owner: "o", repo: "r", ref: null, path: "" });
    expect(parseGithubUrl("https://github.com/o/r/tree/main/skills/pdf")).toEqual({ owner: "o", repo: "r", ref: "main", path: "skills/pdf" });
    expect(parseGithubUrl("https://github.com/o/r/blob/v1/skills/pdf/SKILL.md")).toEqual({ owner: "o", repo: "r", ref: "v1", path: "skills/pdf" });
    expect(parseGithubUrl("https://raw.githubusercontent.com/o/r/main/x/SKILL.md")).toEqual({ owner: "o", repo: "r", ref: "main", path: "x" });
    expect(() => parseGithubUrl("https://gitlab.com/o/r")).toThrow(/github/);
  });
});

describe("skills API", () => {
  it("editor create → detail → edit files → rename → conflict → export zip → delete", async () => {
    const c = h.client();
    const bad = await c.post("/skills", { content: "# 沒有 front matter" });
    expect(bad.status).toBe(400);
    const r = await c.post("/skills", { content: md("meeting-notes", "把會議逐字稿整理成正體中文會議紀錄") });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ name: "meeting-notes", source: "editor", enabled: true, files: [{ path: "SKILL.md" }] });
    expect(r.body.skillMd).toContain("會議逐字稿");
    const id = r.body.id;
    expect([...s3.objects.keys()].some((k) => k.endsWith(`skills/${id}/SKILL.md`))).toBe(true);

    const w = await c.req("PUT", `/skills/${id}/file`, { path: "references/template.md", content: "## 範本\n" });
    expect(w.body.files.map((f: any) => f.path)).toEqual(["SKILL.md", "references/template.md"]);
    expect((await c.req("PUT", `/skills/${id}/file`, { path: "../x", content: "" })).status).toBe(400);
    const file = await c.get(`/skills/${id}/file?path=references/template.md`);
    expect(file.body).toBe("## 範本\n");

    // rename through SKILL.md; another skill with that name → 409
    await c.post("/skills", { content: md("other-skill", "另一個") });
    expect((await c.req("PUT", `/skills/${id}/file`, { path: "SKILL.md", content: md("other-skill", "x") })).status).toBe(409);
    const renamed = await c.req("PUT", `/skills/${id}/file`, { path: "SKILL.md", content: md("minutes", "會議紀錄") });
    expect(renamed.body).toMatchObject({ name: "minutes", description: "會議紀錄" });
    expect((await c.post("/skills", { content: md("minutes", "dup") })).status).toBe(409);

    const zip = await c.req("GET", `/skills/${id}/export`, undefined, { bytes: true });
    expect(zip.headers.get("content-type")).toBe("application/zip");
    const entries = unzipSync(zip.body as unknown as Uint8Array);
    expect(Object.keys(entries).sort()).toEqual(["minutes/SKILL.md", "minutes/references/template.md"]);

    expect((await c.req("DELETE", `/skills/${id}/file?path=SKILL.md`)).status).toBe(400);
    const del = await c.req("DELETE", `/skills/${id}/file?path=references/template.md`);
    expect(del.body.files).toHaveLength(1);
    expect((await c.req("PATCH", `/skills/${id}`, { enabled: false })).body.enabled).toBe(false);
    expect((await c.req("DELETE", `/skills/${id}`)).status).toBe(200);
    expect([...s3.objects.keys()].some((k) => k.includes(`skills/${id}/`))).toBe(false);
    const list = await c.get("/skills");
    expect(list.body.map((s: any) => s.name).filter((n: string) => !["e2b-sandbox", "self-hosted-runner"].includes(n))).toEqual(["other-skill"]);
    await c.req("DELETE", `/skills/${list.body[0].id}`);
  });

  it("zip upload: several skills, nested folders, repairs, conflicts and overwrite", async () => {
    const c = h.client();
    const zip = zipSync({
      "bundle/alpha/SKILL.md": strToU8(md("alpha", "第一個")),
      "bundle/alpha/scripts/run.py": strToU8("print('hi')\n"),
      "bundle/alpha/nested/SKILL.md": strToU8(md("nested", "不應該分開匯入")),
      "bundle/Beta Skill/skill.md": strToU8("---\nname: Beta Skill\n---\n說明 beta。\n"),
      "__MACOSX/bundle/alpha/._SKILL.md": strToU8("junk"),
      "bundle/README.md": strToU8("readme"),
    });
    const r = await c.req("POST", "/skills/upload", zip, { headers: { "content-type": "application/zip" } });
    expect(r.status).toBe(200);
    expect(r.body.imported.map((s: any) => s.name).sort()).toEqual(["alpha", "beta-skill"]);
    const alpha = r.body.imported.find((s: any) => s.name === "alpha");
    expect(alpha.files.map((f: any) => f.path)).toEqual(["SKILL.md", "nested/SKILL.md", "scripts/run.py"]);
    expect(r.body.skipped.find((s: any) => s.name === "beta-skill").reason).toMatch(/自動修正/);

    const again = await c.req("POST", "/skills/upload", zipSync({ "alpha/SKILL.md": strToU8(md("alpha", "第二版")) }), { headers: { "content-type": "application/zip" } });
    expect(again.body.imported).toHaveLength(0);
    expect(again.body.skipped[0].reason).toMatch(/已經有/);
    const over = await c.req("POST", "/skills/upload?overwrite=1", zipSync({ "alpha/SKILL.md": strToU8(md("alpha", "第二版")) }), { headers: { "content-type": "application/zip" } });
    expect(over.body.imported[0]).toMatchObject({ id: alpha.id, description: "第二版", files: [{ path: "SKILL.md" }] });
    expect([...s3.objects.keys()].some((k) => k.endsWith(`skills/${alpha.id}/scripts/run.py`))).toBe(false); // stale file removed

    expect((await c.req("POST", "/skills/upload", strToU8("not a zip"), { headers: { "content-type": "application/zip" } })).status).toBe(400);
    expect((await c.req("POST", "/skills/upload", zipSync({ "a.txt": strToU8("x") }), { headers: { "content-type": "application/zip" } })).body.message).toMatch(/SKILL\.md/);
    for (const s of (await c.get("/skills")).body) await c.req("DELETE", `/skills/${s.id}`);
  });

  it("GitHub import via the trees API + raw files (with optional encrypted token)", async () => {
    const c = h.client();
    expect((await c.req("PUT", "/settings/github", { token: "ghp_secret123" })).body.configured).toBe(true);
    const seen: { url: string; auth?: string }[] = [];
    h.routes.push((url, init) => {
      const auth = (init.headers as Record<string, string> | undefined)?.authorization;
      if (url.hostname === "api.github.com" || url.hostname === "raw.githubusercontent.com") seen.push({ url: url.href, auth });
      if (url.href === "https://api.github.com/repos/acme/skills") return Response.json({ default_branch: "main" });
      if (url.href === "https://api.github.com/repos/acme/skills/git/trees/main?recursive=1")
        return Response.json({
          truncated: false,
          tree: [
            { path: "README.md", type: "blob", size: 3 },
            { path: "skills", type: "tree" },
            { path: "skills/pdf/SKILL.md", type: "blob", size: 40 },
            { path: "skills/pdf/reference.md", type: "blob", size: 5 },
            { path: "skills/xlsx/SKILL.md", type: "blob", size: 40 },
          ],
        });
      if (url.hostname === "raw.githubusercontent.com") {
        const map: Record<string, string> = {
          "/acme/skills/main/skills/pdf/SKILL.md": md("pdf", "PDF 工具"),
          "/acme/skills/main/skills/pdf/reference.md": "參考資料",
          "/acme/skills/main/skills/xlsx/SKILL.md": md("xlsx", "試算表"),
        };
        return map[url.pathname] ? new Response(map[url.pathname]) : new Response("nf", { status: 404 });
      }
      return undefined;
    });
    const all = await c.post("/skills/import", { url: "https://github.com/acme/skills" });
    expect(all.status).toBe(200);
    expect(all.body.imported.map((s: any) => [s.name, s.source, s.sourceUrl])).toEqual([
      ["pdf", "github", "https://github.com/acme/skills/tree/main/skills/pdf"],
      ["xlsx", "github", "https://github.com/acme/skills/tree/main/skills/xlsx"],
    ]);
    expect(seen.every((s) => s.auth === "Bearer ghp_secret123")).toBe(true);
    const pdf = (await c.get(`/skills/${all.body.imported[0].id}`)).body;
    expect(pdf.files.map((f: any) => f.path)).toEqual(["SKILL.md", "reference.md"]);

    const one = await c.post("/skills/import", { url: "https://github.com/acme/skills/blob/main/skills/pdf/SKILL.md", overwrite: true });
    expect(one.body.imported.map((s: any) => s.name)).toEqual(["pdf"]);
    expect((await c.post("/skills/import", { url: "https://github.com/acme/skills/tree/main/nothing" })).body.message).toMatch(/找不到 SKILL\.md/);
    await c.req("PUT", "/settings/github", { token: null });
    expect((await c.get("/settings/github")).body.configured).toBe(false);
    for (const s of (await c.get("/skills")).body) await c.req("DELETE", `/skills/${s.id}`);
  });
});

describe("skills in the agent loop", () => {
  it("system prompt lists only names + descriptions; skill_load returns instructions and files; project filter applies", async () => {
    const c = h.client();
    const a = await c.post("/skills", { content: md("brew-coffee", "沖煮手沖咖啡的步驟", "# 手沖\n1. 磨豆\n2. 悶蒸 30 秒\n") });
    await c.req("PUT", `/skills/${a.body.id}/file`, { path: "ratios.md", content: "1:15 粉水比" });
    const b = await c.post("/skills", { content: md("hidden-skill", "專案裡不啟用") });

    h.script = [
      callsReply([{ id: "l1", name: "skill_load", args: { name: "brew-coffee" } }]),
      callsReply([{ id: "l2", name: "skill_load", args: { name: "brew-coffee", path: "ratios.md" } }, { id: "l3", name: "skill_load", args: { name: "nope" } }]),
      textReply("好"),
    ];
    const r = await h.chat({ content: "教我手沖" });
    expect(r.events.at(-1)).toMatchObject({ type: "done" });
    const sys = h.llmBodies[0].messages[0].content as string;
    expect(sys).toContain("# 可用的 Skills");
    expect(sys).toContain("- brew-coffee：沖煮手沖咖啡的步驟");
    expect(sys).not.toContain("悶蒸"); // progressive disclosure: body not in the prompt
    const [loaded] = toolMsgs(h.llmBodies[1]);
    expect(loaded).toMatchObject({ name: "brew-coffee", files: [{ path: "ratios.md" }] });
    expect(loaded.instructions).toContain("悶蒸 30 秒");
    expect(loaded.instructions).not.toContain("description:");
    const [ref, missing] = toolMsgs(h.llmBodies[2]);
    expect(ref.content).toBe("1:15 粉水比");
    expect(JSON.stringify(missing)).toMatch(/找不到可用的 Skill/);

    // project allow-list: only brew-coffee
    const pid = (await c.post("/projects", { name: "咖啡專案" })).body.id;
    const patched = await c.req("PATCH", `/projects/${pid}`, { enabledSkills: [a.body.id] });
    expect(patched.body.enabledSkills).toEqual([a.body.id]);
    h.llmBodies = [];
    h.script = [callsReply([{ id: "p1", name: "skill_load", args: { name: "hidden-skill" } }]), textReply("ok")];
    await h.chat({ content: "x", projectId: pid });
    const psys = h.llmBodies[0].messages[0].content as string;
    expect(psys).toContain("brew-coffee");
    expect(psys).not.toContain("hidden-skill");
    expect(JSON.stringify(toolMsgs(h.llmBodies[1]))).toMatch(/找不到可用的 Skill/);

    // disabled skills disappear everywhere
    await c.req("PATCH", `/skills/${a.body.id}`, { enabled: false });
    h.llmBodies = [];
    h.script = [textReply("ok")];
    await h.chat({ content: "y", projectId: pid });
    expect(h.llmBodies[0].messages[0].content).not.toContain("# 可用的 Skills");
    // deleting a skill removes it from project allow-lists
    await c.req("DELETE", `/skills/${a.body.id}`);
    expect((await c.get(`/projects/${pid}`)).body.enabledSkills ?? (await c.get("/projects")).body.find((p: any) => p.id === pid).enabledSkills).toEqual([]);
    await c.req("DELETE", `/skills/${b.body.id}`);
  });

  it("skill_write is a write tool: asks in normal mode, creates and edits skills in auto_edit, validates SKILL.md", async () => {
    const c = h.client();
    h.script = [
      callsReply([
        { id: "w1", name: "skill_write", args: { name: "release-notes", content: md("release-notes", "撰寫版本說明") } },
      ]),
      callsReply([
        { id: "w2", name: "skill_write", args: { name: "release-notes", path: "examples/v1.md", content: "## v1\n" } },
        { id: "w3", name: "skill_write", args: { name: "ghost", path: "a.md", content: "x" } },
        { id: "w4", name: "skill_write", args: { name: "bad", content: "沒有 front matter" } },
        { id: "w5", name: "skill_write", args: { name: "mismatch", content: md("other", "x") } },
      ]),
      textReply("完成"),
    ];
    await h.chat({ content: "建立版本說明 Skill" });
    const res = [...toolMsgs(h.llmBodies[1]), ...toolMsgs(h.llmBodies[2])];
    expect(res[0]).toMatchObject({ ok: true, created: true, name: "release-notes" });
    expect(res[1]).toMatchObject({ ok: true, created: false, files: ["SKILL.md", "examples/v1.md"] });
    expect(JSON.stringify(res[2])).toMatch(/請先寫入 SKILL\.md/);
    expect(JSON.stringify(res[3])).toMatch(/front matter/);
    expect(JSON.stringify(res[4])).toMatch(/必須與參數 name/);
    const list = (await c.get("/skills")).body;
    expect(list).toEqual([expect.objectContaining({ name: "release-notes", source: "model" })]);

    // normal mode → approval required, nothing written yet
    await c.req("PUT", "/permissions/mode", { scope: "global", mode: "normal" });
    h.script = [callsReply([{ id: "n1", name: "skill_write", args: { name: "release-notes", path: "x.md", content: "x" } }])];
    const r = await h.chat({ content: "再加一個檔" });
    expect(r.events.find((e) => e.type === "approval-required")).toBeTruthy();
    expect((await c.get(`/skills/${list[0].id}`)).body.files.map((f: any) => f.path)).not.toContain("x.md");
    await c.req("PUT", "/permissions/mode", { scope: "global", mode: "auto_edit" });
  });
});

describe("bundled skill upgrades", () => {
  const NODE_TEMPLATE = "references/node-template.md";
  /** Make the installed e2b-sandbox look like a version-2 install (no node-template.md, seed state at 2). */
  const downgradeToV2 = async (id: string) => {
    const db = h.t.database.db;
    const [row] = await db.select().from(skills).where(eq(skills.id, id));
    await db.update(skills).set({ files: row.files.filter((f) => f.path !== NODE_TEMPLATE) }).where(eq(skills.id, id));
    await db.update(settings).set({ value: { "e2b-sandbox": { version: 2 }, "self-hosted-runner": { version: 1 } } }).where(eq(settings.key, "builtin_skills"));
    resetBuiltinSkillsMemo(h.t.database);
  };
  const e2b = async () => (await h.client().get("/skills")).body.find((s: any) => s.name === "e2b-sandbox");

  beforeEach(async () => {
    // earlier tests delete the bundled skills (remembered as removed): start from a fresh install
    const db = h.t.database.db;
    await db.delete(skills).where(eq(skills.name, "e2b-sandbox"));
    await db.delete(settings).where(eq(settings.key, "builtin_skills"));
    resetBuiltinSkillsMemo(h.t.database);
  });

  it("an untouched builtin e2b-sandbox at version 2 upgrades to version 3 and gains references/node-template.md", async () => {
    const c = h.client();
    const before = await e2b();
    expect(before.source).toBe("builtin");
    await downgradeToV2(before.id);
    expect((await c.get(`/skills/${before.id}`)).body.files.map((f: any) => f.path)).not.toContain(NODE_TEMPLATE);

    const after = await e2b();
    expect(after.id).toBe(before.id);
    expect(after.source).toBe("builtin");
    expect(after.files.map((f: any) => f.path)).toContain(NODE_TEMPLATE);
    const file = await c.get(`/skills/${after.id}/file?path=${NODE_TEMPLATE}`);
    expect(file.status).toBe(200);
    expect(String(file.body).length).toBeGreaterThan(0);
    const [st] = await h.t.database.db.select().from(settings).where(eq(settings.key, "builtin_skills"));
    expect((st.value as any)["e2b-sandbox"].version).toBe(3);
  });

  it("a user-edited e2b-sandbox at version 2 is left alone", async () => {
    const c = h.client();
    const s = await e2b();
    const edited = await c.req("PUT", `/skills/${s.id}/file`, { path: "references/api.md", content: "# my own notes\n" });
    expect(edited.body.source).toBe("editor");
    await downgradeToV2(s.id);

    const after = await e2b();
    expect(after.id).toBe(s.id);
    expect(after.source).toBe("editor");
    expect(after.files.map((f: any) => f.path)).not.toContain(NODE_TEMPLATE);
    expect((await c.get(`/skills/${s.id}/file?path=references/api.md`)).body).toBe("# my own notes\n");
  });
});
