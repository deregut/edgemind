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
