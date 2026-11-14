/**
 * Import skills from a GitHub URL (public repos; optional token for private ones / rate limits):
 *   https://github.com/{o}/{r}                      → every skill folder in the default branch
 *   https://github.com/{o}/{r}/tree/{ref}/{path}    → that folder (a skill, or a folder of skills)
 *   https://github.com/{o}/{r}/blob/{ref}/{path}/SKILL.md
 *   https://raw.githubusercontent.com/{o}/{r}/{ref}/{path}/SKILL.md
 * One git-trees API call lists the repo; file contents come from raw.githubusercontent.com.
 * `ref` is a single path segment (branch / tag / sha); branch names containing "/" are not supported.
 */
import { BadInput } from "../lib/errors";
import { MAX_SKILL_FILES, MAX_SKILL_FILE_BYTES, MAX_SKILL_TOTAL_BYTES, MAX_SKILLS_PER_IMPORT, skillDirs, type SkillFiles } from "./store";

export interface GithubRef {
  owner: string;
  repo: string;
  ref: string | null;
  path: string;
}

export function parseGithubUrl(input: string): GithubRef {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    throw new BadInput("請輸入 GitHub 網址");
  }
  const segs = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const ok = /^[A-Za-z0-9_.-]+$/;
  if (u.hostname === "raw.githubusercontent.com") {
    if (segs.length < 3) throw new BadInput("無法解析這個 GitHub 網址");
    const [owner, repo, ref, ...rest] = segs;
    if (!ok.test(owner) || !ok.test(repo)) throw new BadInput("無法解析這個 GitHub 網址");
    return { owner, repo, ref, path: dirOfSkillMd(rest.join("/")) };
  }
  if (u.hostname !== "github.com" && u.hostname !== "www.github.com") throw new BadInput("目前只支援 github.com 的網址");
  if (segs.length < 2) throw new BadInput("網址需要包含 owner/repo");
  const owner = segs[0];
  const repo = segs[1].replace(/\.git$/, "");
  if (!ok.test(owner) || !ok.test(repo)) throw new BadInput("無法解析這個 GitHub 網址");
  if (segs.length >= 4 && (segs[2] === "tree" || segs[2] === "blob")) return { owner, repo, ref: segs[3], path: dirOfSkillMd(segs.slice(4).join("/")) };
  if (segs.length > 2) throw new BadInput("請使用 repo 首頁、/tree/… 或 /blob/…/SKILL.md 形式的網址");
  return { owner, repo, ref: null, path: "" };
}

function dirOfSkillMd(p: string): string {
  const clean = p.replace(/^\/+|\/+$/g, "");
  if (/(^|\/)skill\.md$/i.test(clean)) return clean.replace(/\/?[^/]+$/, "");
  if (/\.[a-z0-9]+$/i.test(clean.split("/").pop() ?? "")) throw new BadInput("請指向 Skill 資料夾或它的 SKILL.md");
  return clean;
}

type Fetch = typeof fetch;

async function gh(fetchFn: Fetch, url: string, token?: string | null): Promise<Response> {
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "EdgeMind", "x-github-api-version": "2022-11-28" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetchFn(url, { headers, signal: AbortSignal.timeout(20_000) });
  if (res.status === 404) throw new BadInput("GitHub 找不到這個 repo / 分支（私有 repo 需要在設定中填入 GitHub Token）");
  if (res.status === 403 || res.status === 429) throw new BadInput("GitHub API 達到速率限制，請稍後再試或在設定中填入 GitHub Token");
  if (!res.ok) throw new BadInput(`GitHub 回應 HTTP ${res.status}`);
  return res;
}

/** Returns one entry per skill folder found under the URL's path. */
export async function fetchGithubSkills(fetchFn: Fetch, url: string, token?: string | null): Promise<{ dir: string; files: SkillFiles; sourceUrl: string }[]> {
  const g = parseGithubUrl(url);
  const api = `https://api.github.com/repos/${g.owner}/${g.repo}`;
  let ref = g.ref;
  if (!ref) ref = String(((await (await gh(fetchFn, api, token)).json()) as { default_branch?: string }).default_branch ?? "main");
  const tree = (await (await gh(fetchFn, `${api}/git/trees/${encodeURIComponent(ref)}?recursive=1`, token)).json()) as {
    tree?: { path: string; type: string; size?: number }[];
    truncated?: boolean;
  };
  const prefix = g.path ? `${g.path}/` : "";
  const blobs = (tree.tree ?? []).filter((t) => t.type === "blob" && t.path.startsWith(prefix));
  const dirs = skillDirs(blobs.map((b) => b.path));
  if (!dirs.length) throw new BadInput(tree.truncated ? "repo 太大，GitHub 回傳的檔案清單被截斷：請改用指向 Skill 資料夾的網址" : "這個位置找不到 SKILL.md");
  if (dirs.length > MAX_SKILLS_PER_IMPORT) throw new BadInput(`這個位置有 ${dirs.length} 個 Skills，一次最多匯入 ${MAX_SKILLS_PER_IMPORT} 個：請指向其中一個子資料夾`);

  const out: { dir: string; files: SkillFiles; sourceUrl: string }[] = [];
  for (const dir of dirs) {
    const mine = blobs.filter((b) => b.path.startsWith(dir) && !b.path.split("/").some((s) => s === ".git" || s === "__MACOSX"));
    if (mine.length > MAX_SKILL_FILES) throw new BadInput(`${dir || "根目錄"} 的檔案超過 ${MAX_SKILL_FILES} 個`);
    if (mine.some((b) => (b.size ?? 0) > MAX_SKILL_FILE_BYTES)) throw new BadInput(`${dir || "根目錄"} 有超過 5 MB 的檔案`);
    if (mine.reduce((n, b) => n + (b.size ?? 0), 0) > MAX_SKILL_TOTAL_BYTES) throw new BadInput(`${dir || "根目錄"} 總大小超過 20 MB`);
    const files: SkillFiles = new Map();
    const queue = [...mine];
    const worker = async () => {
      for (let b = queue.shift(); b; b = queue.shift()) {
        const raw = `https://raw.githubusercontent.com/${g.owner}/${g.repo}/${encodeURIComponent(ref!)}/${b.path.split("/").map(encodeURIComponent).join("/")}`;
        const res = await fetchFn(raw, { headers: token ? { authorization: `Bearer ${token}`, "user-agent": "EdgeMind" } : { "user-agent": "EdgeMind" }, signal: AbortSignal.timeout(20_000) });
        if (!res.ok) throw new BadInput(`下載 ${b.path} 失敗（HTTP ${res.status}）`);
        let rel = b.path.slice(dir.length);
        if (rel.toLowerCase() === "skill.md") rel = "SKILL.md";
        files.set(rel, new Uint8Array(await res.arrayBuffer()));
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    const webDir = dir.replace(/\/$/, "");
    out.push({ dir, files, sourceUrl: `https://github.com/${g.owner}/${g.repo}/tree/${ref}${webDir ? `/${webDir}` : ""}` });
  }
  return out;
}
