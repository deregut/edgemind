/**
 * Bundled skills (M11a), installed into the M8 skill store on first use (source "builtin"). The user can disable,
 * edit (source becomes "editor" → never overwritten again) or delete them (remembered, not re-installed).
 * A version bump re-installs a skill only while it is still untouched (source "builtin").
 */
import type { Database } from "../db/client";
import { getSetting, setSetting } from "../lib/settings";
import { SKILL_MD, SkillStore } from "./store";

interface BuiltinSkill {
  name: string;
  version: number;
  files: Record<string, string>;
}

const E2B_SKILL_MD = `---
name: e2b-sandbox
description: 在 E2B 雲端沙盒（完整 Linux + Python/JS/Bash，可上網、可 pip install）執行程式碼或指令。需要真正的 Python 環境、背景模式下要跑 Python、或 code_run 的限制不夠用時使用。透過 http_request + 密鑰 E2B_API_KEY 呼叫 E2B REST API。
---

# E2B 雲端沙盒

用 \`http_request\` 呼叫 E2B 的 REST API：建立沙盒 → 執行程式／指令 → 上傳／下載檔案 → **一定要刪除沙盒**。
完整端點與回應格式見 \`references/api.md\`（英文，可用 skill_load 指定 path 讀取）。

## 前置條件（請使用者在「設定 → 密鑰」完成）
- 新增密鑰 \`E2B_API_KEY\`（E2B Console → API Keys 取得），允許網域填 \`api.e2b.app\`（只有建立／刪除沙盒會用到 API Key）。
- 若系統提示的「密鑰」段落沒有 E2B_API_KEY，先請使用者新增，不要猜測或要求使用者在對話中貼出金鑰。
- 費用：免費 Hobby 方案是**一次性** 100 美元額度、不需信用卡；額度用完帳號會被停用（不會自動扣款）。沙盒按執行秒數計費，所以用完立刻刪除。

## 流程
1. **建立沙盒**：\`POST https://api.e2b.app/v2/sandboxes\`，標頭 \`X-API-Key: {{secret:E2B_API_KEY}}\`，
   body \`{"templateID": "code-interpreter-v1", "timeout": 300}\`（timeout 是存活秒數，夠用就好）。
   回應（201）記下 \`sandboxID\`、\`envdAccessToken\`、\`trafficAccessToken\`（可能是 null）、\`domain\`。
2. **執行程式碼**（code-interpreter，Jupyter 核心，狀態會保留在同一個沙盒）：
   \`POST https://sandbox.e2b.app/execute\`，標頭：
   - \`E2b-Sandbox-Id: <sandboxID>\`、\`E2b-Sandbox-Port: 49999\`
   - \`X-Access-Token: <envdAccessToken>\`；若 trafficAccessToken 不是 null 再加 \`E2B-Traffic-Access-Token: <trafficAccessToken>\`
   - body \`{"code": "print(1+1)", "language": "python"}\`；language 可用 \`python\`、\`js\`、\`ts\`、\`r\`、\`java\`、\`bash\`（跑 shell 指令用 bash）。
   回應是 NDJSON（每行一個 JSON）：\`stdout\` / \`stderr\`（text）、\`result\`（text、png、html…）、\`error\`（name、value、traceback）。
3. **上傳專案檔到沙盒**：\`POST https://sandbox.e2b.app/files?path=/home/user/data.csv\`，標頭同上但 \`E2b-Sandbox-Port: 49983\`、
   \`Content-Type: application/octet-stream\`，並用 http_request 的 \`bodyFromFile: "data.csv"\`（專案檔路徑）。
4. **下載沙盒檔案到專案**：\`GET https://sandbox.e2b.app/files?path=/home/user/out.png\`（Port 49983），用 \`saveResponseTo: "outputs/out.png"\`。
5. **刪除沙盒（必做）**：\`DELETE https://api.e2b.app/sandboxes/<sandboxID>\`，標頭 \`X-API-Key: {{secret:E2B_API_KEY}}\`，成功為 204。
   即使中途出錯也要刪除；忘記時沙盒會在 timeout 秒後自動結束，但期間持續計費。

## 注意
- 圖表不要讓 NDJSON 夾帶大張 base64 PNG（回應會被截斷）：在程式中 \`plt.savefig('/home/user/out.png')\`，再用步驟 4 下載。
- 長輸出：程式中寫到檔案再下載，或 http_request 加 \`saveResponseTo\` 把整個回應存成專案檔後用 file_read 分段讀。
- 沙盒可以上網、可 \`pip install\`（在 python 中用 \`!pip install 套件\` 或 bash 的 \`pip install\`）。
- envdAccessToken 只對這個沙盒有效、刪除後失效；E2B_API_KEY 的真值你看不到，也不要嘗試輸出它。
- 若 \`sandbox.e2b.app\` 路由失敗，可改用直連網址 \`https://49999-<sandboxID>.e2b.app/execute\`（檔案用 49983）。
`;

const E2B_API_MD = `# E2B REST API reference (verified against e2b.dev/docs/api-reference, 2026-11)

All calls go through EdgeMind's \`http_request\` tool. Only the platform API key is a vault secret
(\`{{secret:E2B_API_KEY}}\`, allowed domain \`api.e2b.app\`); per-sandbox tokens come back in the create response.

## Platform API — https://api.e2b.app (auth header \`X-API-Key\`)

### Create sandbox — \`POST /v2/sandboxes\`
Body (NewSandboxV2): \`templateID\` (required; \`code-interpreter-v1\` = Python/JS/R/Java/Bash Jupyter image, \`base\` = plain Linux),
\`timeout\` (seconds to live, default 300), optional \`envVars\` (object), \`metadata\` (object of strings),
\`allow_internet_access\` (bool), \`autoPause\` (bool, default false).
Optional header \`Idempotency-Key\` (lowercase a-z0-9-, ≤255) for safe retries.
201 response (Sandbox): \`sandboxID\`, \`templateID\`, \`envdVersion\`, \`envdAccessToken\`, \`trafficAccessToken\` (nullable),
\`domain\` (nullable). Errors: \`{"code": 4xx, "message": "...", "error_code": "..."}\` (e.g. 401 missing key, 403 blocked team, 429 rate limit).
(Deprecated v1: \`POST /sandboxes\` with the same core fields.)

### Other platform endpoints
- \`GET /v2/sandboxes\` — list running sandboxes (find leftovers to kill).
- \`GET /sandboxes/{sandboxID}\` — details (also returns \`envdAccessToken\`).
- \`POST /sandboxes/{sandboxID}/timeout\` body \`{"timeout": <seconds>}\` — extend / shorten life.
- \`DELETE /sandboxes/{sandboxID}\` — kill; **204** on success. Always call it when done.

## Sandbox traffic — https://sandbox.e2b.app (routing headers)
Every request: \`E2b-Sandbox-Id: <sandboxID>\`, \`E2b-Sandbox-Port: <port>\`, \`X-Access-Token: <envdAccessToken>\`
(plus \`E2B-Traffic-Access-Token: <trafficAccessToken>\` when it is not null).
Direct-host alternative: \`https://<port>-<sandboxID>.<domain or e2b.app>\` with the same token headers.

### Run code (code-interpreter, port 49999) — \`POST /execute\`
JSON body: \`{"code": "...", "language": "python" | "js" | "ts" | "r" | "java" | "bash", "env_vars": {...}, "context_id": "..."}\`
(\`language\` and \`context_id\` are mutually exclusive; omit both for the default Python context).
Response: NDJSON stream, one object per line:
- \`{"type":"stdout","text":"..."}\` / \`{"type":"stderr","text":"..."}\`
- \`{"type":"result","text":"...","png":"<base64>","html":"...","is_main_result":true,...}\`
- \`{"type":"error","name":"ValueError","value":"...","traceback":"..."}\`
- \`{"type":"number_of_executions","execution_count":N}\`
Contexts: \`POST /contexts\` body \`{"language":"python","cwd":"/home/user"}\` → \`{"id": ...}\`; \`DELETE /contexts/{id}\`; \`POST /contexts/{id}/restart\`.

### Files (envd, port 49983)
- Upload: \`POST /files?path=/home/user/file.csv\` with body \`application/octet-stream\` (raw bytes) or \`multipart/form-data\` (field \`file\`).
  Parent directories are created; existing files are overwritten. 200 → \`[{"name","path","type"}]\` (may be served as text/plain JSON).
  Relative paths resolve against the user's home (\`/home/user\`).
- Download: \`GET /files?path=/home/user/out.png\` → raw bytes (supports \`Range\`).
- Commands run through the Connect-RPC \`/process.Process/Start\` endpoint, which needs binary framing (not usable with
  http_request) — run shell commands via \`/execute\` with \`"language": "bash"\` instead.

## Billing (e2b.dev/pricing, 2026-11)
Hobby: free, one-time $100 usage credit, no credit card, sessions up to 1 hour, 10 concurrent sandboxes (check the
pricing page for current limits). When the credit is used up the account is blocked and API calls are rejected — nothing is charged automatically.
`;

const RUNNER_SKILL_MD = `---
name: self-hosted-runner
description: 透過使用者自架的 Piston 或 Judge0 程式執行服務跑多種語言（C/C++/Java/Go/Rust/Python…）的程式碼，取得 stdout/stderr/結束碼。使用者已自架並在密鑰設定 PISTON_URL 或 JUDGE0_URL 時使用。
---

# 自架程式執行器（Piston / Judge0）

用 \`http_request\` 呼叫使用者**自己架設**的執行服務。公開的 emkc.org Piston API 自 2026-02-15 起改為白名單制，一般人無法使用，所以必須自架
（Piston：\`docker run ghcr.io/engineer-man/piston\`；Judge0：官方 docker-compose）。服務必須能從網際網路連到（內網位址會被 SSRF 防護封鎖）。

## 前置條件（「設定 → 密鑰」）
- Piston：密鑰 \`PISTON_URL\` = 基底網址（例如 \`https://piston.example.com\`，不含結尾斜線），允許網域填該主機；若前面有反向代理驗證，另存 \`PISTON_KEY\`。
- Judge0：密鑰 \`JUDGE0_URL\`（例如 \`https://judge0.example.com\`），允許網域填該主機；有設定 \`AUTHN_TOKEN\` 時另存 \`JUDGE0_KEY\`。
- 網址當密鑰存放時，請把 \`{{secret:PISTON_URL}}\` 放在 url 的最開頭（伺服器會原樣替換並檢查允許網域）。
- 系統提示「密鑰」段落沒有對應名稱時，先請使用者設定，不要猜網址。

## Piston（v2 API）
- 列出可用語言／版本：\`GET {{secret:PISTON_URL}}/api/v2/runtimes\` → \`[{"language","version","aliases":[...]}]\`
- 執行：\`POST {{secret:PISTON_URL}}/api/v2/execute\`，JSON body：
  \`\`\`json
  {"language": "python", "version": "*", "files": [{"name": "main.py", "content": "print(input())"}],
   "stdin": "hello", "args": [], "compile_timeout": 10000, "run_timeout": 3000,
   "compile_memory_limit": -1, "run_memory_limit": -1}
  \`\`\`
  \`version\` 可用 \`"*"\`（最新）或 runtimes 列出的版本；多個檔案時第一個是進入點。
  回應：\`{"language","version","run":{"stdout","stderr","output","code","signal"},"compile":{...}}\`（編譯型語言才有 compile）。
- 有代理驗證時加標頭，例如 \`Authorization: Bearer {{secret:PISTON_KEY}}\`（依你的代理設定）。

## Judge0（CE / 自架）
- 列出語言：\`GET {{secret:JUDGE0_URL}}/languages\` → \`[{"id","name"}]\`（常見：71 Python 3、63 JavaScript (Node.js)、54 C++ (GCC)、62 Java、60 Go、73 Rust；以實際列表為準）。
- 同步執行：\`POST {{secret:JUDGE0_URL}}/submissions?base64_encoded=false&wait=true\`，JSON body：
  \`{"source_code": "print(input())", "language_id": 71, "stdin": "hello", "cpu_time_limit": 5, "memory_limit": 128000}\`
  驗證：標頭 \`X-Auth-Token: {{secret:JUDGE0_KEY}}\`（Judge0 預設的驗證標頭名稱；自架時可能改過）。
  回應：\`{"stdout","stderr","compile_output","message","status":{"id","description"},"time","memory","token"}\`；status.id 3 = Accepted，6 = 編譯錯誤，5 = 逾時，11 = 執行錯誤。
- 伺服器停用 wait=true 時：先 \`POST /submissions?base64_encoded=false\` 取得 \`token\`，再 \`GET /submissions/{token}?base64_encoded=false\` 直到 status.id ≥ 3。
- 原始碼含非 UTF-8 或特殊字元時改用 \`base64_encoded=true\`（source_code / stdin 傳 base64，回應也是 base64）。

## 注意
- 回應最多顯示 20,000 字元；大量輸出請在程式內只印摘要，或用 http_request 的 \`saveResponseTo\` 存成專案檔。
- 不要把使用者的機密資料送到未知的執行服務；只用使用者自己設定的網址。
`;

export const BUILTIN_SKILLS: BuiltinSkill[] = [
  { name: "e2b-sandbox", version: 1, files: { [SKILL_MD]: E2B_SKILL_MD, "references/api.md": E2B_API_MD } },
  { name: "self-hosted-runner", version: 1, files: { [SKILL_MD]: RUNNER_SKILL_MD } },
];

type SeedState = Record<string, { version: number; removed?: boolean }>;
const SETTING = "builtin_skills";
const done = new WeakMap<Database, Promise<void>>();
const failedAt = new WeakMap<Database, number>();

/** Install / upgrade bundled skills once per isolate and database (needs S3). Errors are swallowed (retried next time). */
export function ensureBuiltinSkills(store: SkillStore): Promise<void> {
  const db = store.database;
  let p = done.get(db);
  if (!p) {
    if (Date.now() - (failedAt.get(db) ?? 0) < 60_000) return Promise.resolve(); // storage down: retry in a minute
    p = seed(store).catch((e) => {
      done.delete(db);
      failedAt.set(db, Date.now());
      console.error("[edgemind] builtin skills install failed:", (e as Error).message);
    });
    done.set(db, p);
  }
  return p;
}

async function seed(store: SkillStore) {
  const state: SeedState = { ...((await getSetting<SeedState>(store.database, SETTING)) ?? {}) };
  let changed = false;
  const enc = new TextEncoder();
  for (const b of BUILTIN_SKILLS) {
    const st = state[b.name];
    if (st?.removed) continue;
    const row = await store.byName(b.name);
    const folder = new Map(Object.entries(b.files).map(([k, v]) => [k, enc.encode(v)]));
    if (!row) {
      if (st) {
        state[b.name] = { ...st, removed: true }; // installed before and deleted by the user: respect that
      } else {
        await store.saveFolder(folder, { source: "builtin", strict: true });
        state[b.name] = { version: b.version };
      }
      changed = true;
    } else if (row.source === "builtin" && (st?.version ?? 0) < b.version) {
      await store.saveFolder(folder, { source: "builtin", strict: true, replaceId: row.id });
      state[b.name] = { version: b.version };
      changed = true;
    } else if (!st) {
      state[b.name] = { version: b.version }; // a user skill with the same name already exists: leave it alone
      changed = true;
    }
  }
  if (changed) await setSetting(store.database, SETTING, state);
}

/** Forget the per-isolate memo (tests). */
export function resetBuiltinSkillsMemo(db: Database) {
  done.delete(db);
  failedAt.delete(db);
}
