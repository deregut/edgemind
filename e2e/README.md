# 瀏覽器端對端測試（Playwright）

不屬於 `npm test`；需要 Postgres 17 + pgvector（`bash scripts/test-db.sh`）與 Chromium。

```bash
npx playwright install chromium          # 第一次
bash scripts/test-db.sh                  # 本機 Postgres :54329
npm run test:e2e                         # Vite 開發伺服器
E2E_WEB=preview npm run test:e2e         # 正式建置（vite build + vite preview）
```

- 啟動：模擬的 OpenAI 相容 LLM（`support/mock-llm.mjs`，:8790）、模擬 S3（`support/s3-server.ts`，:9000）、API 開發伺服器（:8787），每次都建立新的資料庫（`E2E_PG_URL`，預設 `postgres://postgres@127.0.0.1:54329/postgres`；或用 `E2E_DATABASE_URL` 指定現有資料庫）。
- Pyodide 由 `support/setup.ts` 的 `routePyodide` 從本機快取提供（以 `curl` 下載 cdn.jsdelivr.net，適合瀏覽器無法直接上網的環境）；設 `E2E_PYODIDE=direct` 則直接連 CDN。
- `E2E_REUSE=1` 會沿用已在執行的伺服器。
- `E2E_DB=neon`：API 改用正式環境（Netlify／Cloudflare）的 Neon HTTP 驅動，經由 `support/neon-http-proxy.mjs`（:4444，把 Neon 的 HTTP SQL 協定轉給本機 Postgres）連線，用來重現只在部署環境出現的資料庫行為。可與 `E2E_WEB=preview` 一起使用。
- 規格：`new-chat`（建立對話）、`code-run-python`（瀏覽器端 Python）、`secrets`（設定 → 密鑰與 http_request 使用密鑰）、`projects`（專案對話、側邊欄分組、移到／移出專案）。
