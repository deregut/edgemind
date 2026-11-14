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

## 安全設計

- 單一管理密碼：PBKDF2-SHA256（100,000 次，Cloudflare Workers 的 WebCrypto 上限）
- 登入狀態：JWT 存於 HttpOnly + SameSite=Strict Cookie，每個 JWT 對應資料庫中的 session，可登出撤銷；變更密碼會讓其他裝置全部失效
- CSRF：double-submit token（`X-CSRF-Token` 標頭）＋ Origin 檢查
- 登入速率限制：同一 IP 15 分鐘內失敗 5 次即暫停；全站 15 分鐘內失敗 30 次也會暫停
- API Key：AES-256-GCM 加密（以供應商 ID 作為 AAD），API 只回傳遮罩後的預覽

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
