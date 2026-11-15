// Tiny OpenAI-compatible mock LLM (streaming chat completions) for the E2E tests.
// Turn 1 (last message is from the user): a code_run python tool call. After a tool result: a short text.
// The tool result that reached the model is kept per prompt (text of the first user message): GET /tool-result?prompt=…
import http from "node:http";

const port = Number(process.env.MOCK_LLM_PORT ?? 8790);
const CODE = "import os\nos.makedirs('ai-blog-astro/docs', exist_ok=True)\nprint('ok')";
const toolResults = new Map();
let calls = 0;
const textOf = (m) => (typeof m?.content === "string" ? m.content : Array.isArray(m?.content) ? m.content.map((p) => p.text ?? "").join("") : "");

function chunk(res, delta, finish = null) {
  res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: "mock", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "GET" && url.pathname.endsWith("/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ object: "list", data: [{ id: "mock-model", object: "model" }] }));
  }
  if (req.method === "GET" && url.pathname === "/tool-result") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ result: toolResults.get(url.searchParams.get("prompt") ?? "") ?? null, calls }));
  }
  if (req.method === "POST" && url.pathname.endsWith("/chat/completions")) {
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw || "{}");
    calls++;
    const msgs = body.messages ?? [];
    const last = msgs[msgs.length - 1];
    if (!body.stream) {
      // auto-title / helper calls
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ id: "c", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "測試標題" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    if (last?.role === "tool") {
      toolResults.set(textOf(msgs.find((m) => m.role === "user")).trim(), last.content);
      chunk(res, { role: "assistant", content: "" });
      chunk(res, { content: "Python 已執行完畢。" });
      chunk(res, {}, "stop");
    } else {
      const id = `call_${Date.now().toString(36)}`;
      chunk(res, { role: "assistant", content: null, tool_calls: [{ index: 0, id, type: "function", function: { name: "code_run", arguments: "" } }] });
      chunk(res, { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ language: "python", code: CODE }) } }] });
      chunk(res, {}, "tool_calls");
    }
    res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
    res.end("data: [DONE]\n\n");
    return;
  }
  res.writeHead(404).end();
}).listen(port, "127.0.0.1", () => console.log(`mock LLM on http://127.0.0.1:${port}/v1`));
