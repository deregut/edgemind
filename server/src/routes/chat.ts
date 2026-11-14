/**
 * Chat / run endpoints.
 *   POST /api/chat                       new message | regenerate | edit-and-branch | continue/resume (SSE or 202 background)
 *   GET  /api/runs/:id                   run state + pending approvals
 *   GET  /api/runs/:id/events?after=N    step log polling (background mode / reconnect)
 *   POST /api/runs/:id/stop
 *   POST /api/runs/:id/approvals         { toolCallId, decision: allow_once | allow_conversation | deny }
 *   GET  /api/conversations/:id/messages full message tree + active leaf
 *   POST /api/internal/runs/:id/drive    HMAC-signed background driver (Netlify background fn / CF waitUntil chain)
 */
import type { Hono } from "hono";
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import type { AgentEvent, ApprovalDecision, Part, RunStatus } from "@edgemind/shared";
import { TERMINAL_RUN_STATUSES } from "@edgemind/shared";
import type { AppDeps, Ctx, HonoEnv } from "../context";
import { runInBackground } from "../context";
import { auditLogs, conversations, messages, models, projects, providers, runSteps, runs, settings, toolApprovals } from "../db/schema";
import { BadInput } from "../lib/errors";
import { hmacHex, timingSafeEqual } from "../lib/crypto";
import { abortLocalRun, closeStoppedRun, driveRun, pendingApprovals, runSegment, type AgentEnv } from "../agent/loop";
import { appendStep, getRun, insertMessage, STALE_LEASE_MS, toMessageDTO, transition, type Checkpoint, type RunOptions } from "../agent/store";
import { builtinRegistry } from "../agent/tools";
import { fileStore } from "./files";
import { isPermissionMode } from "../agent/permissions";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

export const DEFAULT_MAX_STEPS = 25;
const DEFAULT_SEGMENT = { softMs: 50_000, hardMs: 57_000 };
const DEFAULT_BACKGROUND = { softMs: 13 * 60_000, hardMs: 14 * 60_000 + 30_000 };
const MAX_INLINE_BYTES = 15 * 1024 * 1024;

export const driveToken = (secret: string, runId: string) => hmacHex(secret, `drive:${runId}`);

function parseContent(v: unknown): Part[] {
  if (typeof v === "string") {
    if (!v.trim()) throw new BadInput("訊息不可為空");
    return [{ type: "text", text: v }];
  }
  if (!Array.isArray(v) || !v.length || v.length > 50) throw new BadInput("content 必須是字串或 1–50 個 parts");
  let bytes = 0;
  const parts = v.map((p: any): Part => {
    if (p?.type === "text" && typeof p.text === "string") return { type: "text", text: p.text };
    if (p?.type === "image" && typeof p.mime === "string" && /^image\//.test(p.mime) && (typeof p.data === "string" || typeof p.url === "string")) {
      bytes += p.data?.length ?? 0;
      return { type: "image", mime: p.mime, ...(p.data ? { data: p.data } : { url: String(p.url) }) };
    }
    if (p?.type === "file" && typeof p.name === "string" && typeof p.mime === "string") {
      bytes += (p.data?.length ?? 0) + (p.text?.length ?? 0);
      return {
        type: "file", name: p.name.slice(0, 300), mime: p.mime,
        ...(isUuid(p.fileId) ? { fileId: p.fileId } : {}),
        ...(typeof p.data === "string" ? { data: p.data } : {}),
        ...(typeof p.text === "string" ? { text: p.text } : {}),
      };
    }
    throw new BadInput("不支援的訊息內容類型");
  });
  if (bytes > MAX_INLINE_BYTES) throw new BadInput("附件過大，請改用檔案上傳");
  if (!parts.some((p) => (p.type === "text" ? p.text.trim() : true))) throw new BadInput("訊息不可為空");
  return parts;
}

function parseOptions(v: any): RunOptions | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o: RunOptions = {};
  if (v.reasoning && typeof v.reasoning === "object") {
    const effort = ["minimal", "low", "medium", "high"].includes(v.reasoning.effort) ? v.reasoning.effort : undefined;
    const budget = Number.isInteger(v.reasoning.budgetTokens) && v.reasoning.budgetTokens > 0 ? v.reasoning.budgetTokens : undefined;
    o.reasoning = { ...(effort ? { effort } : {}), ...(budget ? { budgetTokens: budget } : {}) };
  }
  if (Number.isInteger(v.maxTokens) && v.maxTokens > 0 && v.maxTokens <= 1_000_000) o.maxTokens = v.maxTokens;
  if (typeof v.temperature === "number" && v.temperature >= 0 && v.temperature <= 2) o.temperature = v.temperature;
  return o;
}

/** SSE response driven by `work(emit)`; the work keeps running (waitUntil) even if the client disconnects. */
function sse(c: Ctx, work: (emit: (e: AgentEvent) => void) => Promise<unknown>): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  let closed = false;
  const write = (s: string) => {
    if (closed) return;
    writer.write(enc.encode(s)).catch(() => {
      closed = true;
    });
  };
  const emit = (e: AgentEvent) => write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  const ka = setInterval(() => write(": keep-alive\n\n"), 15_000);
  const p = (async () => {
    try {
      await work(emit);
    } catch (e) {
      emit({ type: "error", error: { message: (e as Error).message, code: "internal" } });
    } finally {
      clearInterval(ka);
      closed = true;
      await writer.close().catch(() => {});
    }
  })();
  runInBackground(c, p);
  return new Response(readable, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" },
  });
}

async function lastSeq(c: Ctx, runId: string): Promise<number> {
  const [r] = await c.get("database").db.select({ n: sql<number>`coalesce(max(${runSteps.seq}), 0)::int` }).from(runSteps).where(eq(runSteps.runId, runId));
  return Number(r?.n ?? 0);
}

export function mountChat(app: Hono<HonoEnv>, deps: AppDeps) {
  const registry = deps.tools ?? builtinRegistry();
  const segmentBudget = deps.platform?.segment ?? DEFAULT_SEGMENT;
  const backgroundBudget = deps.platform?.background ?? DEFAULT_BACKGROUND;

  const agentEnv = (c: Ctx): AgentEnv => ({
    database: c.get("database"),
    encKey: c.get("encKey"),
    registry,
    fetch: deps.fetch,
    storage: fileStore(c, deps),
    ...deps.agent,
  });

  /** Kick off background execution of a run (platform-specific). */
  async function startBackground(c: Ctx, runId: string) {
    const origin = new URL(c.req.url).origin;
    const token = await driveToken(c.get("env").JWT_SECRET, runId);
    if (deps.platform?.startBackground) return deps.platform.startBackground({ origin, runId, token, c });
    // Default (Node / tests): in-process, chained until the run leaves `paused`.
    const env = agentEnv(c);
    runInBackground(
      c,
      (async () => {
        for (let i = 0; i < 1000; i++) {
          const o = await driveRun(env, runId, backgroundBudget);
          if (o.status !== "paused" || o.reason === "busy") return;
        }
      })(),
    );
  }

  async function pickModel(c: Ctx, explicit: unknown, conv?: { modelId: string | null; projectId: string | null }): Promise<string> {
    const db = c.get("database").db;
    if (explicit !== undefined && explicit !== null) {
      if (!isUuid(explicit)) throw new BadInput("modelId 格式錯誤");
      const [m] = await db.select({ id: models.id }).from(models).where(eq(models.id, explicit)).limit(1);
      if (!m) throw new BadInput("找不到指定的模型");
      return m.id;
    }
    if (conv?.modelId) return conv.modelId;
    if (conv?.projectId) {
      const [p] = await db.select({ m: projects.defaultModelId }).from(projects).where(eq(projects.id, conv.projectId)).limit(1);
      if (p?.m) return p.m;
    }
    const [s] = await db.select().from(settings).where(eq(settings.key, "default_model_id")).limit(1);
    if (isUuid(s?.value)) return s.value;
    const [first] = await db
      .select({ id: models.id })
      .from(models)
      .innerJoin(providers, eq(providers.id, models.providerId))
      .where(and(eq(providers.type, "llm"), eq(providers.enabled, true), eq(models.enabled, true)))
      .orderBy(asc(providers.priority), asc(models.modelId))
      .limit(1);
    if (!first) throw new BadInput("尚未設定任何語言模型，請先到設定新增供應商與模型");
    return first.id;
  }

  async function maxStepsSetting(c: Ctx, requested: unknown): Promise<number> {
    if (Number.isInteger(requested) && (requested as number) >= 1 && (requested as number) <= 200) return requested as number;
    const [s] = await c.get("database").db.select().from(settings).where(eq(settings.key, "max_steps")).limit(1);
    return Number.isInteger(s?.value) && (s!.value as number) >= 1 ? (s!.value as number) : DEFAULT_MAX_STEPS;
  }

  /** Close idle runs of a conversation before a new turn so the branch never ends on unanswered tool calls. */
  async function settleOpenRuns(c: Ctx, conversationId: string) {
    const database = c.get("database");
    const open = await database.db.select().from(runs).where(and(eq(runs.conversationId, conversationId), inArray(runs.status, ["pending", "paused", "waiting_approval", "running", "stopping"])));
    for (const r of open) {
      const stale = Date.now() - r.updatedAt.getTime() > STALE_LEASE_MS;
      if (r.status === "running" || (r.status === "stopping" && !stale)) {
        return c.json({ error: "run_active", message: "這個對話還有執行中的任務，請先停止", runId: r.id }, 409);
      }
      if (await transition(database, r.id, [r.status as RunStatus], { status: "stopping" })) await closeStoppedRun(database, r);
    }
    return null;
  }

  app.post("/chat", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") throw new BadInput("請求格式錯誤");
    const database = c.get("database");
    const db = database.db;

    // ----- continue / resume an existing run -----
    if (body.runId !== undefined) {
      if (!isUuid(body.runId)) throw new BadInput("runId 格式錯誤");
      const run = await getRun(database, body.runId);
      if (!run) return c.json({ error: "not_found", message: "找不到執行紀錄" }, 404);
      if (run.mode === "background") {
        if (run.status === "paused" || run.status === "pending") await startBackground(c, run.id);
        return c.json({ runId: run.id, conversationId: run.conversationId, status: run.status }, 202);
      }
      const env = agentEnv(c);
      return sse(c, (emit) => runSegment(env, run.id, { ...segmentBudget, emit }));
    }

    // ----- new turn: new message, edit-and-branch, or regenerate -----
    const mode = body.mode === "background" ? "background" : "stream";
    let conversationId: string;
    let conv: typeof conversations.$inferSelect | undefined;
    if (body.conversationId !== undefined) {
      if (!isUuid(body.conversationId)) throw new BadInput("conversationId 格式錯誤");
      [conv] = await db.select().from(conversations).where(eq(conversations.id, body.conversationId)).limit(1);
      if (!conv) return c.json({ error: "not_found", message: "找不到對話" }, 404);
      conversationId = conv.id;
      const busy = await settleOpenRuns(c, conversationId);
      if (busy) return busy;
      [conv] = await db.select().from(conversations).where(eq(conversations.id, conversationId)).limit(1);
    } else {
      if (body.regenerate !== undefined) throw new BadInput("重新生成需要 conversationId");
      let projectId: string | null = null;
      if (body.projectId !== undefined && body.projectId !== null) {
        if (!isUuid(body.projectId)) throw new BadInput("projectId 格式錯誤");
        const [p] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, body.projectId)).limit(1);
        if (!p) throw new BadInput("找不到專案");
        projectId = p.id;
      }
      const firstText = typeof body.content === "string" ? body.content : Array.isArray(body.content) ? body.content.find((p: any) => p?.type === "text")?.text ?? "" : "";
      const permissionMode = body.permissionMode ?? null;
      if (permissionMode !== null && !isPermissionMode(permissionMode)) throw new BadInput("未知的權限模式");
      [conv] = await db.insert(conversations).values({ projectId, permissionMode, title: String(firstText).trim().slice(0, 50) || "新對話" }).returning();
      conversationId = conv.id;
    }

    const modelId = await pickModel(c, body.modelId, conv);
    let userMessageId: string;
    if (body.regenerate !== undefined) {
      if (!isUuid(body.regenerate)) throw new BadInput("regenerate 格式錯誤");
      const [m] = await db.select().from(messages).where(and(eq(messages.id, body.regenerate), eq(messages.conversationId, conversationId))).limit(1);
      if (!m || m.role !== "user") throw new BadInput("只能從使用者訊息重新生成");
      userMessageId = m.id;
      await db.update(conversations).set({ activeLeafId: m.id, updatedAt: new Date() }).where(eq(conversations.id, conversationId));
    } else {
      const parts = parseContent(body.content);
      let parentId: string | null = conv?.activeLeafId ?? null;
      if (body.parentId !== undefined) {
        // edit-and-branch: the new user message becomes a sibling of the edited one
        if (body.parentId === null) parentId = null;
        else {
          if (!isUuid(body.parentId)) throw new BadInput("parentId 格式錯誤");
          const [pm] = await db.select({ id: messages.id }).from(messages).where(and(eq(messages.id, body.parentId), eq(messages.conversationId, conversationId))).limit(1);
          if (!pm) throw new BadInput("找不到 parentId 指定的訊息");
          parentId = pm.id;
        }
      }
      const row = await insertMessage(database, { conversationId, parentId, role: "user", parts });
      userMessageId = row.id;
    }

    const checkpoint: Checkpoint = { leafId: userMessageId, options: parseOptions(body.options) };
    const [run] = await db
      .insert(runs)
      .values({ conversationId, userMessageId, status: "pending", mode, modelId, maxSteps: await maxStepsSetting(c, body.maxSteps), checkpoint })
      .returning();
    await db.update(messages).set({ runId: run.id }).where(and(eq(messages.id, userMessageId), eq(messages.role, "user")));

    if (mode === "background") {
      await startBackground(c, run.id);
      return c.json({ runId: run.id, conversationId, userMessageId, status: "pending" }, 202);
    }
    const env = agentEnv(c);
    return sse(c, (emit) => runSegment(env, run.id, { ...segmentBudget, emit }));
  });

  app.get("/runs/:id", async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) return c.json({ error: "not_found" }, 404);
    const run = await getRun(c.get("database"), id);
    if (!run) return c.json({ error: "not_found", message: "找不到執行紀錄" }, 404);
    const cp = run.checkpoint as Checkpoint | null;
    return c.json({
      id: run.id, conversationId: run.conversationId, userMessageId: run.userMessageId, status: run.status, mode: run.mode,
      stepCount: run.stepCount, maxSteps: run.maxSteps, error: run.error, finishReason: cp?.finishReason ?? null,
      createdAt: run.createdAt.toISOString(), updatedAt: run.updatedAt.toISOString(), finishedAt: run.finishedAt?.toISOString() ?? null,
      approvals: await pendingApprovals(c.get("database"), run.id, registry),
    });
  });

  app.get("/runs/:id/events", async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) return c.json({ error: "not_found" }, 404);
    const after = Math.max(0, Number(c.req.query("after") ?? 0) || 0);
    const run = await getRun(c.get("database"), id);
    if (!run) return c.json({ error: "not_found", message: "找不到執行紀錄" }, 404);
    const steps = await c.get("database").db.select().from(runSteps).where(and(eq(runSteps.runId, id), gt(runSteps.seq, after))).orderBy(asc(runSteps.seq)).limit(500);
    return c.json({
      status: run.status,
      stepCount: run.stepCount,
      steps: steps.map((s) => ({ seq: s.seq, kind: s.kind, payload: s.payload, createdAt: s.createdAt.toISOString() })),
      nextAfter: steps.length ? steps[steps.length - 1].seq : after,
    });
  });

  app.post("/runs/:id/stop", async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) return c.json({ error: "not_found" }, 404);
    const database = c.get("database");
    const run = await getRun(database, id);
    if (!run) return c.json({ error: "not_found", message: "找不到執行紀錄" }, 404);
    const status = run.status as RunStatus;
    if (TERMINAL_RUN_STATUSES.includes(status)) return c.json({ status });
    await database.db.insert(auditLogs).values({ action: "run_stop", runId: id, conversationId: run.conversationId, detail: { from: status } });
    if (status === "pending" || status === "paused" || status === "waiting_approval") {
      if (await transition(database, id, [status], { status: "stopping" })) {
        await closeStoppedRun(database, run);
        return c.json({ status: "stopped" });
      }
    }
    if (status === "stopping" && Date.now() - run.updatedAt.getTime() > STALE_LEASE_MS) {
      await closeStoppedRun(database, run);
      return c.json({ status: "stopped" });
    }
    await transition(database, id, ["running"], { status: "stopping" });
    abortLocalRun(id);
    const fresh = await getRun(database, id);
    return c.json({ status: fresh?.status ?? "stopping" });
  });

  /** Record a decision (approval or ask_user answer) and resume the run when nothing else is pending. */
  async function decide(c: Ctx, id: string, toolCallId: unknown, kind: "approval" | "question", decision: ApprovalDecision, answer?: string) {
    if (typeof toolCallId !== "string") throw new BadInput("缺少 toolCallId");
    const database = c.get("database");
    const db = database.db;
    const run = await getRun(database, id);
    if (!run) return c.json({ error: "not_found", message: "找不到執行紀錄" }, 404);
    const [appr] = await db.select().from(toolApprovals).where(and(eq(toolApprovals.runId, id), eq(toolApprovals.toolCallId, toolCallId))).limit(1);
    if (!appr) return c.json({ error: "not_found", message: kind === "question" ? "找不到待回答的問題" : "找不到待批准的工具呼叫" }, 404);
    if (appr.status !== "pending") return c.json({ error: "conflict", message: "此工具呼叫已經處理過" }, 409);
    if (appr.kind === "question" && kind === "approval" && decision !== "deny") throw new BadInput("這是提問，請用 /answers 回答（或拒絕以略過）");
    if (appr.kind !== "question" && kind === "question") throw new BadInput("這不是提問");
    const status = decision === "deny" ? "denied" : "approved";
    const scope = decision === "allow_conversation" ? "conversation" : "once";
    await db.update(toolApprovals).set({ status, scope, decidedAt: new Date(), ...(answer !== undefined ? { answer } : {}) }).where(eq(toolApprovals.id, appr.id));
    if (decision === "allow_conversation") {
      // other pending calls of the same tool in this run are covered too
      await db.update(toolApprovals).set({ status: "approved", scope: "conversation", decidedAt: new Date() })
        .where(and(eq(toolApprovals.runId, id), eq(toolApprovals.toolName, appr.toolName), eq(toolApprovals.status, "pending"), eq(toolApprovals.kind, "approval")));
    }
    await db.insert(auditLogs).values({ action: appr.kind === "question" ? "ask_user_answer" : "tool_approval", runId: id, conversationId: run.conversationId, toolName: appr.toolName, decision: status, detail: { toolCallId: appr.toolCallId, scope } });
    await appendStep(database, id, "approval", { approvalId: appr.id, toolCallId: appr.toolCallId, toolName: appr.toolName, status, scope, kind: appr.kind });
    const remaining = await pendingApprovals(database, id, registry);
    let runStatus = run.status as RunStatus;
    if (!remaining.length && run.status === "waiting_approval") {
      if (await transition(database, id, ["waiting_approval"], { status: "paused" })) runStatus = "paused";
      if (runStatus === "paused" && run.mode === "background") await startBackground(c, id);
    }
    return c.json({ status: runStatus, remaining, resume: runStatus === "paused" && run.mode !== "background" });
  }

  app.post("/runs/:id/approvals", async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    const decision = body?.decision as ApprovalDecision;
    if (!["allow_once", "allow_conversation", "deny"].includes(decision)) throw new BadInput("decision 必須是 allow_once、allow_conversation 或 deny");
    return decide(c, id, body?.toolCallId, "approval", decision);
  });

  /** ask_user answers. */
  app.post("/runs/:id/answers", async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    if (typeof body?.answer !== "string" || !body.answer.trim()) throw new BadInput("請輸入回答");
    if (body.answer.length > 20_000) throw new BadInput("回答過長");
    return decide(c, id, body?.toolCallId, "question", "allow_once", body.answer.trim());
  });

  app.get("/conversations/:id/messages", async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) return c.json({ error: "not_found" }, 404);
    const db = c.get("database").db;
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, id)).limit(1);
    if (!conv) return c.json({ error: "not_found", message: "找不到對話" }, 404);
    const rows = await db.select().from(messages).where(eq(messages.conversationId, id)).orderBy(asc(messages.createdAt));
    // Latest unfinished run (reload while running / waiting for approval / paused between segments).
    const [open] = await db.select().from(runs)
      .where(and(eq(runs.conversationId, id), inArray(runs.status, ["pending", "running", "paused", "waiting_approval", "stopping"])))
      .orderBy(desc(runs.createdAt)).limit(1);
    const activeRun = open
      ? { id: open.id, status: open.status, mode: open.mode, approvals: await pendingApprovals(c.get("database"), open.id, registry), lastSeq: await lastSeq(c, open.id) }
      : null;
    return c.json({
      conversation: { id: conv.id, title: conv.title, projectId: conv.projectId, activeLeafId: conv.activeLeafId, permissionMode: conv.permissionMode, modelId: conv.modelId },
      messages: rows.map(toMessageDTO),
      activeRun,
    });
  });

  // ----- internal: background driver (HMAC-signed, exempt from cookie auth/CSRF) -----
  app.post("/internal/runs/:id/drive", async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) return c.json({ error: "not_found" }, 404);
    const expected = await driveToken(c.get("env").JWT_SECRET, id);
    if (!timingSafeEqual(c.req.header("x-edgemind-drive") ?? "", expected)) return c.json({ error: "unauthorized" }, 401);
    const env = agentEnv(c);
    const work = async () => {
      const o = await driveRun(env, id, backgroundBudget);
      if (o.status === "paused" && o.reason !== "busy") await startBackground(c, id); // chain the next invocation
      return o;
    };
    if (deps.platform?.driveInline) return c.json(await work());
    runInBackground(c, work());
    return c.json({ accepted: true }, 202);
  });
}
