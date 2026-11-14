# EdgeMind

[English](README.en.md) ｜ 正體中文

單人自用、Serverless 的 AI Agent 工作台：聊天、專案、檔案、知識庫、記憶、Skills、MCP、網頁搜尋與內建工具，所有模型與搜尋供應商都可自訂。

> 🚧 開發中。目前完成：M1 專案骨架、M2 單人登入與供應商設定（LLM／搜尋／Embedding／Rerank／圖片，含模型清單與連線測試）。

## 特色

- **主要部署 Netlify**（Functions），同一份程式也能部署到 **Cloudflare Pages**
- **Neon Postgres + pgvector**，物件儲存可用 Neon Object Storage 或任何 S3 相容服務（R2、B2、MinIO…）
- 自寫 LLM 適配層（原生 fetch）：OpenAI 相容、Anthropic Messages、Gemini generateContent
- 所有 API Key 以 AES-GCM 加密後存入資料庫
- 介面為正體中文，支援淺色／深色／跟隨系統
- 聊天：串流 Markdown（程式碼高亮、KaTeX、Mermaid）、思考過程、工具呼叫卡片、批准卡片、分支切換、重新生成、匯出 Markdown／JSON、背景執行
- 專案：專屬指示、預設模型與權限模式、啟用工具篩選、檔案空間（瀏覽器直傳 S3，大檔自動分段上傳，保留版本）
- 內建工具：`web_search`（Tavily／Serper／SearXNG／Jina／Google PSE，依優先順序備援，結果一律限長）、`web_fetch`（Readability 轉 Markdown、分段讀取、SSRF 防護、Jina Reader 備援）、`file_*`、`memory_*`、`todo`、`ask_user`、`code_run`、`http_request`

## 技術架構

| 層 | 選擇 |
|---|---|
| 前端 | React + Vite + TypeScript + Tailwind + shadcn/ui（靜態 SPA） |
| 後端 | Hono（Netlify Functions 與 Cloudflare Pages Functions 共用） |
| 資料庫 | Neon + `@neondatabase/serverless` + Drizzle ORM |
| 物件儲存 | `aws4fetch` |

```
web/        前端 SPA
server/     Hono API、Drizzle schema、migrations、平台適配層
shared/     前後端共用型別與供應商目錄
netlify/functions/api.ts   Netlify 入口
functions/[[path]].ts      Cloudflare Pages 入口
```

## 環境變數

只有下列 8 個值走環境變數，其餘（模型、搜尋、Embedding、MCP、Skills、權限…）都在網頁介面設定：

| 變數 | 說明 |
|---|---|
| `DATABASE_URL` | Neon Postgres 連線字串 |
| `S3_ENDPOINT` | S3 相容端點 |
| `S3_BUCKET` | Bucket 名稱 |
| `S3_REGION` | 區域（R2 用 `auto`） |
| `S3_ACCESS_KEY_ID` | Access Key ID |
| `S3_SECRET_ACCESS_KEY` | Secret Access Key |
| `ENCRYPTION_KEY` | 32 位元組金鑰的 base64：`openssl rand -base64 32` |
| `JWT_SECRET` | 至少 32 字元：`openssl rand -base64 48` |

缺少或格式錯誤時，網頁會顯示清楚的錯誤頁，列出要補的項目。

## 部署

### Netlify（主要）

1. 匯入此儲存庫；`netlify.toml` 已設定建置指令與輸出目錄。
2. 在 Site settings → Environment variables 填入上面 8 個變數。
3. 部署後開啟網站：會自動建立資料表（migrate），接著設定登入密碼。

> ⚠️ 部署完成後請**立即**開啟網站設定密碼——在設定之前，任何人都能搶先完成首次設定。

### Cloudflare Pages（次要）

```bash
npm ci && npm run build
npx wrangler pages deploy
```

在 Pages 專案 Settings → Variables and Secrets 填入同樣 8 個變數。

（完整部署指南將於 M12 補上。）

## 知識庫（RAG）

- 每個知識庫（全域或專案專屬）綁定一個 Embedding 供應商＋模型＋維度，可選重排序（Jina／Cohere／Voyage）。
- 上傳：瀏覽器取得預簽名 URL 直傳物件儲存 `kb/{知識庫 id}/`，並在瀏覽器中解析（txt、md、程式碼、csv、json、html、PDF〔pdfjs-dist〕、DOCX〔mammoth〕）與切塊（Markdown 依標題切分，含重疊）；伺服器只接收切塊文字，並以每次 ≤40 秒的批次向量化（符合 Netlify 60 秒限制）。
- 更換 Embedding 模型或維度會在背景分批重建索引（Netlify Background Function／CF waitUntil 串接；中斷後可從頁面或「繼續索引」接續），期間仍可用全文檢索。
- 檢索：向量（pgvector）＋全文混合，以 RRF 融合；全文檢索在應用程式端把中日韓文字切成二字詞（bigram）存進 tsvector，解決 Postgres `simple` 設定無法搜尋中文詞的問題（對話搜尋也採用相同做法）。
- 模型透過 `kb_search` 工具檢索，結果附編號引用、來源檔名與分數；專案內對話自動附加該專案的知識庫與全域知識庫。
- Cloudflare 部署可在 `wrangler.toml` 啟用 `[ai] binding = "AI"`，讓 Workers AI Embedding 不需 API Token。

## 執行程式碼與呼叫 API

- `code_run`（危險，預設每次詢問）：
  - **JavaScript**：在伺服器端以 QuickJS（WebAssembly）執行，無網路、無 Node API，記憶體 64 MB、預設 10 秒、最長 30 秒；可掛載專案檔案（合計 ≤10 MB）到虛擬檔案系統（`fs.readFile`／`fs.writeFile`／`fs.listFiles`），寫入的檔案會存回專案並保留舊版本。Netlify 與 Cloudflare Pages 都可執行（Cloudflare 以模組方式載入 `.wasm`）。
  - **Python**：在你的瀏覽器中以 Pyodide 執行（從 jsDelivr CDN 載入並快取），執行期間 Agent 會暫停、完成後自動接續；`import numpy／pandas／matplotlib` 會自動安裝，matplotlib 圖表自動存成 PNG 上傳回專案。需要開著聊天分頁，背景模式無法使用。
  - 輸出（stdout／stderr／回傳值）各最多 20,000 字元，過長時完整內容另存為專案檔 `code_run_outputs/…`。
- `http_request`（危險）：呼叫任意 HTTP API。在 設定 → **密鑰** 新增 API Key 等機密並綁定允許網域（支援 `*.example.com`），請求中寫 `{{secret:名稱}}` 由伺服器端替換；模型看不到真值，回應與紀錄中出現的密鑰值會被遮蔽，內網位址一律封鎖。可用 `saveResponseTo`／`bodyFromFile` 在 API 與專案檔之間傳檔。
- 內建 Skills：`e2b-sandbox`（E2B 雲端沙盒：完整 Linux＋Python，免費 Hobby 方案為一次性 100 美元額度、免信用卡；需要密鑰 `E2B_API_KEY`，允許網域 `api.e2b.app`）與 `self-hosted-runner`（自架 Piston／Judge0，多語言執行；公開的 emkc.org Piston API 自 2026-02-15 起改為白名單制）。可在 設定 → Skills 停用、編輯或刪除。

## 安全設計

- 單一管理密碼：PBKDF2-SHA256（100,000 次，Cloudflare Workers 的 WebCrypto 上限）
- 登入狀態：JWT 存於 HttpOnly + SameSite=Strict Cookie，每個 JWT 對應資料庫中的 session，可登出撤銷；變更密碼會讓其他裝置全部失效
- CSRF：double-submit token（`X-CSRF-Token` 標頭）＋ Origin 檢查
- 登入速率限制：同一 IP 15 分鐘內失敗 5 次即暫停；全站 15 分鐘內失敗 30 次也會暫停
- API Key：AES-256-GCM 加密（以供應商 ID 作為 AAD），API 只回傳遮罩後的預覽
- `web_fetch`：只允許 http(s)；以 DNS-over-HTTPS 解析主機，任何解析到內網／保留位址（含 IPv6、IPv4-mapped）的網址一律封鎖，每次重新導向都重新檢查；解析失敗即拒絕
- 物件儲存：上傳一律用預簽名 URL 由瀏覽器直傳；第一次上傳時自動為目前網站來源設定 Bucket CORS（也可在 設定 → 儲存空間 手動套用；若服務商不允許以 API 設定，請到後台加入：允許 GET/PUT/HEAD、所有標頭、公開 `ETag` 標頭）
- 「全部權限」模式可設定步數、Token 與花費上限（設定 → Agent 與權限）
- 密鑰（設定 → 密鑰）：AES-256-GCM 加密（以密鑰 ID 作為 AAD），只在 `http_request` 送出時於伺服器端解密；每個密鑰只能送往允許網域，重新導向到其他網域時不會跟隨；回應、錯誤訊息、執行紀錄與稽核紀錄中的密鑰值（含 URL 編碼與 Base64 形式）一律遮蔽

## 本機開發

```bash
npm install
./scripts/test-db.sh            # 本機 Postgres 17 + pgvector（測試用）
npm test                        # vitest（使用真實 Postgres）
npm run build                   # 前端 + 兩個平台的 Functions bundle 驗證
```

開發伺服器：設定好環境變數後執行 `npm run dev:api`（API :8787）與 `npm run dev`（Vite，代理 /api）。

## 授權

待定。
