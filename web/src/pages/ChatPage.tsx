import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Download, FolderOpen, Loader2, Play, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import {
  PERMISSION_MODES, PERMISSION_MODE_LABELS,
  type AgentEvent, type ApprovalDecision, type Part, type PendingApprovalDTO, type PermissionMode, type StoredMessageDTO,
} from "@edgemind/shared";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Composer } from "@/components/chat/Composer";
import { AssistantTurn, UserMessage, type LiveState } from "@/components/chat/Messages";
import { api, ApiError } from "@/lib/api";
import { download, postChat } from "@/lib/stream";
import { latestLeaf, pathTo, toTurns } from "@/lib/tree";
import { modelLabel, useWorkspace } from "@/lib/workspace";
import { makeAttach } from "@/lib/attach";

interface ConvMeta {
  id: string;
  title: string | null;
  projectId: string | null;
  modelId: string | null;
  permissionMode: PermissionMode | null;
}

interface MessagesResponse {
  conversation: ConvMeta & { activeLeafId: string | null };
  messages: StoredMessageDTO[];
  activeRun: { id: string; status: string; mode: "stream" | "background"; approvals: PendingApprovalDTO[]; lastSeq: number } | null;
}

type Effort = "" | "low" | "medium" | "high";

const emptyLive = (runId: string | null, mode: LiveState["mode"]): LiveState => ({
  runId, mode, text: "", reasoning: "", reasoningOpen: false, calls: [], results: {}, approvals: [], status: "running",
});

export function ChatPage() {
  const { id: routeId } = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const ws = useWorkspace();

  const [convId, setConvId] = useState<string | null>(routeId ?? null);
  const [meta, setMeta] = useState<ConvMeta | null>(null);
  const [tree, setTree] = useState<Record<string, StoredMessageDTO>>({});
  const [leafId, setLeafId] = useState<string | null>(null);
  const [live, setLive] = useState<LiveState | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [pausedRun, setPausedRun] = useState<string | null>(null);
  const [background, setBackground] = useState(() => localStorage.getItem("em:background") === "1");
  const [effort, setEffort] = useState<Effort>("");
  const [draftModel, setDraftModel] = useState<string | null>(null);
  const [draftMode, setDraftMode] = useState<PermissionMode | null>(null);

  const ownNav = useRef<string | null>(null);
  const pollRef = useRef<{ runId: string; stop: boolean } | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const projectId = meta?.projectId ?? search.get("project");
  const project = ws.projects.find((p) => p.id === projectId) ?? null;
  const treeMap = useMemo(() => new Map(Object.entries(tree)), [tree]);
  const path = useMemo(() => pathTo(treeMap, leafId), [treeMap, leafId]);
  const turns = useMemo(() => toTurns(path), [path]);

  // effective model / permission mode
  const effectiveModelId = draftModel ?? meta?.modelId ?? project?.defaultModelId ?? ws.agentSettings?.defaultModelId ?? ws.models[0]?.id ?? null;
  const model = ws.models.find((m) => m.id === effectiveModelId);
  const convMode = meta ? meta.permissionMode : draftMode;

  const addMessage = useCallback((m: StoredMessageDTO) => {
    setTree((t) => ({ ...t, [m.id]: m }));
    setLeafId(m.id);
  }, []);

  // ---------------- loading ----------------

  const stopPolling = () => {
    if (pollRef.current) pollRef.current.stop = true;
    pollRef.current = null;
  };

  const load = useCallback(async (id: string) => {
    setLoading(true);
    try {
      const r = await api<MessagesResponse>(`/conversations/${id}/messages`);
      setMeta({ id: r.conversation.id, title: r.conversation.title, projectId: r.conversation.projectId, modelId: r.conversation.modelId, permissionMode: r.conversation.permissionMode });
      setTree(Object.fromEntries(r.messages.map((m) => [m.id, m])));
      setLeafId(r.conversation.activeLeafId);
      setPausedRun(null);
      const ar = r.activeRun;
      if (!ar) {
        setLive(null);
      } else if (ar.status === "waiting_approval") {
        setLive({ ...emptyLive(ar.id, ar.mode), approvals: ar.approvals, status: ar.status });
      } else if (ar.mode === "background" || ar.status === "running" || ar.status === "pending") {
        setLive(emptyLive(ar.id, ar.mode));
        startPolling(ar.id, ar.lastSeq);
      } else if (ar.status === "paused") {
        setLive(null);
        setPausedRun(ar.id);
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        toast.error("找不到對話");
        navigate("/");
      } else toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (routeId && ownNav.current === routeId) {
      ownNav.current = null;
      return;
    }
    stopPolling();
    setConvId(routeId ?? null);
    setDraftModel(null);
    setDraftMode(null);
    if (routeId) load(routeId);
    else {
      setMeta(null);
      setTree({});
      setLeafId(null);
      setLive(null);
      setBusy(false);
      setPausedRun(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeId]);

  useEffect(() => () => stopPolling(), []);

  // auto-scroll while streaming (unless the user scrolled up)
  useEffect(() => {
    if (stickToBottom.current) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [tree, live]);

  // ---------------- run lifecycle ----------------

  const finishRun = useCallback(async (id: string | null, status: string, wasNew: boolean) => {
    setBusy(false);
    if (status !== "waiting_approval") setLive((l) => (l && l.error ? { ...l, runId: null } : null));
    await ws.refreshConversations().catch(() => {});
    if (wasNew && id && status === "completed") {
      api(`/conversations/${id}/auto-title`, { method: "POST" })
        .then(() => ws.refreshConversations())
        .then(() => api<{ title: string }>(`/conversations/${id}`))
        .then((c) => setMeta((m) => (m ? { ...m, title: c.title } : m)))
        .catch(() => {});
    }
  }, [ws]);

  function handleEvent(e: AgentEvent, ctx: { pendingUser?: StoredMessageDTO; wasNew: boolean; flags: { cont: boolean; status: string } }) {
    switch (e.type) {
      case "run": {
        setLive((l) => ({ ...(l ?? emptyLive(e.runId, "stream")), runId: e.runId }));
        if (!convId) {
          setConvId(e.conversationId);
          ownNav.current = e.conversationId;
          navigate(`/c/${e.conversationId}`, { replace: true });
          setMeta({ id: e.conversationId, title: null, projectId: projectId ?? null, modelId: null, permissionMode: draftMode });
        }
        const pu = ctx.pendingUser;
        if (pu && e.userMessageId) {
          setTree((t) => {
            const n = { ...t };
            delete n[pu.id];
            n[e.userMessageId!] = { ...pu, id: e.userMessageId! };
            return n;
          });
          setLeafId(e.userMessageId);
          ctx.pendingUser = undefined;
        }
        break;
      }
      case "text-delta":
        setLive((l) => l && { ...l, text: l.text + e.text, reasoningOpen: false });
        break;
      case "reasoning-delta":
        setLive((l) => l && { ...l, reasoning: l.reasoning + e.text, reasoningOpen: true });
        break;
      case "reasoning-end":
        setLive((l) => l && { ...l, reasoningOpen: false });
        break;
      case "tool-call-start":
        setLive((l) => l && { ...l, calls: [...l.calls, { id: e.id, name: e.name, argsText: "" }] });
        break;
      case "tool-call-delta":
        setLive((l) => l && { ...l, calls: l.calls.map((c) => (c.id === e.id ? { ...c, argsText: c.argsText + e.argsDelta } : c)) });
        break;
      case "tool-call-end":
        setLive((l) => l && { ...l, calls: l.calls.map((c) => (c.id === e.id ? { ...c, args: e.args, ended: true } : c)) });
        break;
      case "message":
        addMessage(e.message);
        setLive((l) => l && { ...l, text: "", reasoning: "", reasoningOpen: false, calls: [] });
        break;
      case "tool-result":
        setLive((l) => l && { ...l, results: { ...l.results, [e.callId]: { result: e.result, isError: e.isError } } });
        break;
      case "approval-required":
        setLive((l) => l && { ...l, approvals: [...l.approvals.filter((a) => !e.approvals.some((b) => b.id === a.id)), ...e.approvals] });
        break;
      case "continue":
        ctx.flags.cont = true;
        break;
      case "done":
        ctx.flags.status = e.status;
        setLive((l) => l && { ...l, status: e.status });
        break;
      case "error":
        setLive((l) => l && { ...l, error: e.error.message });
        break;
    }
  }

  /** POST /api/chat, following `continue` segments until the run ends or waits for approval. */
  const runChat = useCallback(async (body: Record<string, unknown>, opts: { pendingUser?: StoredMessageDTO; wasNew?: boolean } = {}) => {
    setBusy(true);
    setPausedRun(null);
    setLive((l) => (l && l.approvals.length ? { ...l, error: undefined } : emptyLive(null, body.mode === "background" ? "background" : "stream")));
    const ctx = { pendingUser: opts.pendingUser, wasNew: !!opts.wasNew, flags: { cont: false, status: "" } };
    let currentConv = convId;
    try {
      let next: Record<string, unknown> | null = body;
      while (next) {
        ctx.flags = { cont: false, status: "" };
        let runId: string | null = null;
        const res = await postChat(next, (e) => {
          if (e.type === "run") {
            runId = e.runId;
            currentConv = e.conversationId;
          }
          handleEvent(e, ctx);
        });
        if (res.kind === "accepted") {
          const b = res.body;
          currentConv = b.conversationId;
          handleEvent({ type: "run", runId: b.runId, conversationId: b.conversationId, userMessageId: b.userMessageId ?? null, status: "pending" }, ctx);
          setLive((l) => ({ ...(l ?? emptyLive(b.runId, "background")), runId: b.runId, mode: "background" }));
          startPolling(b.runId, 0, ctx.wasNew);
          return;
        }
        next = ctx.flags.cont && runId ? { runId, action: "continue" } : null;
      }
      await finishRun(currentConv, ctx.flags.status || "completed", ctx.wasNew);
    } catch (e) {
      setBusy(false);
      if (ctx.pendingUser) setTree((t) => { const n = { ...t }; delete n[ctx.pendingUser!.id]; return n; });
      toast.error((e as Error).message);
      setLive(null);
      if (currentConv) load(currentConv);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convId, projectId, draftMode, finishRun]);

  /** Background mode / reload: poll the run's step log. */
  function startPolling(runId: string, after: number, wasNew = false) {
    stopPolling();
    const token = { runId, stop: false };
    pollRef.current = token;
    setBusy(true);
    let seq = after;
    let conv: string | null = null;
    const tick = async () => {
      if (token.stop) return;
      try {
        const r = await api<{ status: string; steps: { seq: number; kind: string; payload: any }[]; nextAfter: number }>(`/runs/${runId}/events?after=${seq}`);
        if (token.stop) return;
        let needApprovals = false;
        for (const s of r.steps) {
          if (s.kind === "message") {
            addMessage(s.payload.message);
            conv = s.payload.message.conversationId ?? conv;
            setLive((l) => l && { ...l, calls: [] });
          } else if (s.kind === "tool_result") {
            setLive((l) => l && { ...l, results: { ...l.results, [s.payload.callId]: { result: s.payload.result, isError: s.payload.isError } } });
          } else if (s.kind === "approval") needApprovals = true;
          else if (s.kind === "error") setLive((l) => l && { ...l, error: s.payload?.error?.message ?? s.payload?.message ?? "執行失敗" });
        }
        seq = r.nextAfter;
        if (needApprovals || r.status === "waiting_approval") {
          const run = await api<{ approvals: PendingApprovalDTO[] }>(`/runs/${runId}`);
          setLive((l) => l && { ...l, approvals: run.approvals });
        }
        if (["completed", "failed", "stopped"].includes(r.status)) {
          token.stop = true;
          pollRef.current = null;
          await finishRun(conv ?? convIdRef.current, r.status, wasNew);
          return;
        }
        if (r.status === "waiting_approval") {
          setBusy(false);
          setLive((l) => l && { ...l, status: r.status });
          token.stop = true;
          pollRef.current = null;
          return;
        }
      } catch {
        /* transient: retry */
      }
      setTimeout(tick, 1500);
    };
    tick();
  }

  const convIdRef = useRef(convId);
  convIdRef.current = convId;

  // ---------------- actions ----------------

  function send(parts: Part[]) {
    const wasNew = !convId;
    const pendingUser: StoredMessageDTO = { id: `pending-${Date.now()}`, parentId: leafId, role: "user", parts, runId: null, createdAt: new Date().toISOString() };
    addMessage(pendingUser);
    stickToBottom.current = true;
    runChat(
      {
        content: parts,
        ...(convId ? { conversationId: convId } : { projectId: projectId ?? undefined, permissionMode: draftMode ?? undefined }),
        ...(effectiveModelId ? { modelId: effectiveModelId } : {}),
        ...(background ? { mode: "background" } : {}),
        ...(effort ? { options: { reasoning: { effort } } } : {}),
      },
      { pendingUser, wasNew },
    );
  }

  function regenerate(userMsg: StoredMessageDTO) {
    setLeafId(userMsg.id);
    runChat({
      conversationId: convId, regenerate: userMsg.id,
      ...(effectiveModelId ? { modelId: effectiveModelId } : {}),
      ...(background ? { mode: "background" } : {}),
      ...(effort ? { options: { reasoning: { effort } } } : {}),
    });
  }

  function edit(userMsg: StoredMessageDTO, text: string) {
    const parts: Part[] = [{ type: "text", text }, ...userMsg.parts.filter((p) => p.type !== "text")];
    const pendingUser: StoredMessageDTO = { id: `pending-${Date.now()}`, parentId: userMsg.parentId, role: "user", parts, runId: null, createdAt: new Date().toISOString() };
    addMessage(pendingUser);
    runChat({
      conversationId: convId, content: parts, parentId: userMsg.parentId,
      ...(effectiveModelId ? { modelId: effectiveModelId } : {}),
      ...(background ? { mode: "background" } : {}),
    }, { pendingUser });
  }

  async function switchBranch(siblingId: string) {
    if (!convId) return;
    const leaf = latestLeaf(treeMap, siblingId);
    setLeafId(leaf);
    await api(`/conversations/${convId}/active-leaf`, { method: "PUT", body: { leafId: leaf } }).catch((e) => toast.error(e.message));
  }

  async function stop() {
    const runId = live?.runId;
    if (!runId) return;
    try {
      const r = await api<{ status: string }>(`/runs/${runId}/stop`, { method: "POST" });
      if (r.status === "stopped" && !pollRef.current) {
        setBusy(false);
        setLive(null);
        if (convId) load(convId);
      }
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function decide(a: PendingApprovalDTO, decision: ApprovalDecision, answer?: string) {
    const runId = live?.runId;
    if (!runId) return;
    try {
      const r = answer !== undefined
        ? await api<{ status: string; remaining: PendingApprovalDTO[]; resume: boolean }>(`/runs/${runId}/answers`, { method: "POST", body: { toolCallId: a.toolCallId, answer } })
        : await api<{ status: string; remaining: PendingApprovalDTO[]; resume: boolean }>(`/runs/${runId}/approvals`, { method: "POST", body: { toolCallId: a.toolCallId, decision } });
      setLive((l) => l && { ...l, approvals: r.remaining });
      if (r.resume) runChat({ runId, action: "continue" });
      else if (r.status === "paused" && live?.mode === "background") startPolling(runId, 0);
      else if (r.status === "paused" || r.status === "pending" || r.status === "running") startPolling(runId, 0);
    } catch (e) {
      toast.error((e as Error).message);
      if (convId) load(convId);
    }
  }

  async function changeModel(id: string) {
    setDraftModel(id);
    if (convId) await ws.patchConversation(convId, { modelId: id }).catch((e) => toast.error(e.message));
  }

  async function changeMode(v: string) {
    const mode = (v || null) as PermissionMode | null;
    if (!convId) return setDraftMode(mode);
    try {
      await api("/permissions/mode", { method: "PUT", body: { scope: "conversation", scopeId: convId, mode } });
      setMeta((m) => (m ? { ...m, permissionMode: mode } : m));
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function compactNow() {

    if (!convId) return;

    try {

      const r = await api<{ compacted: boolean; summarizedMessages?: number }>(`/conversations/${convId}/compact`, { method: "POST" });

      if (r.compacted) toast.success(`已把 ${r.summarizedMessages} 則較早的訊息整理成摘要，之後只會送摘要給模型`);

      else toast.message("對話還很短，不需要壓縮");

    } catch (e) {

      toast.error((e as Error).message);

    }

  }


  async function exportAs(format: "md" | "json") {
    if (!convId) return;
    const res = await fetch(`/api/conversations/${convId}/export?format=${format}`, { credentials: "same-origin" });
    if (!res.ok) return toast.error("匯出失敗");
    download(`${(meta?.title ?? "對話").replace(/[\\/:*?"<>|]/g, "_")}.${format}`, await res.blob());
  }

  const attach = useMemo(() => makeAttach(() => ({ conversationId: convIdRef.current, projectId: projectId ?? null })), [projectId]);

  // ---------------- render ----------------

  const groups = useMemo(() => {
    const g = new Map<string, typeof ws.models>();
    for (const m of ws.models) (g.get(m.providerName) ?? g.set(m.providerName, []).get(m.providerName)!).push(m);
    return [...g];
  }, [ws.models]);

  const showFullWarning = (convMode ?? project?.permissionMode) === "full";
  const caps = ws.agentSettings?.fullModeCaps;

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <div className="mr-auto flex min-w-0 items-center gap-2">
          {project && (
            <Link to={`/p/${project.id}`} className="flex shrink-0 items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
              <FolderOpen className="h-4 w-4" />{project.name} /
            </Link>
          )}
          <h1 className="truncate text-sm font-medium">{meta?.title ?? "新對話"}</h1>
        </div>
        <NativeSelect className="h-8 w-auto max-w-56 text-xs" value={effectiveModelId ?? ""} onChange={(e) => changeModel(e.target.value)} aria-label="模型">
          {!ws.models.length && <option value="">尚未設定模型</option>}
          {groups.map(([provider, ms]) => (
            <optgroup key={provider} label={provider}>
              {ms.map((m) => <option key={m.id} value={m.id}>{modelLabel(m)}</option>)}
            </optgroup>
          ))}
        </NativeSelect>
        {model?.capabilities?.reasoning && (
          <NativeSelect className="h-8 w-auto text-xs" value={effort} onChange={(e) => setEffort(e.target.value as Effort)} aria-label="思考強度">
            <option value="">思考：預設</option>
            <option value="low">思考：低</option>
            <option value="medium">思考：中</option>
            <option value="high">思考：高</option>
          </NativeSelect>
        )}
        <NativeSelect className="h-8 w-auto text-xs" value={convMode ?? ""} onChange={(e) => changeMode(e.target.value)} aria-label="權限模式">
          <option value="">權限：繼承{project?.permissionMode ? `（專案：${PERMISSION_MODE_LABELS[project.permissionMode]}）` : ""}</option>
          {PERMISSION_MODES.map((m) => <option key={m} value={m}>權限：{PERMISSION_MODE_LABELS[m]}</option>)}
        </NativeSelect>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground" title="背景執行：適合長任務，可關閉頁面後再回來查看">
          <Switch checked={background} onCheckedChange={(v) => { setBackground(v); localStorage.setItem("em:background", v ? "1" : "0"); }} />
          背景
        </label>
        {convId && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8" title="匯出" aria-label="匯出"><Download /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => exportAs("md")}>匯出 Markdown</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => exportAs("json")}>匯出 JSON</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => compactNow()}>壓縮較早的對話（摘要）</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </header>
      {showFullWarning && (
        <div className="flex items-center gap-2 border-b border-red-500/30 bg-red-500/10 px-4 py-1.5 text-xs text-red-700 dark:text-red-400">
          <ShieldAlert className="h-4 w-4" />
          全部權限：所有工具（含危險操作）都會自動執行。
          {caps && `上限：${caps.maxSteps ? `${caps.maxSteps} 步` : "步數不限"}、${caps.maxTokens ? `${caps.maxTokens.toLocaleString()} tokens` : "tokens 不限"}${caps.maxCostUsd ? `、US$${caps.maxCostUsd}` : ""}（可在設定調整）`}
        </div>
      )}

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto"
        onScroll={(e) => { const el = e.currentTarget; stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
        <div className="mx-auto max-w-3xl space-y-6 px-4 py-6">
          {loading && <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>}
          {!loading && !turns.length && !busy && (
            <div className="py-16 text-center">
              <h2 className="text-2xl font-semibold">{project ? project.name : "今天想做什麼？"}</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                {ws.models.length ? "輸入訊息開始對話；可附加圖片或檔案。" : <>尚未設定任何語言模型，請先到<Link to="/settings" className="text-primary underline">設定</Link>新增供應商與模型。</>}
              </p>
            </div>
          )}
          {turns.map((t, i) => (
            <div key={t.user?.id ?? `t${i}`} className="space-y-3">
              {t.user && <UserMessage tree={treeMap} msg={t.user} busy={busy} onEdit={(txt) => edit(t.user!, txt)} onSwitch={switchBranch} />}
              <AssistantTurn
                tree={treeMap} turn={t} live={live} isLast={i === turns.length - 1} busy={busy} tools={ws.tools}
                onRegenerate={() => t.user && regenerate(t.user)} onSwitch={switchBranch}
                onDecide={(a, d) => decide(a, d)} onAnswer={(a, ans) => decide(a, "allow_once", ans)}
              />
            </div>
          ))}
          {pausedRun && !busy && (
            <div className="flex items-center justify-center gap-3 rounded-lg border p-3 text-sm">
              這個任務在分段之間暫停了。
              <Button size="sm" onClick={() => runChat({ runId: pausedRun, action: "continue" })}><Play /> 繼續執行</Button>
            </div>
          )}
          {live?.mode === "background" && busy && (
            <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> 背景執行中，可以離開此頁，稍後回來查看結果。</div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      <div className="mx-auto w-full max-w-3xl px-4 pb-4">
        <Composer
          key={convId ?? "new"}
          autoFocus
          disabled={!ws.models.length || (!!live?.approvals.length && !busy)}
          running={busy && !!live?.runId}
          onSend={send}
          onStop={stop}
          attach={attach}
          placeholder={live?.approvals.length ? "請先處理上方的批准請求…" : undefined}
        />
      </div>
    </div>
  );
}
