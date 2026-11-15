/**
 * Usage recording, cost, spend caps and aggregation (用量).
 *
 * Token semantics (all adapters normalize to this): inputTokens INCLUDES cached input; outputTokens INCLUDES
 * reasoning tokens. Cost = (input − cached) × input price + cached × cached price (falls back to the input price)
 * + output × output price, all USD per 1M tokens from settings `model_prices` (keyed by models row id).
 *
 * Spend caps (settings `spend_caps`): daily / monthly USD limits in an IANA timezone, checked before every LLM
 * call (agent loop, sub-agents, auto titles, memory extraction). Reaching a cap blocks the call with a clear
 * error; at `warnRatio` (default 80 %) a warning is recorded once per run.
 */
import type { SpendCaps, SpendStatus, Usage, UsageReport, UsageRow } from "@edgemind/shared";
import type { Database } from "../db/client";
import { usageLogs } from "../db/schema";
import { getModelPrices, getSetting, type ModelPrices } from "../lib/settings";
import { isValidTimezone, localDate, localDayStart, localMonthStart, zonedToUtc } from "../scheduler/cron";

export const DEFAULT_SPEND_CAPS: SpendCaps = { dailyUsd: null, monthlyUsd: null, warnRatio: 0.8, timezone: "UTC" };

const pos = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

export function normalizeSpendCaps(v: any): SpendCaps {
  if (!v || typeof v !== "object") return { ...DEFAULT_SPEND_CAPS };
  const r = Number(v.warnRatio);
  return {
    dailyUsd: pos(v.dailyUsd),
    monthlyUsd: pos(v.monthlyUsd),
    warnRatio: Number.isFinite(r) && r > 0 && r < 1 ? r : 0.8,
    timezone: isValidTimezone(v.timezone) ? v.timezone : "UTC",
  };
}

export async function getSpendCaps(database: Database): Promise<SpendCaps> {
  return normalizeSpendCaps(await getSetting(database, "spend_caps"));
}

export function costOf(prices: ModelPrices, modelRowId: string | null | undefined, u: Pick<Usage, "inputTokens" | "outputTokens" | "cachedInputTokens">): number | null {
  const p = modelRowId ? prices[modelRowId] : undefined;
  if (!p) return null;
  const cached = Math.min(u.cachedInputTokens ?? 0, u.inputTokens);
  const cachedPrice = typeof p.cachedInput === "number" && p.cachedInput >= 0 ? p.cachedInput : p.input || 0;
  return ((u.inputTokens - cached) * (p.input || 0) + cached * cachedPrice + u.outputTokens * (p.output || 0)) / 1_000_000;
}

export interface LlmUsageRecord {
  providerId: string | null;
  model: string;
  modelRowId: string | null;
  runId?: string | null;
  conversationId?: string | null;
  usage: Usage;
}

/** Insert one chat-call usage row with its cost. Returns the cost (null when the model has no price). */
export async function recordLlmUsage(database: Database, r: LlmUsageRecord, prices?: ModelPrices): Promise<number | null> {
  const costUsd = costOf(prices ?? (await getModelPrices(database)), r.modelRowId, r.usage);
  await database.db.insert(usageLogs).values({
    providerId: r.providerId, model: r.model, modelId: r.modelRowId, runId: r.runId ?? null, conversationId: r.conversationId ?? null, kind: "chat",
    inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens,
    cachedTokens: r.usage.cachedInputTokens ?? null, reasoningTokens: r.usage.reasoningTokens ?? null, costUsd,
  });
  return costUsd;
}

const usd = (n: number) => `US$${n.toFixed(n < 1 ? 4 : 2)}`;

export async function spendStatus(database: Database, now = Date.now()): Promise<SpendStatus> {
  const caps = await getSpendCaps(database);
  const day = localDayStart(now, caps.timezone);
  const month = localMonthStart(now, caps.timezone);
  const [row] = await database.query<{ today: number; month: number }>(
    `SELECT coalesce(sum(cost_usd) FILTER (WHERE created_at >= $1), 0)::float8 AS today,
            coalesce(sum(cost_usd), 0)::float8 AS month
       FROM usage_logs WHERE created_at >= $2`,
    [new Date(day).toISOString(), new Date(Math.min(day, month)).toISOString()],
  );
  const todayUsd = Number(row?.today ?? 0);
  const monthUsd = Number(row?.month ?? 0);
  const level = (spent: number, cap: number | null) => (cap === null ? "ok" : spent >= cap ? "blocked" : spent >= cap * caps.warnRatio ? "warning" : "ok") as SpendStatus["daily"];
  const daily = level(todayUsd, caps.dailyUsd);
  const monthly = level(monthUsd, caps.monthlyUsd);
  let message: string | null = null;
  if (daily === "blocked") message = `已達每日花費上限（今日 ${usd(todayUsd)} / 上限 ${usd(caps.dailyUsd!)}），模型呼叫已暫停；可到「用量」頁調高上限，或等到明天（${caps.timezone}）。`;
  else if (monthly === "blocked") message = `已達每月花費上限（本月 ${usd(monthUsd)} / 上限 ${usd(caps.monthlyUsd!)}），模型呼叫已暫停；可到「用量」頁調高上限。`;
  else if (daily === "warning") message = `今日花費已達每日上限的 ${Math.floor((todayUsd / caps.dailyUsd!) * 100)}%（${usd(todayUsd)} / ${usd(caps.dailyUsd!)}）。`;
  else if (monthly === "warning") message = `本月花費已達每月上限的 ${Math.floor((monthUsd / caps.monthlyUsd!) * 100)}%（${usd(monthUsd)} / ${usd(caps.monthlyUsd!)}）。`;
  return { caps, todayUsd, monthUsd, daily, monthly, message };
}

export class SpendCapError extends Error {
  code = "spend_cap";
}

/** Throws SpendCapError when a cap is reached; returns the warning message (or null) otherwise. */
export async function assertSpendAllowed(database: Database): Promise<string | null> {
  const s = await spendStatus(database);
  if (s.daily === "blocked" || s.monthly === "blocked") throw new SpendCapError(s.message!);
  return s.message;
}

// ---------- aggregation ----------

const DAY = 86_400_000;

function parseDate(v: string | undefined): [number, number, number] | null {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const [y, m, d] = v.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d);
  return new Date(t).toISOString().slice(0, 10) === v ? [y, m, d] : null;
}

export async function usageReport(database: Database, q: { from?: string; to?: string; timezone?: string }): Promise<UsageReport> {
  const tz = isValidTimezone(q.timezone) ? q.timezone : (await getSpendCaps(database)).timezone;
  const today = localDate(Date.now(), tz);
  const toD = parseDate(q.to) ?? parseDate(today)!;
  const fromD = parseDate(q.from) ?? (() => {
    const d = new Date(Date.UTC(toD[0], toD[1] - 1, toD[2]) - 29 * DAY);
    return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()] as [number, number, number];
  })();
  const fromWall = Date.UTC(fromD[0], fromD[1] - 1, fromD[2]);
  const toWall = Date.UTC(toD[0], toD[1] - 1, toD[2]) + DAY;
  if (toWall <= fromWall) throw new RangeError("結束日期必須晚於開始日期");
  if (toWall - fromWall > 400 * DAY) throw new RangeError("日期範圍最多 400 天");
  const start = new Date(zonedToUtc(fromWall, tz)).toISOString();
  const end = new Date(zonedToUtc(toWall, tz)).toISOString();

  const base = `WITH u AS (
      SELECT u.*, coalesce(u.conversation_id, r.conversation_id) AS conv_id
        FROM usage_logs u LEFT JOIN runs r ON r.id = u.run_id
       WHERE u.created_at >= $1 AND u.created_at < $2)
    SELECT %KEY% AS key, %LABEL% AS label, count(*)::int AS calls,
           coalesce(sum(u.input_tokens),0)::float8 AS input, coalesce(sum(u.output_tokens),0)::float8 AS output,
           coalesce(sum(u.cached_tokens),0)::float8 AS cached, coalesce(sum(u.reasoning_tokens),0)::float8 AS reasoning,
           coalesce(sum(u.cost_usd),0)::float8 AS cost,
           (count(*) FILTER (WHERE u.cost_usd IS NULL AND u.kind = 'chat'))::int AS unpriced
      FROM u LEFT JOIN conversations cv ON cv.id = u.conv_id
             LEFT JOIN projects pj ON pj.id = cv.project_id
             LEFT JOIN providers pv ON pv.id = u.provider_id
     GROUP BY 1, 2 ORDER BY %ORDER% LIMIT %LIMIT%`;
  type R = { key: string | null; label: string | null; calls: number; input: number; output: number; cached: number; reasoning: number; cost: number; unpriced: number };
  const run = (key: string, label: string, order = "cost DESC, calls DESC", limit = 100, params: unknown[] = []) =>
    database.query<R>(base.replace("%KEY%", key).replace("%LABEL%", label).replace("%ORDER%", order).replace("%LIMIT%", String(limit)), [start, end, ...params]);
  const row = (r: R): UsageRow => ({
    key: r.key ?? "", label: r.label ?? "", calls: Number(r.calls), inputTokens: Number(r.input), outputTokens: Number(r.output),
    cachedTokens: Number(r.cached), reasoningTokens: Number(r.reasoning), costUsd: Number(r.cost),
  });

  const [daily, byModel, byKind, byConv, byProject, total] = await Promise.all([
    run("to_char(u.created_at AT TIME ZONE $3, 'YYYY-MM-DD')", "''", "1 ASC", 500, [tz]),
    run("coalesce(u.model_id::text, u.kind || ':' || coalesce(u.model, ''))", "coalesce(pv.name || ' / ', '') || coalesce(u.model, u.kind)"),
    run("u.kind", "u.kind"),
    run("coalesce(u.conv_id::text, '')", "coalesce(cv.title, CASE WHEN u.conv_id IS NULL THEN '（不屬於對話）' ELSE '（已刪除的對話）' END)", "cost DESC, calls DESC", 50),
    run("coalesce(cv.project_id::text, '')", "coalesce(pj.name, '（無專案）')"),
    run("'total'", "'total'"),
  ]);
  // fill empty days so the chart has a continuous axis
  const byDate = new Map(daily.map((d) => [d.key!, row(d)]));
  const days: UsageReport["daily"] = [];
  for (let w = fromWall; w < toWall; w += DAY) {
    const date = new Date(w).toISOString().slice(0, 10);
    days.push({ ...(byDate.get(date) ?? row({ key: date, label: "", calls: 0, input: 0, output: 0, cached: 0, reasoning: 0, cost: 0, unpriced: 0 })), key: date, label: date, date });
  }
  const totals = total[0] ? row(total[0]) : row({ key: "total", label: "total", calls: 0, input: 0, output: 0, cached: 0, reasoning: 0, cost: 0, unpriced: 0 });
  return {
    from: new Date(fromWall).toISOString().slice(0, 10), to: new Date(toWall - DAY).toISOString().slice(0, 10), timezone: tz,
    totals, daily: days, byModel: byModel.map(row), byKind: byKind.map(row), byConversation: byConv.map(row), byProject: byProject.map(row),
    unpricedCalls: Number(total[0]?.unpriced ?? 0),
  };
}
