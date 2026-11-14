import { describe, expect, it } from "vitest";
import type { ChatRequest, StreamEvent } from "@edgemind/shared";
import { buildHttpRequest, collect, parseExtraHeaders, parseSse, sanitizeSchema, streamChat, type LlmConfig } from "../src/llm";
import { chunkedStream, fixture, noSleep, queueFetch, sseResponse } from "./llm-helpers";

const tools = [
  { name: "get_time", description: "現在時間", parameters: { type: "object", properties: { tz: { type: "string" } }, additionalProperties: false } },
  { name: "echo", description: "回聲", parameters: { $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: { text: { type: ["string", "null"] } } } },
];

const baseReq: ChatRequest = {
  model: "m",
  system: "你是助理",
  messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
  tools,
};

function cfg(protocol: LlmConfig["protocol"], f: typeof fetch, extra: Partial<LlmConfig> = {}): LlmConfig {
  const baseUrl = protocol === "openai" ? "https://api.example.com/v1" : protocol === "anthropic" ? "https://api.anthropic.com" : "https://generativelanguage.googleapis.com";
  return { protocol, baseUrl, apiKey: "sk-secret-key-123456", fetch: f, retry: noSleep, capabilities: { tools: true, vision: true, reasoning: true }, ...extra };
}

async function events(stream: AsyncIterable<StreamEvent>) {
  const out: StreamEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

describe("SSE parser", () => {
  it("handles CRLF/CR/LF, comments, multi-line data, BOM, split chunks, and an unterminated last event", async () => {
    const text = "\uFEFF: comment\r\nevent: a\r\ndata: one\r\ndata: two\r\n\r\ndata: 中文字\r\rid: 7\ndata: x\n\ndata: tail-no-blank-line";
    for (const size of [1, 2, 3, 5, 64]) {
      const got: any[] = [];
      for await (const e of parseSse(chunkedStream(text, size))) got.push(e);
      expect(got).toEqual([
        { event: "a", data: "one\ntwo", id: undefined },
        { event: "message", data: "中文字", id: undefined },
        { event: "message", data: "x", id: "7" },
        { event: "message", data: "tail-no-blank-line", id: "7" },
      ]);
    }
  });
});

describe("OpenAI Chat Completions", () => {
  it("streams text + usage and sends a correct request (extra headers, tools, stream usage)", async () => {
    const m = queueFetch([sseResponse(fixture("openai-chat-text.sse"), 5)]);
    const b = await collect(streamChat(cfg("openai", m.fetch, { headers: { "http-referer": "https://me" } }), { ...baseReq, maxTokens: 100, parallelToolCalls: true }));
    expect(b.text).toBe("你好，世界！");
    expect(b.finish).toBe("stop");
    expect(b.usage).toEqual({ inputTokens: 42, outputTokens: 7, cachedInputTokens: 10, reasoningTokens: 0 });
    const call = m.calls[0];
    expect(call.url).toBe("https://api.example.com/v1/chat/completions");
    expect(call.headers.authorization).toBe("Bearer sk-secret-key-123456");
    expect(call.headers["http-referer"]).toBe("https://me");
    expect(call.body).toMatchObject({ model: "m", stream: true, stream_options: { include_usage: true }, max_tokens: 100, parallel_tool_calls: true });
    expect(call.body.messages[0]).toEqual({ role: "system", content: "你是助理" });
    expect(call.body.tools[0]).toEqual({ type: "function", function: tools[0] });
  });

  it("assembles parallel tool calls from interleaved deltas", async () => {
    const m = queueFetch([sseResponse(fixture("openai-chat-parallel-tools.sse"), 3)]);
    const evs = await events(streamChat(cfg("openai", m.fetch), baseReq));
    expect(evs.filter((e) => e.type === "tool-call-start").map((e: any) => e.name)).toEqual(["get_time", "echo"]);
    const ends = evs.filter((e) => e.type === "tool-call-end") as any[];
    expect(ends.map((e) => [e.id, e.name, e.args])).toEqual([
      ["call_a", "get_time", { tz: "Asia/Taipei" }],
      ["call_b", "echo", { text: "哈囉" }],
    ]);
    expect(evs.at(-1)).toEqual({ type: "finish", reason: "tool_calls", rawReason: "tool_calls" });
  });

  it("reads reasoning_content as reasoning", async () => {
    const m = queueFetch([sseResponse(fixture("openai-chat-reasoning.sse"), 4)]);
    const b = await collect(streamChat(cfg("openai", m.fetch), { ...baseReq, reasoning: { effort: "high" } }));
    expect(b.message().parts).toEqual([
      { type: "reasoning", text: "先想一下：1+1=2。", providerMeta: { protocol: "openai" } },
      { type: "text", text: "答案是 2。" },
    ]);
    expect(b.usage?.reasoningTokens).toBe(12);
    expect(m.calls[0].body.reasoning_effort).toBe("high");
  });

  it("surfaces a mid-stream error event and keeps partial text", async () => {
    const m = queueFetch([sseResponse(fixture("openai-chat-error.sse"))]);
    const b = await collect(streamChat(cfg("openai", m.fetch), baseReq));
    expect(b.text).toBe("部分");
    expect(b.finish).toBe("error");
    expect(b.error).toMatchObject({ message: "Upstream overloaded", code: "overloaded" });
  });

  it("converts history: assistant tool calls, tool results, images; uses max_completion_tokens on api.openai.com", async () => {
    const req: ChatRequest = {
      model: "gpt-x",
      maxTokens: 50,
      messages: [
        { role: "user", parts: [{ type: "text", text: "看圖" }, { type: "image", mime: "image/png", data: "AAAA" }] },
        { role: "assistant", parts: [{ type: "reasoning", text: "hmm" }, { type: "text", text: "ok" }, { type: "tool_call", id: "c1", name: "echo", args: { text: "a" } }] },
        { role: "tool", parts: [{ type: "tool_result", callId: "c1", name: "echo", result: { echoed: "a" } }] },
      ],
    };
    const spec = buildHttpRequest({ protocol: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "k", capabilities: { vision: true } }, req);
    expect(spec.body.max_completion_tokens).toBe(50);
    expect(spec.body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "看圖" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
      { role: "assistant", content: "ok", tool_calls: [{ id: "c1", type: "function", function: { name: "echo", arguments: '{"text":"a"}' } }] },
      { role: "tool", tool_call_id: "c1", content: '{"echoed":"a"}' },
    ]);
    // no vision → image becomes a note; no tools → tool history flattened to text
    const spec2 = buildHttpRequest({ protocol: "openai", baseUrl: "https://x/v1", apiKey: null, capabilities: { vision: false, tools: false } }, { ...req, tools });
    expect(spec2.body.tools).toBeUndefined();
    expect(JSON.stringify(spec2.body.messages)).not.toContain("image_url");
    expect(JSON.stringify(spec2.body.messages)).toContain("此模型不支援視覺輸入");
    expect(spec2.body.messages.some((m: any) => m.role === "tool")).toBe(false);
  });
});

describe("OpenAI Responses API", () => {
  it("streams text with usage", async () => {
    const m = queueFetch([sseResponse(fixture("openai-responses-text.sse"), 9)]);
    const b = await collect(streamChat(cfg("openai", m.fetch, { openaiApi: "responses" }), baseReq));
    expect(b.text).toBe("Hello there");
    expect(b.finish).toBe("stop");
    expect(m.calls[0].url).toBe("https://api.example.com/v1/responses");
    expect(m.calls[0].body).toMatchObject({ instructions: "你是助理", store: false, input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }] });
    expect(m.calls[0].body.tools[0]).toMatchObject({ type: "function", name: "get_time", strict: false });
  });

  it("reasoning summary + encrypted item + parallel function calls, and replays them", async () => {
    const m = queueFetch([sseResponse(fixture("openai-responses-reasoning-tools.sse"), 11)]);
    const c = cfg("openai", m.fetch, { openaiApi: "responses" });
    const b = await collect(streamChat(c, { ...baseReq, reasoning: { effort: "low" } }));
    expect(m.calls[0].body.reasoning).toEqual({ effort: "low", summary: "auto" });
    expect(m.calls[0].body.include).toEqual(["reasoning.encrypted_content"]);
    expect(b.finish).toBe("tool_calls");
    expect(b.usage?.reasoningTokens).toBe(64);
    const msg = b.message();
    expect(msg.parts[0]).toMatchObject({ type: "reasoning", text: "**Planning** I should call two tools.", providerMeta: { encrypted: "gAAAAenc==", itemId: "rs_1" } });
    expect(b.toolCalls.map((t) => [t.id, t.args])).toEqual([["call_x", { tz: "UTC" }], ["call_y", { text: "hi" }]]);
    const spec = buildHttpRequest(c, { model: "m", messages: [...baseReq.messages, msg, { role: "tool", parts: [{ type: "tool_result", callId: "call_x", name: "get_time", result: "12:00" }] }] });
    const input = spec.body.input as any[];
    expect(input[1]).toMatchObject({ type: "reasoning", id: "rs_1", encrypted_content: "gAAAAenc==" });
    expect(input[2]).toEqual({ type: "function_call", call_id: "call_x", name: "get_time", arguments: '{"tz":"UTC"}' });
    expect(input.at(-1)).toEqual({ type: "function_call_output", call_id: "call_x", output: "12:00" });
  });

  it("response.failed → error event", async () => {
    const m = queueFetch([sseResponse(fixture("openai-responses-failed.sse"))]);
    const evs = await events(streamChat(cfg("openai", m.fetch, { openaiApi: "responses" }), baseReq));
    expect(evs.at(-1)).toMatchObject({ type: "error", error: { message: "The model failed", code: "server_error", retryable: true } });
  });
});

describe("Anthropic Messages", () => {
  it("streams text, normalizes cached usage, sends version header", async () => {
    const m = queueFetch([sseResponse(fixture("anthropic-text.sse"), 6)]);
    const b = await collect(streamChat(cfg("anthropic", m.fetch), { ...baseReq, temperature: 0.3 }));
    expect(b.text).toBe("Hi! 👋");
    expect(b.finish).toBe("stop");
    expect(b.usage).toEqual({ inputTokens: 125, outputTokens: 5, cachedInputTokens: 100 });
    expect(m.calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(m.calls[0].headers["x-api-key"]).toBe("sk-secret-key-123456");
    expect(m.calls[0].headers["anthropic-version"]).toBe("2023-06-01");
    expect(m.calls[0].body).toMatchObject({ system: "你是助理", max_tokens: 8192, temperature: 0.3 });
    expect(m.calls[0].body.tools[0]).toEqual({ name: "get_time", description: "現在時間", input_schema: tools[0].parameters });
  });

  it("thinking (signed + redacted) and parallel tool_use; replays signatures and merges tool results", async () => {
    const m = queueFetch([sseResponse(fixture("anthropic-thinking-tools.sse"), 13)]);
    const c = cfg("anthropic", m.fetch);
    const b = await collect(streamChat(c, { ...baseReq, reasoning: { effort: "medium" }, temperature: 1, parallelToolCalls: false }));
    expect(m.calls[0].body.thinking).toEqual({ type: "enabled", budget_tokens: 8192 });
    expect(m.calls[0].body.max_tokens).toBe(8192 + 4096);
    expect(m.calls[0].body.temperature).toBeUndefined();
    expect(m.calls[0].body.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
    expect(b.finish).toBe("tool_calls");
    const msg = b.message();
    expect(msg.parts).toEqual([
      { type: "reasoning", text: "I need the time and an echo.", signature: "EqQBCgIYAhIM", providerMeta: { protocol: "anthropic" } },
      { type: "reasoning", text: "", redacted: "EmwKAhgBEgy3va", providerMeta: { protocol: "anthropic" } },
      { type: "text", text: "Checking." },
      { type: "tool_call", id: "toolu_1", name: "get_time", args: { tz: "Asia/Taipei" } },
      { type: "tool_call", id: "toolu_2", name: "get_time", args: {} },
    ]);
    const spec = buildHttpRequest(c, {
      model: "m",
      messages: [
        ...baseReq.messages,
        msg,
        { role: "tool", parts: [{ type: "tool_result", callId: "toolu_1", name: "get_time", result: "12:00" }] },
        { role: "tool", parts: [{ type: "tool_result", callId: "toolu_2", name: "get_time", result: "boom", isError: true }] },
        { role: "user", parts: [{ type: "text", text: "thanks" }] },
      ],
    });
    const msgs = spec.body.messages as any[];
    expect(msgs.map((x) => x.role)).toEqual(["user", "assistant", "user"]);
    expect(msgs[1].content.slice(0, 2)).toEqual([
      { type: "thinking", thinking: "I need the time and an echo.", signature: "EqQBCgIYAhIM" },
      { type: "redacted_thinking", data: "EmwKAhgBEgy3va" },
    ]);
    expect(msgs[2].content).toEqual([
      { type: "tool_result", tool_use_id: "toolu_1", content: "12:00" },
      { type: "tool_result", tool_use_id: "toolu_2", content: "boom", is_error: true },
      { type: "text", text: "thanks" },
    ]);
  });

  it("drops reasoning that belongs to another protocol", () => {
    const spec = buildHttpRequest({ protocol: "anthropic", baseUrl: "https://api.anthropic.com/v1", apiKey: "k" }, {
      model: "m",
      messages: [
        { role: "user", parts: [{ type: "text", text: "q" }, { type: "image", mime: "image/jpeg", data: "BBBB" }] },
        { role: "assistant", parts: [{ type: "reasoning", text: "x", providerMeta: { protocol: "gemini", thoughtSignature: "s" } }, { type: "text", text: "a" }] },
      ],
    });
    expect(spec.url).toBe("https://api.anthropic.com/v1/messages");
    const msgs = spec.body.messages as any[];
    expect(msgs[0].content[1]).toEqual({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "BBBB" } });
    expect(msgs[1].content).toEqual([{ type: "text", text: "a" }]);
  });

  it("mid-stream overloaded error is retryable and partial text kept", async () => {
    const m = queueFetch([sseResponse(fixture("anthropic-error.sse"))]);
    const b = await collect(streamChat(cfg("anthropic", m.fetch), baseReq));
    expect(b.text).toBe("Partial");
    expect(b.error).toEqual({ message: "Overloaded", code: "overloaded_error", retryable: true });
  });
});

describe("Gemini generateContent", () => {
  it("streams text (CRLF), builds systemInstruction + sanitized tool schema", async () => {
    const m = queueFetch([sseResponse(fixture("gemini-text.sse"), 4)]);
    const b = await collect(streamChat(cfg("gemini", m.fetch), { ...baseReq, model: "models/gemini-2.5-flash", toolChoice: "auto" }));
    expect(b.text).toBe("天氣很好。");
    expect(b.finish).toBe("stop");
    expect(b.usage).toEqual({ inputTokens: 12, outputTokens: 5, cachedInputTokens: undefined, reasoningTokens: undefined });
    const call = m.calls[0];
    expect(call.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse");
    expect(call.headers["x-goog-api-key"]).toBe("sk-secret-key-123456");
    expect(call.body.systemInstruction).toEqual({ parts: [{ text: "你是助理" }] });
    const decls = call.body.tools[0].functionDeclarations;
    expect(decls[0].parameters).toEqual({ type: "object", properties: { tz: { type: "string" } } });
    expect(decls[1].parameters).toEqual({ type: "object", properties: { text: { type: "string", nullable: true } } });
    expect(call.body.toolConfig).toEqual({ functionCallingConfig: { mode: "AUTO" } });
  });

  it("thought parts + parallel function calls with thoughtSignature round-trip", async () => {
    const m = queueFetch([sseResponse(fixture("gemini-thinking-tools.sse"), 10)]);
    const c = cfg("gemini", m.fetch);
    const b = await collect(streamChat(c, { ...baseReq, reasoning: { effort: "low" } }));
    expect(m.calls[0].body.generationConfig.thinkingConfig).toEqual({ includeThoughts: true, thinkingBudget: 2048 });
    expect(b.finish).toBe("tool_calls");
    expect(b.usage).toMatchObject({ inputTokens: 30, outputTokens: 60, reasoningTokens: 40 });
    const msg = b.message();
    expect(msg.parts[0]).toEqual({ type: "reasoning", text: "**Considering** need time.", providerMeta: { protocol: "gemini" } });
    const [t1, t2] = b.toolCalls;
    expect([t1.name, t1.args, t1.providerMeta?.thoughtSignature]).toEqual(["get_time", { tz: "UTC" }, "CiQBsig1=="]);
    expect([t2.name, t2.args]).toEqual(["echo", { text: "嗨" }]);
    expect(t1.id).not.toBe(t2.id);
    const spec = buildHttpRequest(c, {
      model: "g",
      messages: [
        ...baseReq.messages,
        msg,
        { role: "tool", parts: [
          { type: "tool_result", callId: t1.id, name: "get_time", result: "12:00" },
          { type: "tool_result", callId: t2.id, name: "echo", result: { text: "嗨" } },
        ] },
      ],
    });
    const contents = spec.body.contents as any[];
    expect(contents.map((x) => x.role)).toEqual(["user", "model", "user"]);
    expect(contents[1].parts).toEqual([
      { functionCall: { name: "get_time", args: { tz: "UTC" } }, thoughtSignature: "CiQBsig1==" },
      { functionCall: { name: "echo", args: { text: "嗨" } } },
    ]);
    expect(contents[2].parts).toEqual([
      { functionResponse: { name: "get_time", response: { result: "12:00" } } },
      { functionResponse: { name: "echo", response: { text: "嗨" } } },
    ]);
  });

  it("error chunk → error event", async () => {
    const m = queueFetch([sseResponse(fixture("gemini-error.sse"))]);
    const evs = await events(streamChat(cfg("gemini", m.fetch), baseReq));
    expect(evs.at(-1)).toMatchObject({ type: "error", error: { status: 503, code: "UNAVAILABLE", retryable: true } });
  });

  it("sanitizeSchema strips unsupported keywords recursively", () => {
    expect(sanitizeSchema({ type: "object", additionalProperties: false, properties: { a: { type: "array", items: { type: "object", $ref: "#/x", default: 1 } } } }))
      .toEqual({ type: "object", properties: { a: { type: "array", items: { type: "object" } } } });
  });
});

describe("HTTP behaviour", () => {
  it("retries 429 (honouring Retry-After) and 503, then succeeds", async () => {
    const delays: number[] = [];
    const m = queueFetch([
      new Response('{"error":{"message":"rate limited"}}', { status: 429, headers: { "retry-after": "2" } }),
      new Response("bad gateway", { status: 503 }),
      sseResponse(fixture("anthropic-text.sse")),
    ]);
    const b = await collect(streamChat(cfg("anthropic", m.fetch, { retry: { ...noSleep, onRetry: (_a, d) => delays.push(d) } }), baseReq));
    expect(b.text).toBe("Hi! 👋");
    expect(m.calls).toHaveLength(3);
    expect(delays[0]).toBe(2000);
  });

  it("retries network errors; gives up after maxRetries", async () => {
    const m = queueFetch([new TypeError("fetch failed"), new TypeError("fetch failed"), new TypeError("fetch failed")]);
    const evs = await events(streamChat(cfg("openai", m.fetch, { retry: { ...noSleep, maxRetries: 2 } }), baseReq));
    expect(m.calls).toHaveLength(3);
    expect(evs).toEqual([{ type: "error", error: { message: "無法連線：fetch failed", code: "network", retryable: true } }]);
  });

  it("does not retry 400 and scrubs the API key from errors", async () => {
    const m = queueFetch([new Response('{"error":{"message":"bad key sk-secret-key-123456","type":"invalid_request_error"}}', { status: 400 })]);
    const evs = await events(streamChat(cfg("openai", m.fetch), baseReq));
    expect(m.calls).toHaveLength(1);
    expect(evs[0]).toEqual({ type: "error", error: { message: "HTTP 400：bad key ***", status: 400, code: "invalid_request_error", retryable: false } });
  });

  it("abort mid-stream ends with an aborted error and keeps partial output", async () => {
    const ac = new AbortController();
    const m = queueFetch([sseResponse(fixture("openai-chat-text.sse"), 20, { delayMs: 5 })]);
    const b = new (await import("../src/llm")).AssistantBuilder();
    for await (const ev of streamChat(cfg("openai", m.fetch), baseReq, { signal: ac.signal })) {
      b.push(ev);
      if (ev.type === "text-delta") ac.abort();
    }
    expect(b.finish).toBe("aborted");
    expect(b.error?.code).toBe("aborted");
    expect(b.text).toBe("你好");
  });

  it("abort during backoff stops retrying", async () => {
    const ac = new AbortController();
    const m = queueFetch([new Response("x", { status: 500 }), sseResponse(fixture("openai-chat-text.sse"))]);
    setTimeout(() => ac.abort(), 20);
    const t0 = Date.now();
    const evs = await events(streamChat(cfg("openai", m.fetch, { retry: { baseDelayMs: 5000, maxDelayMs: 5000 } }), baseReq, { signal: ac.signal }));
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(m.calls).toHaveLength(1);
    expect(evs).toEqual([{ type: "error", error: expect.objectContaining({ code: "aborted" }) }]);
  });

  it("parses extra headers from lines or JSON", () => {
    expect(parseExtraHeaders("HTTP-Referer: https://a.b\nX-Title: EdgeMind\nbad line")).toEqual({ "http-referer": "https://a.b", "x-title": "EdgeMind" });
    expect(parseExtraHeaders('{"X-A":"1","bad key":"2"}')).toEqual({ "x-a": "1" });
    expect(parseExtraHeaders("")).toEqual({});
  });
});
