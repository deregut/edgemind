/** Scheduled tasks (M11b) and usage dashboard DTOs. */

export type ScheduleType = "once" | "interval" | "daily" | "weekly" | "cron";

export interface ScheduleSpec {
  type: ScheduleType;
  /** once: local "YYYY-MM-DDTHH:MM" in `timezone`. */
  at?: string;
  /** interval: minutes between runs (≥5), anchored at `anchor` (ISO instant). */
  everyMinutes?: number;
  anchor?: string;
  /** daily / weekly: local "HH:MM". */
  time?: string;
  /** weekly: 0 = Sunday … 6 = Saturday. */
  weekdays?: number[];
  /** cron: 5-field expression (minute hour day month weekday). */
  cron?: string;
  /** IANA timezone, e.g. Asia/Taipei. */
  timezone: string;
}

export interface ScheduledTaskRunDTO {
  id: string;
  trigger: "schedule" | "manual";
  runId: string | null;
  conversationId: string | null;
  scheduledFor: string | null;
  createdAt: string;
  /** Status of the agent run (pending | running | waiting_approval | completed | failed | …) or "error" when it could not start. */
  status: string;
  error: string | null;
}

export interface ScheduledTaskDTO {
  id: string;
  name: string;
  prompt: string;
  projectId: string | null;
  modelId: string | null;
  permissionMode: string | null;
  schedule: ScheduleSpec;
  summary: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  lastConversationId: string | null;
  createdAt: string;
}

export interface CronSettingsDTO {
  /** Token for external dispatchers (cron-job.org, a Cloudflare cron Worker); null until generated. */
  token: string | null;
  /** Last time /api/cron/tick ran (any dispatcher). */
  lastTickAt: string | null;
  lastTickSource: string | null;
}

// ---------- usage ----------

export interface SpendCaps {
  /** USD; null = no limit. */
  dailyUsd: number | null;
  monthlyUsd: number | null;
  /** Warn at this fraction of a cap (default 0.8). */
  warnRatio: number;
  /** IANA timezone for "today" / "this month". */
  timezone: string;
}

export interface UsageRow {
  key: string;
  label: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  costUsd: number;
}

export interface UsageReport {
  from: string;
  to: string;
  timezone: string;
  totals: UsageRow;
  daily: (UsageRow & { date: string })[];
  byModel: UsageRow[];
  byKind: UsageRow[];
  byConversation: UsageRow[];
  byProject: UsageRow[];
  /** Calls whose model has no price set (cost unknown). */
  unpricedCalls: number;
}

export interface SpendStatus {
  caps: SpendCaps;
  todayUsd: number;
  monthUsd: number;
  /** "ok" | "warning" | "blocked" per cap. */
  daily: "ok" | "warning" | "blocked";
  monthly: "ok" | "warning" | "blocked";
  message: string | null;
}
