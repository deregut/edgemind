# 部署後檢查清單

EdgeMind 在開發環境中以真實 Postgres + pgvector 與模擬的供應商、S3、MCP 伺服器完成測試，兩個平台的 Functions bundle 也都在 Node 中做過煙霧測試。但下列項目**只能在真正部署、使用真實帳號後確認**（開發環境沒有瀏覽器、沒有真實 API Key，也沒有 Netlify／Cloudflare 的實際執行環境）。建議第一次部署後依序逐項檢查。

標記：🔴 必查（影響基本功能）　🟡 使用到該功能時再查　⚪ 可接受的已知行為

---

## 1. 路由與首次啟動

- [ ] 🔴 **Netlify：`/api/*` 由函式處理，沒有被 SPA 重新導向攔截。**
  開啟 `https://你的網站/api/status`，應回傳 JSON（含 `env`、`db`、`version`），而不是網頁 HTML。
  依 [Netlify 文件](https://docs.netlify.com/build/functions/configuration/)，以 `config.path` 宣告路徑的函式會在套用重新導向規則之前比對，因此預期正常。若仍回傳 HTML，請到 **Logs & metrics → Functions** 確認 `api` 函式有部署成功並顯示 `/api/*` 路徑，再回報問題。**不要**加上指向 `/.netlify/functions/api` 的重寫規則：設定了 `path` 的函式不會在那個網址提供服務。
- [ ] 🔴 **Cloudflare：`_routes.json` 生效。** `/api/status` 回傳 JSON；首頁與重新整理任意前端路徑（例如 `/c/xxx`）都正常顯示前端。
- [ ] 🔴 環境變數錯誤時顯示錯誤頁（可暫時改錯一個變數驗證，或確認正常時不會出現）。
- [ ] 🔴 **部署後立即**開啟網站：自動 migration → 設定密碼畫面 → 設定完成後可登入。在此之前，任何人都能搶先完成首次設定。
- [ ] 🔴 登出、再登入；錯誤密碼 5 次後被暫時鎖定；變更密碼後其他瀏覽器被登出。

## 2. LLM 供應商（以真實 API 確認串流格式）

測試用的 SSE 資料是依官方文件手寫的，請用真實 Key 各跑一次「一般回答」與「會呼叫工具的回答」（例如請它「現在幾點？」觸發 `get_time`）：

- [ ] 🔴 **OpenAI 相容（Chat Completions）**：文字串流、工具呼叫、用量（tokens）顯示在用量頁。
  - OpenAI 官方主機使用 `max_completion_tokens`，其他主機使用 `max_tokens`；若某個相容服務拒絕參數，回報錯誤訊息。
  - 不支援 `stream_options` 的相容端點：把供應商設定 `streamUsage` 設為 `false`。
- [ ] 🟡 **OpenAI Responses API**（供應商設定 `api=responses`）：確認事件名稱與推理摘要、工具呼叫往返正常。
- [ ] 🔴 **Anthropic Messages**：文字、工具呼叫；推理模型開啟推理後，思考區塊顯示，且**下一回合帶著思考簽章呼叫工具不會出錯**。也確認較新的 adaptive thinking 模型行為正常。
- [ ] 🔴 **Gemini**：文字、工具呼叫；思考模型的工具呼叫往返（`thoughtSignature`）不會出現簽章錯誤。
  - ⚪ 已知行為：文字部分的 thoughtSignature 不回傳（文件標示為選用）；跨供應商切換模型時，先前的推理內容不會帶過去。
- [ ] 🟡 **DeepSeek 思考模式＋工具**：設定 `replayReasoning=true` 後多步驟工具呼叫正常。
- [ ] 🟡 模型清單抓取、連線測試、錯誤訊息中不含 API Key。
- [ ] 🟡 圖片附件傳給視覺模型、PDF 附件傳給支援 PDF 的模型。

## 3. 長任務、續跑與背景模式

- [ ] 🔴 一個超過 50 秒的前景任務（例如要求多次搜尋並彙整）會出現續跑並無縫完成。
- [ ] 🔴 **Netlify：`agent-background` 被當作 Background Function。** 開啟「背景」開關送出任務，應立即回應並在背景完成；Functions 頁面中 `agent-background` 有執行記錄。（檔名以 `-background` 結尾的 v2 函式；若沒有被當成背景函式，請回報。）
- [ ] 🔴 **Cloudflare：背景模式的自我呼叫成功**（Function 呼叫同一個 Pages 網域的 `/api/internal/runs/:id/drive`）。若網站前面有 Cloudflare Access 等驗證，自我呼叫會被擋。
- [ ] 🟡 背景執行中重新整理或關閉分頁，回來後能看到進度與結果。
- [ ] ⚪ 已知行為：即時的逐字串流只在前景 SSE 中；背景／輪詢模式以「步驟」為單位更新。被平台強制中斷的工具會在續跑時重新執行一次（`code_run`、`http_request` 若已記錄結果則不會重跑）。
- [ ] 🟡 停止、重新生成、編輯訊息分支、分支切換正常。

## 4. 物件儲存

- [ ] 🔴 第一次上傳時自動設定 CORS 成功（**設定 → 儲存空間** 顯示目前網址已在 CORS 來源中）。若服務商不允許（例如 R2 的物件層級權杖），依畫面說明手動設定。
- [ ] 🔴 小檔（< 32 MB）與大檔（> 32 MB，分段上傳）都能上傳到專案；大檔失敗通常是 CORS 沒有公開 `ETag`。
- [ ] 🔴 **路徑式網址**在你的服務商可用（R2、B2、MinIO、Neon 都應可以）。AWS 只接受虛擬主機式網址的 bucket：設定 `S3_FORCE_PATH_STYLE=false`。
- [ ] 🔴 覆寫專案檔後 **版本** 列表出現舊版本且可還原（使用 `CopyObject`）。
- [ ] 🟡 下載、刪除檔案；刪除專案會清除其物件。

## 5. 網頁搜尋與讀取

- [ ] 🔴 至少一個搜尋供應商的 `web_search` 正常；設定兩個時，第一個故意填錯 Key 會自動改用第二個。
- [ ] 🔴 `web_fetch` 讀取一般網頁並轉成 Markdown；讀取 `http://127.0.0.1`、`http://169.254.169.254` 之類的網址會被拒絕。
- [ ] 🟡 **Cloudflare**：`web_fetch` 的 HTML 解析（linkedom + Readability）在 workerd 上正常（只在 Node 中測試過；免費方案可能超過 10 ms CPU）。
- [ ] 🟡 DNS-over-HTTPS（cloudflare-dns.com → dns.google）可從平台連線；兩者都不通時 `web_fetch` 會拒絕所有網址（fail-closed）。
- [ ] ⚪ 已知行為：DNS 檢查與實際連線之間會重新解析一次（Edge 環境無法固定 IP），存在很小的 DNS rebinding 時間窗。

## 6. 知識庫

- [ ] 🔴 **在真實瀏覽器中**上傳 PDF 與 DOCX：能解析、切塊、索引完成（瀏覽器端解析在開發環境未實際執行）。
- [ ] 🔴 pdf.js 的 worker（`.mjs` 檔）以 JavaScript MIME 類型提供（開發者工具 Network 中檢查；Netlify 與 Cloudflare 都應正確）。
- [ ] 🟡 掃描型 PDF 會顯示「沒有文字層」的訊息（不支援 OCR）。
- [ ] 🔴 你使用的 Embedding 供應商：建立知識庫時的維度探測、指定維度、批次向量化都正常（各家格式依文件實作，未以真實 Key 測試）。Jina 只對 v3/v4 模型送 `task`；Cohere 的 `output_dimension` 只適用 embed-v4。
- [ ] 🟡 Rerank（Jina／Cohere／Voyage）：測試搜尋的結果順序有變化且分數合理。
- [ ] 🟡 **更換 Embedding 模型**後在背景重建索引：Netlify 上 `agent-background` 能接受 `{path}` 形式的內部呼叫；Cloudflare 上 `waitUntil` 串接能完成。
- [ ] 🟡 **Workers AI 綁定**（Cloudflare，`wrangler.toml` 啟用 `[ai]`）：不填 Token 的 Workers AI Embedding 能運作（未在真實 workerd 測試）。
- [ ] ⚪ 已知行為：`file_write` 寫入的專案檔**不會**自動加入知識庫；變更切塊大小只影響之後上傳的文件；同時搜尋多個知識庫時，使用第一個有設定 Rerank 的知識庫的 Rerank 設定。
- [ ] ⚪ 已知行為：既有大量對話的全文搜尋索引是逐步補建的（每次搜尋最多 2,000 則）。

## 7. Skills

- [ ] 🟡 上傳 zip、線上編輯、匯出 zip。
- [ ] 🟡 從 GitHub 匯入（公開 repo；有 Token 時私有 repo）。很大的 repo 可能被 GitHub 的 trees API 截斷，請改指向子資料夾；含 `/` 的分支名稱不支援。
- [ ] 🟡 內建 Skills `e2b-sandbox`、`self-hosted-runner` 在第一次聊天後出現在 Skills 清單。

## 8. MCP

- [ ] 🟡 連線一個真實的遠端 MCP 伺服器（例如 GitHub、Notion、Linear 的遠端 MCP）：Streamable HTTP、同步工具、呼叫工具（只用模擬伺服器測試過）。
- [ ] 🟡 **OAuth 2.1 流程**：授權 → 回到設定頁 → 工具可用；權杖過期後自動更新。回呼網址為 `https://你的網域/api/mcp/oauth/callback`。
- [ ] 🟡 舊版 SSE 傳輸的伺服器（若有使用）。
- [ ] ⚪ 已知行為：不支援 MCP resources／prompts、sampling／elicitation／roots；伺服器提供的 instructions 只顯示在介面，不放入系統提示；MCP 網址不經 SSRF 過濾（刻意的設計）。

## 9. 記憶與壓縮

- [ ] 🟡 對話結束後出現「自動萃取」的記憶。**Netlify**：確認串流函式結束後 `waitUntil` 仍讓萃取完成；若沒有出現自動記憶，代表背景工作被切斷（不影響其他功能）。
- [ ] 🟡 新對話會自動召回相關記憶。
- [ ] 🟡 長對話觸發自動壓縮（或用 ⋯ → 壓縮較早的對話）後仍能正常對話。
- [ ] ⚪ 已知行為：token 數為估算值（沒有 tokenizer），會同時參考供應商回報的輸入 tokens；對話搜尋是全文檢索而非語意搜尋。

## 10. 程式執行與 HTTP

- [ ] 🔴 **`code_run` JavaScript**（Netlify）：執行簡單腳本、讀寫掛載的專案檔。
- [ ] 🟡 **Cloudflare**：Pages 的 Functions 打包能處理 `functions/[[path]].ts` 中 `node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm` 的匯入（假設套件安裝在根目錄 `node_modules`），且 QuickJS 在真實 workerd 上能執行。免費方案的 10 ms CPU 幾乎一定不夠，需要 Workers Paid。
- [ ] 🔴 **`code_run` Python（瀏覽器）**：第一次執行會從 cdn.jsdelivr.net 載入 Pyodide；`import pandas` 自動安裝；matplotlib 圖表存成 PNG 上傳回專案；逾時會終止並可再次執行；取消按鈕有效。若之後加上 CSP，必須允許 jsDelivr。
- [ ] 🟡 `http_request` + 密鑰：`{{secret:NAME}}` 代入、非允許網域被拒絕、回應中的密鑰被遮蔽。
- [ ] 🟡 **`e2b-sandbox` Skill**（需要 E2B 帳號）：建立沙盒、執行 Python、上傳／下載檔案、刪除沙盒。Skill 依 E2B 文件撰寫，未以真實帳號測試，特別是 `https://sandbox.e2b.app` 的標頭路由與 v2 建立端點。
- [ ] 🟡 **`self-hosted-runner` Skill**：Piston／Judge0 必須可從公開網路連線（內網位址會被 SSRF 防護擋下）。
- [ ] ⚪ 已知行為：`http_request` 不會遮蔽嵌在更大編碼內容中的密鑰（例如回顯的 Basic auth Base64）；整個 base URL 存成密鑰時，自訂權限規則的網域條件無法得知實際網域（密鑰本身的允許網域仍然有效）；被平台中斷的請求在續跑時可能重送（POST 可能重複）。
- [ ] ⚪ 已知行為：QuickJS 同步執行期間會暫停該請求的心跳（最多 30 秒，低於 75 秒的租約過期時間）。

## 11. 排程

- [ ] 🔴 **Netlify**：Functions 頁面中 `cron-tick` 顯示 Scheduled 標籤與下次執行時間；按 **Run now** 後，EdgeMind「排程」頁的「最近一次觸發」更新。（使用 Netlify 內建的 `URL` 變數作為網站來源，以 v2 `config.schedule` 宣告，未在真實部署驗證。）
- [ ] 🔴 建立一個 5 分鐘後的「一次」任務，確認在下一次觸發時執行並建立「[排程] …」對話。
- [ ] 🟡 **Cloudflare**：`cron-worker` 部署後「最近一次觸發」顯示 `cloudflare-worker`；或 cron-job.org 觸發成功。
- [ ] 🟡 一般權限模式的任務遇到寫入工具時停在「等待批准」，在對話中批准後完成。
- [ ] ⚪ 已知行為：預設每 15 分鐘觸發，每次都會喚醒資料庫（Neon 免費方案的運算時數）；任務最多晚一個週期；秋季日光節約時間的重複時段中，萬用小時的 cron 只執行一次；編輯排程會重設「間隔」型任務的起算點。

## 12. 用量與花費上限

- [ ] 🟡 設定模型價格後，用量頁的花費與供應商帳單大致相符（快取輸入、推理 tokens 是否正確計入）。
- [ ] 🟡 設定一個很低的每日上限，確認達到後執行停止並顯示原因，調高後恢復。
- [ ] ⚪ 已知行為：對話壓縮摘要的 tokens 尚未記入用量；Embedding、Rerank、搜尋、圖片沒有計價；只有設定價格的模型計入花費上限。

## 13. 介面與 PWA

- [ ] 🔴 **整體介面目視檢查**（開發環境沒有瀏覽器，介面只做過型別檢查與建置）：桌面與手機版面、淺色／深色、側邊欄抽屜、聊天頁各種卡片、設定頁各分頁、排程與用量頁。
- [ ] 🟡 Markdown、程式碼高亮、KaTeX、Mermaid 圖表正常顯示。
- [ ] 🟡 新對話送出第一則訊息時，網址從 `/` 切換到 `/c/:id` 期間串流不中斷（若頁面重新掛載，會自動改用步驟輪詢，結果仍正確）。
- [ ] 🟡 **PWA**：Chrome／Edge 側邊欄出現「安裝 App」；安裝後可獨立視窗開啟；離線時顯示應用程式外殼；部署新版本後重新整理能拿到新版（`sw.js` 不被快取）。
- [ ] 🟡 Service worker 不攔截 `/api` 請求（開發者工具 → Application → Service Workers）。

## 14. Cloudflare 免費方案

- [ ] 🔴（使用 Cloudflare 免費方案時）執行一個多步驟 Agent 任務，觀察是否出現「Too many subrequests」或錯誤 1102。免費方案每個請求只有 50 個子請求與 10 ms CPU；每次資料庫查詢都算一個子請求。若頻繁出現，請升級 Workers Paid 或改用 Netlify。

---

## 回報問題時請附上

- 部署平台與方案、使用的供應商與模型
- 瀏覽器開發者工具 Console／Network 中的錯誤
- Netlify Functions 記錄或 Cloudflare Functions 即時記錄中的錯誤（API Key 會被遮蔽，但貼上前仍請再檢查一次）
