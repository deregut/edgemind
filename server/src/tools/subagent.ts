/**
 * subagent [read]: delegates a self-contained research task to a fresh, isolated context with the run's model.
 * The sub-agent only gets read-only, non-interactive tools (never itself), runs at most `maxSteps` model steps inside
 * the current segment and returns just its final text, keeping the parent's context small.
 */
import { AssistantBuilder, streamChat } from "../llm";
import type { Message, Part } from "@edgemind/shared";
import { ToolDeferred, type Tool } from "../agent/tools";
import { usageLogs } from "../db/schema";

const MAX_STEPS_CAP = 8;
const MIN_MS = 15_000;
const SYSTEM = "你是被主代理派出的子代理，只負責完成指派的單一任務。可使用唯讀工具查資料；完成後以簡潔、可直接引用的文字回報結果（含關鍵來源網址），不要提問。";

export const subagentTool: Tool = {
  name: "subagent",
  description: "派出子代理處理一個獨立的研究／查找任務（唯讀工具：搜尋、網頁、檔案、記憶、知識庫），只回傳最終摘要，不佔用主對話脈絡。任務描述需完整自足。",
  parameters: {
    type: "object",
    properties: {
      task: { type: "string", description: "完整、自足的任務說明" },
      maxSteps: { type: "integer", description: "最多模型步數（1–8，預設 5）" },
    },
    required: ["task"],
  },
  risk: "read",
  nonIdempotent: true,
  async execute(args, ctx) {
    const task = typeof args?.task === "string" ? args.task.trim() : "";
    if (!task) throw new Error("task 不可為空");
    if (!ctx.model || !ctx.registry) throw new Error("子代理無法取得模型");
    if (ctx.deadline !== undefined && ctx.deadline - Date.now() < MIN_MS) throw new ToolDeferred();
    const maxSteps = Math.min(MAX_STEPS_CAP, Math.max(1, Number(args?.maxSteps) || 5));
    const reg = ctx.registry;
    const allowed = (t: Tool) => t.risk === "read" && !t.interactive && !t.clientSide && t.name !== "subagent" && (!t.projectOnly || !!ctx.projectId);
    const defs = reg.defs(allowed);
    const messages: Message[] = [{ role: "user", parts: [{ type: "text", text: task }] }];
    let final = "";
    for (let step = 1; step <= maxSteps; step++) {
      if (ctx.signal.aborted) throw new Error("已中止");
      if (ctx.deadline !== undefined && ctx.deadline - Date.now() < 5_000) throw new ToolDeferred();
      const last = step === maxSteps;
      const b = new AssistantBuilder();
      for await (const ev of streamChat(ctx.model.cfg, { model: ctx.model.model, system: SYSTEM, messages, tools: last ? [] : defs }, { signal: ctx.signal })) b.push(ev);
      if (b.error) {
        if (b.error.code === "aborted") throw new ToolDeferred();
        throw new Error(`子代理模型錯誤：${b.error.message}`);
      }
      if (b.usage) {
        await ctx.database.db.insert(usageLogs).values({
          providerId: ctx.model.providerId, model: ctx.model.model, runId: ctx.runId, kind: "chat",
          inputTokens: b.usage.inputTokens, outputTokens: b.usage.outputTokens, cachedTokens: b.usage.cachedInputTokens ?? null,
        });
      }
      const msg = b.message();
      messages.push(msg);
      const calls = msg.parts.filter((p): p is Extract<Part, { type: "tool_call" }> => p.type === "tool_call");
      final = msg.parts.filter((p) => p.type === "text").map((p: any) => p.text).join("").trim();
      if (!calls.length) return { result: final || "（子代理沒有產出文字）", steps: step };
      const results: Part[] = [];
      for (const c of calls) {
        const tool = reg.get(c.name);
        let result: unknown, isError = false;
        if (!tool || !allowed(tool)) { result = `子代理不可使用工具 ${c.name}`; isError = true; }
        else {
          try { result = await tool.execute(c.args, { ...ctx, callId: `${ctx.callId}:${c.id}` }); }
          catch (e) {
            if (e instanceof ToolDeferred) throw e;
            if (ctx.signal.aborted) throw new ToolDeferred();
            result = `工具執行失敗：${(e as Error).message}`; isError = true;
          }
        }
        const text = JSON.stringify(result);
        results.push({ type: "tool_result", callId: c.id, name: c.name, result: text.length > 20_000 ? text.slice(0, 20_000) + "…（截斷）" : result, ...(isError ? { isError: true } : {}) });
      }
      messages.push({ role: "tool", parts: results });
    }
    return { result: final || "（子代理達到步數上限且沒有最終文字）", steps: maxSteps };
  },
};
