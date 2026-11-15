/**
 * M10: automatic memory + conversation compaction.
 *  - Auto recall: every model step gets the top-K memories relevant to the latest user turn (vector with a
 *    similarity floor, keyword fallback), cached per segment so a multi-step run embeds the query once.
 *  - Auto extraction: after a run completes, a helper model reads the last exchange plus related existing
 *    memories and returns JSON ops (add / update / none); source = "auto".
 *  - Compaction: when the prompt nears the context window, older turns of the active branch are summarized
 *    into conversations.summary (summaryUpTo = last covered message); assembleContext then sends the summary
 *    instead of those turns. The cut always lands before a user message so tool calls stay paired.
 */
import { recordLlmUsage, spendStatus } from "../usage";
import { eq } from "drizzle-orm";
import { DEFAULT_MEMORY_SETTINGS, type MemorySettingsDTO, type Message, type Part } from "@edgemind/shared";
import type { Database } from "../db/client";
import { conversations, memories, runs } from "../db/schema";
import { getSetting } from "../lib/settings";
import { collect, resolveModel, streamChat, type ResolvedModel } from "../llm";
import { loadBranch, type MessageRow } from "../agent/context";
import { embedFields, searchMemories, type MemorySearchCtx } from "../tools/memory";

type Fetch = typeof fetch;

export async function getMemorySettings(database: Database): Promise<MemorySettingsDTO> {
  const v = (await getSetting<Partial<MemorySettingsDTO>>(database, "memory_settings")) ?? {};
  const emb = (await getSetting<string>(database, "embedding_model_id")) ?? null;
  return {
    ...DEFAULT_MEMORY_SETTINGS,
    ...v,
    embeddingModelId: emb || null,
    compaction: { ...DEFAULT_MEMORY_SETTINGS.compaction, ...(v.compaction ?? {}) },
  };
}

export function normalizeMemorySettings(body: any): Partial<MemorySettingsDTO> {
  const out: Partial<MemorySettingsDTO> = {};
  const num = (v: unknown, min: number, max: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d);
  const D = DEFAULT_MEMORY_SETTINGS;
  out.autoRecall = body?.autoRecall !== undefined ? !!body.autoRecall : D.autoRecall;
  out.recallK = Math.round(num(body?.recallK, 1, 20, D.recallK));
  out.minScore = num(body?.minScore, 0, 1, D.minScore);
  out.autoExtract = body?.autoExtract !== undefined ? !!body.autoExtract : D.autoExtract;
  out.helperModelId = typeof body?.helperModelId === "string" && body.helperModelId ? body.helperModelId : null;
  const c = body?.compaction ?? {};
  out.compaction = {
    enabled: c.enabled !== undefined ? !!c.enabled : D.compaction.enabled,
    threshold: num(c.threshold, 0.3, 0.95, D.compaction.threshold),
    defaultContextTokens: Math.round(num(c.defaultContextTokens, 4000, 10_000_000, D.compaction.defaultContextTokens)),
    keepRecentRatio: num(c.keepRecentRatio, 0.05, 0.6, D.compaction.keepRecentRatio),
  };
  return out;
}

// ---------------- auto recall ----------------

/** Cache of recalled sections per (conversation, query) for the lifetime of one segment. */
export function memoryRecaller(ctx: Omit<MemorySearchCtx, "conversationId" | "projectId">) {
  const cache = new Map<string, string>();
  return async (input: { conversationId: string; projectId: string | null; query: string }): Promise<string> => {
    const q = input.query.trim().slice(0, 2000);
    if (!q) return "";
    const key = `${input.conversationId}|${q}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const s = await getMemorySettings(ctx.database);
    let text = "";
    if (s.autoRecall) {
      const r = await searchMemories({ ...ctx, conversationId: input.conversationId, projectId: input.projectId }, q, s.recallK, { minScore: s.minScore }).catch(() => null);
      if (r?.results.length) {
        const label = { global: "全域", project: "專案", conversation: "本對話" } as Record<string, string>;
        text =
          "以下是可能相關的長期記憶（自動召回，可能過時；與使用者當下說法衝突時以使用者為準，需要時用 memory_update 修正）：\n" +
          r.results.map((m) => `- [${label[m.scope] ?? m.scope}] ${m.content.replace(/\s+/g, " ").slice(0, 500)}（id: ${m.id}）`).join("\n");
      }
    }
    cache.set(key, text);
    return text;
  };
}

// ---------------- token estimate & compaction ----------------

/** Rough token estimate: CJK ≈ 1 token/char, other text ≈ 1 token/4 chars, images ≈ 1000. */
export function estimateTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) if (/[\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/.test(ch)) cjk++;
  return Math.ceil(cjk + (text.length - cjk) / 4);
}

export function partTokens(p: Part): number {
  switch (p.type) {
    case "text":
    case "reasoning":
      return estimateTokens(p.text ?? "");
    case "tool_call":
      return estimateTokens(JSON.stringify(p.args ?? {})) + 10;
    case "tool_result":
      return estimateTokens(typeof p.result === "string" ? p.result : JSON.stringify(p.result ?? "")) + 10;
    case "image":
      return 1000;
    case "file":
      return 2000;
    default:
      return 50;
  }
}

export const messageTokens = (m: Pick<Message, "parts">) => m.parts.reduce((n, p) => n + partTokens(p), 4);

function renderForSummary(rows: MessageRow[], maxChars: number): string {
  const lines: string[] = [];
  for (const r of rows) {
    for (const p of r.parts) {
      if (p.type === "text" && p.text.trim()) lines.push(`${r.role === "user" ? "使用者" : "助理"}：${p.text.trim()}`);
      else if (p.type === "tool_call") lines.push(`（助理呼叫工具 ${p.name}：${JSON.stringify(p.args ?? {}).slice(0, 300)}）`);
      else if (p.type === "tool_result") {
        const t = typeof p.result === "string" ? p.result : JSON.stringify(p.result ?? "");
        lines.push(`（工具結果${p.isError ? "（錯誤）" : ""}：${t.slice(0, 600)}）`);
      }
    }
  }
  let out = lines.join("\n");
  if (out.length > maxChars) out = `${out.slice(0, maxChars / 2)}\n…（中略）…\n${out.slice(-maxChars / 2)}`;
  return out;
}

/**
 * Decide whether the active branch needs compaction and where to cut. Returns the index (exclusive) of the
 * branch prefix to summarize, always just before a user message, or null.
 */
export function compactionCut(branch: MessageRow[], coveredUntil: number, budgetTokens: number, keepTokens: number, systemTokens: number): number | null {
  const sizes = branch.map((m) => messageTokens(m));
  const live = sizes.slice(coveredUntil).reduce((a, b) => a + b, 0) + systemTokens;
  if (live <= budgetTokens) return null;
  // keep the longest recent suffix that starts at a user message and fits in keepTokens
  let kept = 0;
  let cut = -1;
  for (let i = branch.length - 1; i > coveredUntil; i--) {
    kept += sizes[i];
    if (kept > keepTokens) break;
    if (branch[i].role === "user") cut = i;
  }
  if (cut < 0) {
    // even the latest turn exceeds keepTokens: keep just that turn
    const lastUser = branch.map((m) => m.role).lastIndexOf("user");
    return lastUser > coveredUntil ? lastUser : null;
  }
  return cut;
}

export async function summarize(model: ResolvedModel, previousSummary: string | null, rows: MessageRow[], signal?: AbortSignal): Promise<string> {
  const transcript = renderForSummary(rows, 60_000);
  const b = await collect(
    streamChat(
      model.cfg,
      {
        model: model.model,
        system:
          "你負責壓縮長對話的較早部分，讓之後的回覆仍能延續。輸出精簡但完整的摘要：使用者的目標與需求、已做的決定與理由、重要事實與數字、檔案或程式碼的狀態、未完成的事項。" +
          "使用者用中文時用正體中文。只輸出摘要本身，用條列。",
        messages: [
          {
            role: "user",
            parts: [{ type: "text", text: `${previousSummary ? `先前的摘要：\n${previousSummary}\n\n` : ""}要併入摘要的對話：\n${transcript}\n\n請輸出更新後的完整摘要（2000 字以內）。` }],
          },
        ],
        maxTokens: 2000,
      },
      { signal },
    ),
  );
  if (b.error) throw new Error(`摘要失敗：${b.error.message}`);
  const text = b.message().parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("").trim();
  if (!text) throw new Error("摘要模型沒有回傳內容");
  return text.slice(0, 12_000);
}

/** Index (exclusive) of the branch prefix covered by the stored summary (0 when none / not on this branch). */
export function coveredIndex(branch: MessageRow[], summaryUpTo: string | null): number {
  if (!summaryUpTo) return 0;
  const i = branch.findIndex((m) => m.id === summaryUpTo);
  return i < 0 ? 0 : i + 1;
}

export interface CompactResult {
  compacted: boolean;
  summarizedMessages?: number;
}

/**
 * Compact the conversation's active branch if needed (or always when `force`).
 * `contextTokens` = model window; `systemTokens` = rest of the prompt (system + tools).
 */
export async function maybeCompact(
  database: Database, conversationId: string, leafId: string, model: ResolvedModel, opts: { force?: boolean; systemTokens?: number; signal?: AbortSignal; helper?: ResolvedModel | null } = {},
): Promise<CompactResult> {
  const s = await getMemorySettings(database);
  if (!s.compaction.enabled && !opts.force) return { compacted: false };
  const [conv] = await database.db.select().from(conversations).where(eq(conversations.id, conversationId)).limit(1);
  if (!conv) return { compacted: false };
  const branch = await loadBranch(database, conversationId, leafId);
  const covered = coveredIndex(branch, conv.summaryUpTo);
  const window = model.contextLength ?? s.compaction.defaultContextTokens;
  const budget = opts.force ? 0 : Math.floor(window * s.compaction.threshold);
  const keep = Math.floor(window * s.compaction.keepRecentRatio);
  const cut = compactionCut(branch, covered, budget, keep, opts.systemTokens ?? 0);
  if (cut === null || cut <= covered) return { compacted: false };
  const prev = covered > 0 ? conv.summary : null;
  const summary = await summarize(opts.helper ?? model, prev, branch.slice(covered, cut), opts.signal);
  await database.db.update(conversations).set({ summary, summaryUpTo: branch[cut - 1].id, summaryUpdatedAt: new Date() }).where(eq(conversations.id, conversationId));
  return { compacted: true, summarizedMessages: cut - covered };
}

export async function helperModel(database: Database, encKey: Uint8Array, fetchFn: Fetch | undefined, fallbackModelRowId: string | null): Promise<ResolvedModel | null> {
  const s = await getMemorySettings(database);
  for (const id of [s.helperModelId, fallbackModelRowId]) {
    if (!id) continue;
    try {
      return await resolveModel(database, encKey, id, fetchFn);
    } catch {
      /* try the next one */
    }
  }
  return null;
}

// ---------------- auto extraction ----------------

const textOf = (rows: MessageRow[], role: string) =>
  rows.filter((m) => m.role === role).flatMap((m) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : []))).join("\n").trim();

function parseOps(raw: string): { op: string; id?: string; content?: string; scope?: string }[] {
  const m = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const body = (m ? m[1] : raw).trim();
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start < 0 || end < start) return [];
  try {
    const v = JSON.parse(body.slice(start, end + 1));
    return Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : [];
  } catch {
    return [];
  }
}

export interface ExtractResult {
  added: number;
  updated: number;
  skipped?: string;
}

/** After a completed run: extract durable facts from the last exchange (user turn → final answer). */
export async function extractMemories(database: Database, encKey: Uint8Array, fetchFn: Fetch, runId: string): Promise<ExtractResult> {
  const s = await getMemorySettings(database);
  if (!s.autoExtract) return { added: 0, updated: 0, skipped: "disabled" };
  const [run] = await database.db.select().from(runs).where(eq(runs.id, runId)).limit(1);
  if (!run || run.status !== "completed") return { added: 0, updated: 0, skipped: "not_completed" };
  const [conv] = await database.db.select().from(conversations).where(eq(conversations.id, run.conversationId)).limit(1);
  if (!conv?.activeLeafId) return { added: 0, updated: 0, skipped: "no_leaf" };
  const branch = await loadBranch(database, conv.id, conv.activeLeafId);
  const lastUser = branch.map((m) => m.role).lastIndexOf("user");
  if (lastUser < 0) return { added: 0, updated: 0, skipped: "no_user" };
  const exchange = branch.slice(lastUser);
  const userText = textOf(exchange, "user");
  if (userText.length < 8) return { added: 0, updated: 0, skipped: "too_short" };
  const assistantText = textOf(exchange, "assistant");
  const model = await helperModel(database, encKey, fetchFn, run.modelId);
  if (!model) return { added: 0, updated: 0, skipped: "no_model" };
  const spend = await spendStatus(database);
  if (spend.daily === "blocked" || spend.monthly === "blocked") return { added: 0, updated: 0, skipped: "spend_cap" };

  const ctx: MemorySearchCtx = { database, encKey, fetch: fetchFn, conversationId: conv.id, projectId: conv.projectId, runId };
  const related = await searchMemories(ctx, userText.slice(0, 1000), 8).catch(() => ({ results: [] as { id: string; scope: string; content: string }[] }));
  const existing = related.results.map((m) => `- id=${m.id} [${m.scope}] ${m.content}`).join("\n") || "（無）";

  const b = await collect(
    streamChat(model.cfg, {
      model: model.model,
      system:
        "你從對話中萃取值得長期記住的資訊：使用者的偏好、身分背景、長期目標、做過的決定、反覆會用到的事實。" +
        "不要記：一次性的問題內容、助理自己的回答、敏感資料（密碼、金鑰、身分證號、卡號）、可以隨時再查到的一般知識。" +
        "已有相同或相近的記憶時用 update 修正，不要重複新增。大多數對話沒有值得記的內容，這時輸出 []。" +
        '只輸出 JSON 陣列，元素格式：{"op":"add","content":"…","scope":"global|project"} 或 {"op":"update","id":"…","content":"…"}。content 用一句可獨立理解的完整敘述，使用者用中文時用正體中文。',
      messages: [
        {
          role: "user",
          parts: [{
            type: "text",
            text: `已有的相關記憶：\n${existing}\n\n${conv.projectId ? "（這段對話屬於某個專案；只跟專案有關的事用 scope=project）\n" : ""}使用者：${userText.slice(0, 4000)}\n\n助理：${assistantText.slice(0, 2000)}`,
          }],
        },
      ],
      maxTokens: 600,
    }),
  );
  if (b.usage) await recordLlmUsage(database, { providerId: model.providerId, model: model.model, modelRowId: model.modelRowId, runId, conversationId: conv.id, usage: b.usage }).catch(() => {});
  if (b.error) return { added: 0, updated: 0, skipped: `model_error: ${b.error.message}` };
  const ops = parseOps(b.message().parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join(""));
  const known = new Set(related.results.map((m) => m.id));
  let added = 0;
  let updated = 0;
  for (const op of ops.slice(0, 8)) {
    const content = typeof op.content === "string" ? op.content.trim().slice(0, 1000) : "";
    if (!content || /(sk-|ghp_|github_pat_|AKIA)[A-Za-z0-9_]{8,}/.test(content)) continue;
    if (op.op === "update" && typeof op.id === "string" && known.has(op.id)) {
      const { fields } = await embedFields({ database, fetch: fetchFn, encKey, runId }, content);
      await database.db.update(memories).set({ content, ...fields, updatedAt: new Date() }).where(eq(memories.id, op.id));
      updated++;
    } else if (op.op === "add" && added < 5) {
      const scope = op.scope === "project" && conv.projectId ? "project" : "global";
      const { fields } = await embedFields({ database, fetch: fetchFn, encKey, runId }, content);
      await database.db.insert(memories).values({ scope, content, source: "auto", projectId: scope === "project" ? conv.projectId : null, ...fields });
      added++;
    }
  }
  return { added, updated };
}
