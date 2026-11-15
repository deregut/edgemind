# 部署到 Netlify（主要平台）

Netlify 是 EdgeMind 的主要部署目標：前端是靜態 SPA，API 跑在 Netlify Functions，長任務交給 Background Function，排程任務由 Scheduled Function 觸發。整個流程大約 15 分鐘。

## 你需要準備

| 項目 | 用途 | 免費方案可用 |
|---|---|---|
| GitHub（或 GitLab／Bitbucket）上的 EdgeMind 儲存庫 | Netlify 從這裡建置 | ✅ |
| Netlify 帳號 | 託管前端與 Functions | ✅ |
| Neon 帳號 | Postgres + pgvector | ✅ |
| S3 相容 bucket | 檔案、知識庫原檔、Skills、附件 | ✅（Neon Object Storage 5 GB、R2 10 GB 等） |

部署順序：**資料庫 → 物件儲存 → 產生金鑰 → 建立 Netlify 網站並填環境變數 → 部署 → 立即設定密碼 → 新增供應商**。

---

## 1. 建立 Neon Postgres

1. 到 [Neon 主控台](https://console.neon.tech) 建立專案。
   - **區域建議選 AWS US East (Ohio)（`aws-us-east-2`）**：Netlify Functions 預設也在 Ohio（`cmh`），延遲最低；而且這個區域支援 Neon Object Storage。
   - 若打算使用 Neon Object Storage，專案必須在支援的區域：`aws-us-east-2`、`aws-us-east-1`、`aws-eu-central-1`、`aws-ap-southeast-1`（以 [Neon 文件](https://neon.com/docs/storage/get-started) 為準）。
2. 在專案首頁按 **Connect**，複製連線字串，格式類似：
   ```
   postgresql://neondb_owner:xxxxxxxx@ep-xxxx-xxxx.us-east-2.aws.neon.tech/neondb?sslmode=require
   ```
   這就是 `DATABASE_URL`。一般或 pooled（主機名含 `-pooler`）的連線字串都可以，EdgeMind 透過 Neon 的 HTTP 驅動連線。
3. **pgvector 不需要手動啟用**：EdgeMind 第一次啟動時會自動執行 migration，其中第一個就是 `CREATE EXTENSION IF NOT EXISTS vector`。Neon 所有方案都內建 pgvector。
   - 若連線的角色沒有建立擴充的權限（極少見），請在 Neon 的 SQL Editor 手動執行一次 `CREATE EXTENSION IF NOT EXISTS vector;`。

> 💡 Neon 免費方案的運算會在閒置後自動暫停（scale to zero），之後的第一個請求會多約數百毫秒的喚醒時間。排程觸發器每次檢查都會喚醒資料庫，見本文「排程函式」一節。

---

## 2. 建立物件儲存 bucket

EdgeMind 只需要一個 bucket，所有檔案依前綴分開存放（`projects/`、`kb/`、`skills/`、`users/`…）。**上傳一律由瀏覽器以預簽名 URL 直傳**，因此 bucket 必須允許你的網站來源跨域存取（CORS）。EdgeMind 會在第一次上傳時自動以 `PutBucketCors` 為目前的網站來源設定 CORS；若金鑰沒有這個權限，**設定 → 儲存空間** 會顯示手動設定方式。

所需的 CORS 規則（任何服務商都一樣）：

- 允許來源（AllowedOrigins）：你的網站網址，例如 `https://edgemind-xxxx.netlify.app`（有自訂網域就加上自訂網域；本機開發可加 `http://localhost:5173`）
- 允許方法：`GET`、`PUT`、`HEAD`
- 允許標頭：`*`
- 公開標頭（ExposeHeaders）：`ETag`（**分段上傳必須**，否則大檔上傳會失敗）
- MaxAgeSeconds：`3600`

### 選項 A：Neon Object Storage（與資料庫同一家，最省事）

1. 確認 Neon 專案位於支援 Object Storage 的區域（見上方）。
2. 建立 bucket：主控台的 Object Storage 頁面，或使用 Neon CLI：
   ```bash
   neon buckets create edgemind
   ```
   bucket 保持 **private**（預設）即可，EdgeMind 一律使用預簽名 URL。
3. 建立具備讀寫權限的憑證：
   ```bash
   neon credentials create --scope storage:read --scope storage:write
   ```
   回應中的 `token_id`（`nak_…`）是 `S3_ACCESS_KEY_ID`，`s3_secret_access_key`（`nsk_…`）是 `S3_SECRET_ACCESS_KEY`。**只會顯示一次**，請立即保存。
4. 取得端點與區域：在專案目錄執行 `neon env pull` 會寫出 `AWS_ENDPOINT_URL_S3` 與 `AWS_REGION`；或呼叫 Neon API `GET /api/v2/projects/{project_id}/branches/{branch_id}/storage`，回應中的 `s3_endpoint` 與 `region` 就是要填的值。
5. 對應的環境變數：
   ```
   S3_ENDPOINT=https://br-xxxx-xxxx.storage.c-2.us-east-2.aws.neon.tech
   S3_REGION=us-east-2
   S3_BUCKET=edgemind
   S3_FORCE_PATH_STYLE=true      # Neon 只支援路徑式網址，保持 true
   ```

注意事項：

- Neon 的 bucket **跟著資料庫分支（branch）走**：請使用與 `DATABASE_URL` 同一個分支的端點與憑證。從 production 分支開出來的分支會繼承當下的檔案，之後的變更互不影響。
- Neon 支援 EdgeMind 用到的所有操作：預簽名 GET／PUT、分段上傳、`CopyObject`（版本保存）、範圍讀取、`PutBucketCors`。

### 選項 B：Cloudflare R2

1. Cloudflare 主控台 → **R2** → 建立 bucket（例如 `edgemind`），位置選 Automatic 即可。
2. **R2 → Manage R2 API Tokens → Create API token**：
   - 權限選 **Object Read & Write** 並限定這個 bucket：最安全，但這類權杖**不能設定 CORS**，請手動設定（下一步）。
   - 或選 **Admin Read & Write**：EdgeMind 可以自動設定 CORS，但權杖權限涵蓋整個帳號的 R2。
   - 建立後會顯示 Access Key ID 與 Secret Access Key。
3. 手動設定 CORS（使用 Object Read & Write 權杖時）：bucket → **Settings → CORS Policy → Edit**，貼上：
   ```json
   [
     {
       "AllowedOrigins": ["https://你的網站.netlify.app"],
       "AllowedMethods": ["GET", "PUT", "HEAD"],
       "AllowedHeaders": ["*"],
       "ExposeHeaders": ["ETag"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```
4. 環境變數：
   ```
   S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
   S3_REGION=auto
   S3_BUCKET=edgemind
   ```
   `ACCOUNT_ID` 在 R2 首頁右側可以找到。**不要**把 bucket 名稱放進端點。

### 選項 C：Backblaze B2

1. 建立 **Private** bucket。bucket 詳細資料中的 Endpoint（例如 `s3.us-west-004.backblazeb2.com`）中間那段就是區域。
2. **Application Keys → Add a New Application Key**，限定這個 bucket、Read and Write。`keyID` 是 `S3_ACCESS_KEY_ID`，`applicationKey` 是 `S3_SECRET_ACCESS_KEY`。
   - ⚠️ 帳號層級的 Master Application Key **不能**用在 S3 相容 API，一定要另外建立應用程式金鑰。
3. CORS：B2 的 S3 相容 API 支援 `PutBucketCors`，EdgeMind 通常能自動設定。若失敗，可用 B2 CLI（`b2 bucket update --cors-rules '…' <bucket>`）設定，`allowedOperations` 需包含 `s3_get`、`s3_put`、`s3_head`，`exposeHeaders` 需包含 `ETag`。注意：在 B2 網頁介面改 CORS 會覆蓋以 API 設定的規則。
4. 環境變數：
   ```
   S3_ENDPOINT=https://s3.us-west-004.backblazeb2.com
   S3_REGION=us-west-004
   S3_BUCKET=你的-bucket
   ```

### 其他 S3 相容服務

- **MinIO**：`S3_ENDPOINT` 填公開可連線的網址、`S3_REGION=us-east-1`。必須能從 Netlify 與你的瀏覽器連線。
- **AWS S3**：`S3_ENDPOINT=https://s3.<region>.amazonaws.com`、`S3_REGION=<region>`。路徑式網址在多數區域仍可用；若你的 bucket 只接受虛擬主機式網址，設定 `S3_FORCE_PATH_STYLE=false`。IAM 權限需要 `s3:GetObject`、`s3:PutObject`、`s3:DeleteObject`、`s3:ListBucket`（選用）與 `s3:PutBucketCORS`（自動設定 CORS 時）。
- 服務必須支援：SigV4 預簽名 URL、分段上傳、`CopyObject`、`Range` 讀取。

---

## 3. 產生兩把金鑰

```bash
openssl rand -base64 32   # → ENCRYPTION_KEY（32 位元組）
openssl rand -base64 48   # → JWT_SECRET（至少 32 字元）
```

沒有 openssl 時可用 Node：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
```

- `ENCRYPTION_KEY` 用來加密資料庫中所有 API Key、密鑰與 MCP 憑證。**部署後請勿更換**，否則已加密的值都無法解密，需要在介面中重新輸入。請另外安全地備份一份。
- `JWT_SECRET` 用來簽發登入 Cookie 與內部 HMAC（背景工作、排程觸發）。更換後所有登入狀態失效，需要重新登入。

---

## 4. 建立 Netlify 網站

1. Netlify → **Add new project → Import an existing project**，選擇 EdgeMind 儲存庫。
2. 建置設定（`netlify.toml` 已經寫好，畫面上的值應會自動帶入）：

   | 欄位 | 值 |
   |---|---|
   | Base directory | （留空，儲存庫根目錄） |
   | Build command | `npm run build` |
   | Publish directory | `web/dist` |
   | Functions directory | `netlify/functions` |

   > ⚠️ EdgeMind 使用 npm workspaces，Netlify 可能把它判斷成 monorepo，並自動把 **Base directory** 或 **Package directory** 設成 `server`（或其他子套件）。請確認這兩個欄位都是**空白**：建置必須在儲存庫根目錄執行，根目錄的 `npm run build` 才會一次處理 server、web 與 Functions。

3. 先**不要**按 Deploy，展開 **Environment variables**（或建立後到 **Project configuration → Environment variables**）新增下列變數：

   | 變數 | 範例／說明 |
   |---|---|
   | `DATABASE_URL` | Neon 連線字串 |
   | `S3_ENDPOINT` | 物件儲存端點（不含 bucket） |
   | `S3_REGION` | `auto`、`us-east-2`… |
   | `S3_BUCKET` | `edgemind` |
   | `S3_ACCESS_KEY_ID` | 存取金鑰 ID |
   | `S3_SECRET_ACCESS_KEY` | 存取金鑰密碼 |
   | `S3_FORCE_PATH_STYLE` | 選填，預設 `true` |
   | `ENCRYPTION_KEY` | `openssl rand -base64 32` 的輸出 |
   | `JWT_SECRET` | `openssl rand -base64 48` 的輸出 |
   | `NODE_VERSION` | 選填；儲存庫的 `.nvmrc` 已指定 Node 22（需 ≥ 20） |

   - 變數的 **Scopes** 必須包含 **Functions**（預設是 All scopes，保持即可）。
   - 敏感值可勾選 **Contains secret values**。
   - 其他所有設定（LLM、搜尋、Embedding、MCP…）**不需要**環境變數，部署後在網頁介面設定。

4. 按 **Deploy**。建置大約 2–4 分鐘：先嵌入 migration、建置前端，再打包 Functions。`npm run build` 也會打包並煙霧測試兩個平台的 Functions bundle（`build-out/`，僅供驗證；Netlify 實際部署的是它自己從 `netlify/functions/` 打包的版本）。

### 部署後的 Functions

| 函式 | 類型 | 作用 |
|---|---|---|
| `api` | 一般函式，`config.path = "/api/*"` | 所有 API；聊天以 SSE 串流，每段約 50 秒後自動續跑 |
| `agent-background` | Background Function（檔名以 `-background` 結尾） | 背景模式的 Agent 執行、知識庫背景重建索引；最長 15 分鐘，時間將盡時自我重新觸發 |
| `cron-tick` | Scheduled Function（`*/15 * * * *`） | 每 15 分鐘檢查並啟動到期的排程任務 |

部署完成後到 **Logs & metrics → Functions** 應該看到這三個函式，`cron-tick` 旁有 Scheduled 標籤與下次執行時間。

---

## 5. 立即設定登入密碼（重要）

> ⚠️ **部署完成後請馬上開啟網站。** 在設定密碼之前，任何先打開網站的人都能完成首次設定並取得完整管理權（包括你的 API Key 與資料）。

1. 開啟 `https://你的網站.netlify.app`。
   - 若環境變數缺漏或格式錯誤，會看到列出問題的錯誤頁；修正後到 **Deploys → Trigger deploy → Deploy site** 重新部署（環境變數變更需要重新部署才會生效）。
2. 第一次載入時會自動建立資料表（migration），接著顯示「設定密碼」畫面。設定至少 10 個字元的密碼。
3. 登入後到 **設定 → 帳號安全** 可以變更密碼（變更後其他裝置的登入全部失效）。

忘記密碼時：到 Neon SQL Editor 執行下列 SQL，然後**立刻**重新開啟網站設定新密碼（所有資料都會保留）：

```sql
DELETE FROM sessions;
DELETE FROM users;
```

---

## 6. 第一次設定

1. **設定 → 供應商 → 新增**：選類型「LLM」，選預設範本（OpenAI、Anthropic、Gemini、OpenRouter…），填 API Key → **測試連線** → 儲存。
2. 在供應商的 ⋯ 選單選 **模型清單**，從抓到的清單勾選要用的模型（必要時調整「視覺／工具／推理」能力標記）。
3. **設定 → Agent 與權限**：選預設模型。
4. （建議）新增一個搜尋供應商，讓 `web_search` 可用。
5. 開新對話測試。

完整設定說明見 [configuration.md](configuration.md)，部署後的逐項檢查見 [verification-checklist.md](verification-checklist.md)。

---

## 背景函式（Background Function）

- 聊天輸入框旁的「背景」開關打開時，Agent 由 `agent-background` 執行，前端改為輪詢進度，關掉分頁也會繼續。
- 每次最多執行約 15 分鐘，未完成時會自我重新觸發接續；狀態都寫在資料庫中。
- 知識庫更換 Embedding 模型後的重建索引也在這裡執行。
- 依 [Netlify 文件](https://docs.netlify.com/build/functions/background-functions/)，Background Functions 在 credit-based 方案（含 Free、Personal、Pro）與 Enterprise 都可使用。若你的帳號仍是舊版方案且不支援背景函式：前景聊天不受影響（每 50 秒自動續跑），但背景模式與知識庫背景重建會失敗——此時請保持前景模式，知識庫重建索引時保持知識庫頁面開啟（頁面會自行驅動索引）。
- Python（`code_run` 的 python）需要瀏覽器，背景模式下會回傳錯誤並建議改用 JavaScript 或 `e2b-sandbox` Skill。

## 排程函式（Scheduled Function）

- `netlify/functions/cron-tick.ts` 預設每 15 分鐘執行一次，以內部 HMAC 呼叫排程檢查；到期的任務會以背景模式啟動。**不需要任何額外設定**，也不需要產生 token。
- Netlify 的排程函式只在**已發布的正式部署**上依時程執行（Deploy Preview 與分支部署不會），以 UTC 計算時程；任務本身的時區在 EdgeMind 中設定，與此無關。
- 想更即時：把 `cron-tick.ts` 中的 `schedule` 改成例如 `"*/5 * * * *"` 後重新部署。代價是資料庫被喚醒得更頻繁（Neon 免費方案的運算時數有限）。任務最多會比設定時間晚一個檢查週期執行。
- 可以在 Netlify 的 Functions 頁面選 `cron-tick` 按 **Run now** 手動觸發；EdgeMind 的「排程」頁會顯示最近一次觸發的來源與時間。
- 完全不用排程任務、也不想讓觸發器定期喚醒資料庫：刪除 `netlify/functions/cron-tick.ts` 後重新部署（停用任務並不會停止觸發，每次觸發仍會查詢一次資料庫）。

## 自訂網域

在 **Domain management** 加上自訂網域後：

- 物件儲存的 CORS 需要包含新網域。EdgeMind 會在新網域第一次上傳時自動補上；手動設定 CORS 的服務商（如 R2 物件權杖）請自行加入。
- MCP 的 OAuth 回呼網址會變成 `https://新網域/api/mcp/oauth/callback`，已授權的 MCP 伺服器若有登記回呼網址需更新，或重新授權。

## 更新版本

推送到連結的分支即會自動重新部署。新的資料庫 migration 會在新版本第一次收到請求時自動執行。

## 疑難排解

| 症狀 | 可能原因 |
|---|---|
| 建置失敗：`Missing script: "build"`，位置是 `/opt/build/repo/server` | Netlify 把 Base directory 或 Package directory 自動設成 `server`。到 **Project configuration → Build & deploy → Build settings** 把兩者清空，再 **Clear cache and deploy site** |
| 打開網站看到「環境變數」錯誤頁 | 變數缺漏或格式錯誤（例如 `ENCRYPTION_KEY` 不是 32 位元組）；修正後重新部署 |
| `/api/*` 回傳網頁 HTML | `api` 函式的路徑沒有生效，見 [verification-checklist.md](verification-checklist.md) 第 1 節 |
| 上傳卡在 0% 或出現網路錯誤 | bucket CORS 沒有包含目前網站來源，或沒有公開 `ETag` |
| 大檔上傳最後一步失敗 | CORS 沒有 `ExposeHeaders: ETag` |
| 背景模式一直停在「等待中」 | 帳號不支援 Background Functions，或 `agent-background` 部署失敗；查看該函式的 Logs |
| 排程任務沒有執行 | 確認是正式部署、`cron-tick` 有 Scheduled 標籤；「排程」頁的「最近一次觸發」是否有更新 |
