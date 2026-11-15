/**
 * Scheduled-task dispatcher core.
 *
 * tick(): claims due tasks with a short lease (one UPDATE … FOR UPDATE SKIP LOCKED statement, so concurrent ticks
 * never claim the same task), advances next_run_at BEFORE starting the run (guarded by the lease value, so a
 * crash can at worst skip one occurrence, never run it twice), then starts each as a background agent run in a
 * new conversation. Missed occurrences are not replayed: a task that was due while no dispatcher ran fires once,
 * and its next run is computed from "now".
 */
import { and, desc, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { runs, scheduledTaskRuns, scheduledTasks } from "../db/schema";
import { setSetting } from "../lib/settings";
import { nextRun, type ScheduleSpec } from "./cron";

export const CLAIM_LEASE_MS = 120_000;
export const MAX_PER_TICK = 20;

export type StartRun = (task: { id: string; name: string; prompt: string; projectId: string | null; modelId: string | null; permissionMode: string | null }) => Promise<{ runId: string; conversationId: string }>;

export interface TickResult {
  claimed: number;
  started: { taskId: string; runId: string; conversationId: string }[];
  failed: { taskId: string; error: string }[];
}

interface ClaimRow {
  id: string;
  name: string;
  prompt: string;
  project_id: string | null;
  model_id: string | null;
  permission_mode: string | null;
  schedule: ScheduleSpec;
  next_run_at: Date | string;
  lease_until: Date | string;
}

/** Record one execution (history row + last_* columns). */
export async function recordExecution(database: Database, taskId: string, trigger: "schedule" | "manual", scheduledFor: Date | null, r: { runId?: string; conversationId?: string; error?: string }) {
  await database.db.insert(scheduledTaskRuns).values({ taskId, trigger, scheduledFor, runId: r.runId ?? null, conversationId: r.conversationId ?? null, error: r.error ?? null });
  await database.db.update(scheduledTasks)
    .set({ lastRunAt: new Date(), lastRunId: r.runId ?? null, lastError: r.error ?? null, updatedAt: new Date() })
    .where(eq(scheduledTasks.id, taskId));
}

export async function tick(database: Database, startRun: StartRun, opts: { now?: Date; source?: string } = {}): Promise<TickResult> {
  const now = opts.now ?? new Date();
  const out: TickResult = { claimed: 0, started: [], failed: [] };
  await setSetting(database, "cron_last_tick", { at: now.toISOString(), source: opts.source ?? "unknown" }).catch(() => {});
  const claimed = await database.query<ClaimRow>(
    `UPDATE scheduled_tasks SET lease_until = $1::timestamptz + interval '${CLAIM_LEASE_MS / 1000} seconds'
      WHERE id IN (
        SELECT id FROM scheduled_tasks
         WHERE enabled AND next_run_at IS NOT NULL AND next_run_at <= $1::timestamptz
           AND (lease_until IS NULL OR lease_until < $1::timestamptz)
         ORDER BY next_run_at LIMIT ${MAX_PER_TICK}
         FOR UPDATE SKIP LOCKED)
      RETURNING id, name, prompt, project_id, model_id, permission_mode, schedule, next_run_at, lease_until`,
    [now.toISOString()],
  );
  out.claimed = claimed.length;
  for (const t of claimed) {
    const scheduledFor = new Date(t.next_run_at);
    let next: number | null = null;
    try {
      next = t.schedule.type === "once" ? null : nextRun(t.schedule, Math.max(now.getTime(), scheduledFor.getTime()));
    } catch {
      next = null;
    }
    // advance first, guarded by our lease (another dispatcher may have re-claimed after our lease expired)
    const advanced = await database.query<{ id: string }>(
      `UPDATE scheduled_tasks SET next_run_at = $2, enabled = enabled AND $3, lease_until = NULL, updated_at = now()
        WHERE id = $1 AND lease_until = $4::timestamptz RETURNING id`,
      [t.id, next === null ? null : new Date(next).toISOString(), next !== null, new Date(t.lease_until).toISOString()],
    );
    if (!advanced.length) continue;
    try {
      const r = await startRun({ id: t.id, name: t.name, prompt: t.prompt, projectId: t.project_id, modelId: t.model_id, permissionMode: t.permission_mode });
      await recordExecution(database, t.id, "schedule", scheduledFor, r);
      out.started.push({ taskId: t.id, ...r });
    } catch (e) {
      const error = (e as Error).message || String(e);
      await recordExecution(database, t.id, "schedule", scheduledFor, { error }).catch(() => {});
      out.failed.push({ taskId: t.id, error });
    }
  }
  return out;
}

/** Latest run status of a task (via its last run). */
export async function lastStatuses(database: Database, runIds: string[]): Promise<Map<string, { status: string; conversationId: string }>> {
  const m = new Map<string, { status: string; conversationId: string }>();
  if (!runIds.length) return m;
  const rows = await database.query<{ id: string; status: string; conversation_id: string }>(
    "SELECT id, status, conversation_id FROM runs WHERE id = ANY($1::uuid[])",
    [runIds],
  );
  for (const r of rows) m.set(r.id, { status: r.status, conversationId: r.conversation_id });
  return m;
}

export async function history(database: Database, taskId: string, limit = 50) {
  return database.db
    .select({ h: scheduledTaskRuns, status: runs.status, runError: runs.error })
    .from(scheduledTaskRuns)
    .leftJoin(runs, eq(runs.id, scheduledTaskRuns.runId))
    .where(and(eq(scheduledTaskRuns.taskId, taskId)))
    .orderBy(desc(scheduledTaskRuns.createdAt))
    .limit(limit);
}
