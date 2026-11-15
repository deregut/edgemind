# 變更紀錄

## 0.1.0（2026-11-15）

第一個完整版本。

- **第一期**：單人登入（PBKDF2、JWT Cookie、CSRF、速率限制）；供應商設定（LLM／搜尋／Embedding／Rerank／圖片，模型清單與連線測試）；自寫 LLM 適配層（OpenAI 相容 Chat Completions／Responses、Anthropic Messages、Gemini）；Agent Loop（分段續跑、背景模式、權限閘門與五種權限模式、稽核紀錄）；聊天介面（串流 Markdown、分支、重新生成、匯出）；專案與檔案（瀏覽器直傳 S3、分段上傳、版本）；內建工具 web_search、web_fetch、file_*、memory_*、todo、ask_user。
- **第二期**：知識庫 RAG（瀏覽器端解析與切塊、pgvector + 中日韓全文混合檢索、Rerank、背景重建索引）；Skills（zip、線上編輯、GitHub 匯入）；MCP 客戶端（Streamable HTTP、SSE、OAuth 2.1）；自動記憶與對話壓縮。
- **第三期**：code_run（伺服器端 QuickJS JavaScript、瀏覽器端 Pyodide Python）；密鑰保險庫與 http_request；內建 Skills e2b-sandbox、self-hosted-runner；image_generate；subagent；排程任務；用量儀表板與花費上限；PWA。
- **發布準備**：選填環境變數 `S3_FORCE_PATH_STYLE`（支援只接受虛擬主機式網址的服務）；Cloudflare `_routes.json`（只有 `/api/*` 進入 Functions）；`.nvmrc`（Node 22）；部署、設定與部署後檢查文件。
