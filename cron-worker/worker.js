// EdgeMind 排程觸發器（Cloudflare Worker，免費方案即可）
// Cloudflare Pages Functions 沒有 cron trigger，所以用這個獨立的小 Worker 定時呼叫 EdgeMind 的 /api/cron/tick。
// 部署：見 cron-worker/README.md。EDGEMIND_URL 與 CRON_TOKEN 是這個 Worker 自己的變數（不是 EdgeMind 的環境變數）。
export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(tick(env));
  },
  // 手動測試：瀏覽 Worker 網址不會觸發（避免被任何人呼叫），只回報設定是否完整
  async fetch(_req, env) {
    return new Response(env.EDGEMIND_URL && env.CRON_TOKEN ? "ok" : "missing EDGEMIND_URL / CRON_TOKEN", { status: 200 });
  },
};

async function tick(env) {
  const res = await fetch(`${String(env.EDGEMIND_URL).replace(/\/$/, "")}/api/cron/tick`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.CRON_TOKEN}`, "x-edgemind-cron-source": "cloudflare-worker" },
  });
  console.log("edgemind tick", res.status, await res.text());
}
