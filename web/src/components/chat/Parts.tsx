import { lazy, Suspense, useState } from "react";
import { AlertTriangle, Brain, Check, ChevronDown, ChevronRight, CircleHelp, CirclePause, CircleSlash, FileText, Loader2, Play, ShieldAlert, Wrench, X } from "lucide-react";
import { RISK_LABELS, type ClientToolArgs, type PendingApprovalDTO, type RiskLevel, type ApprovalDecision } from "@edgemind/shared";
import { cancelClientTool, clientToolStarted, useClientStatus, type ClientPhase } from "@/lib/clientTools";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const MarkdownLazy = lazy(() => import("./Markdown"));

export function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <Suspense fallback={<div className="whitespace-pre-wrap leading-relaxed">{text}</div>}>
      <MarkdownLazy text={text} streaming={streaming} />
    </Suspense>
  );
}

export function Reasoning({ text, redacted, live }: { text: string; redacted?: boolean; live?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-2 rounded-lg border bg-muted/30 text-sm">
      <button className="flex w-full items-center gap-2 px-3 py-1.5 text-muted-foreground hover:text-foreground" onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        <Brain className="h-4 w-4" />
        <span>{live ? "思考中…" : redacted ? "思考過程（已加密）" : "思考過程"}</span>
        {live && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
      </button>
      {open && <div className="whitespace-pre-wrap border-t px-3 py-2 text-muted-foreground">{text || (redacted ? "供應商未提供可讀的內容。" : "")}</div>}
    </div>
  );
}

const RISK_STYLE: Record<RiskLevel, string> = {
  read: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-transparent",
  write: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-transparent",
  dangerous: "bg-red-500/15 text-red-700 dark:text-red-400 border-transparent",
  external: "bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-400 border-transparent",
};

export function RiskBadge({ risk }: { risk: RiskLevel | "unknown" | undefined }) {
  if (!risk || risk === "unknown") return <Badge variant="outline">未知</Badge>;
  return <Badge className={RISK_STYLE[risk]}>{RISK_LABELS[risk]}</Badge>;
}

export function pretty(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/** "", null, {} or [] — rendered as an explicit note instead of an empty box. */
export function isEmptyResult(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return !v.trim();
  if (Array.isArray(v)) return v.length === 0;
  return typeof v === "object" && Object.keys(v as object).length === 0;
}

/**
 * running     = the run is live (streaming / polling) and this call has no result yet
 * waiting     = paused on this call (approval, ask_user question, or browser-side execution)
 * paused      = the run stopped between segments / was interrupted and can be continued
 * interrupted = no result and no live run will produce one (stopped, failed, connection cut)
 */
export type ToolState = "streaming" | "running" | "waiting" | "paused" | "interrupted" | "done" | "error";
export type WaitingKind = PendingApprovalDTO["kind"];

const WAITING_LABEL: Record<NonNullable<WaitingKind>, string> = { approval: "等待批准", question: "等待回答", client: "等待瀏覽器執行" };

export function ToolCard(props: { name: string; args: unknown; argsText?: string; result?: unknown; state: ToolState; risk?: RiskLevel | "unknown"; waitingKind?: WaitingKind }) {
  const [open, setOpen] = useState(false);
  const icon =
    props.state === "done" ? <Check className="h-4 w-4 text-emerald-600" /> :
    props.state === "error" ? <X className="h-4 w-4 text-destructive" /> :
    props.state === "waiting" ? <ShieldAlert className="h-4 w-4 text-amber-600" /> :
    props.state === "paused" ? <CirclePause className="h-4 w-4 text-amber-600" /> :
    props.state === "interrupted" ? <CircleSlash className="h-4 w-4 text-muted-foreground" /> :
    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;
  const label = {
    streaming: "產生參數中", running: "執行中", waiting: WAITING_LABEL[props.waitingKind ?? "approval"], paused: "已暫停",
    interrupted: "未完成（已中斷）", done: "完成", error: "錯誤",
  }[props.state];
  return (
    <div className="my-2 rounded-lg border text-sm" data-testid="tool-card" data-state={props.state}>
      <button className="flex w-full items-center gap-2 px-3 py-2 text-left" onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
        <Wrench className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="truncate font-mono text-[13px]">{props.name}</span>
        <RiskBadge risk={props.risk} />
        <span className="ml-auto flex shrink-0 items-center gap-1 text-xs text-muted-foreground">{icon}{label}</span>
      </button>
      {open && (
        <div className="space-y-2 border-t px-3 py-2">
          <div>
            <div className="mb-1 text-xs font-medium text-muted-foreground">參數</div>
            <pre className="max-h-64 overflow-auto rounded bg-muted/50 p-2 text-xs">{props.argsText ?? pretty(props.args)}</pre>
          </div>
          {props.result !== undefined && (
            <div>
              <div className={cn("mb-1 text-xs font-medium", props.state === "error" ? "text-destructive" : "text-muted-foreground")}>結果</div>
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/50 p-2 text-xs">{isEmptyResult(props.result) ? <span className="text-muted-foreground">（工具沒有回傳任何內容）</span> : pretty(props.result)}</pre>
            </div>
          )}
          {props.state === "interrupted" && (
            <div className="text-xs text-muted-foreground">這個工具呼叫沒有結果：執行已中斷或停止。可以重新生成回覆，或直接繼續對話。</div>
          )}
          {props.state === "paused" && <div className="text-xs text-muted-foreground">執行已暫停，按下方的「繼續執行」即可接續。</div>}
        </div>
      )}
    </div>
  );
}

const PHASE_LABEL: Record<ClientPhase, string> = {
  fetching: "下載掛載的檔案…",
  loading: "載入 Python 環境（Pyodide，首次較久）…",
  packages: "安裝需要的套件…",
  running: "執行中…",
  collecting: "收集輸出與圖表…",
  uploading: "上傳產生的檔案…",
  sending: "回傳結果…",
  done: "完成",
  error: "失敗",
  cancelled: "已取消",
};

/** code_run python executing in this browser tab (Pyodide). */
function ClientToolCard({ a, onStart }: { a: PendingApprovalDTO; onStart?(force: boolean): void }) {
  const st = useClientStatus(a.toolCallId);
  const args = (a.args ?? {}) as Partial<ClientToolArgs>;
  // Not started in this tab (e.g. auto-start did not happen) → offer 執行; finished but still pending here → the result
  // could not be reported → offer 重新執行.
  const notStarted = !st && !clientToolStarted(a.toolCallId);
  const stuck = !!st && ["done", "error", "cancelled"].includes(st.phase);
  const active = !notStarted && !stuck;
  return (
    <div className="my-2 rounded-lg border border-sky-500/40 bg-sky-500/5 p-3 text-sm" data-testid="client-tool-card">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        {active ? <Loader2 className="h-4 w-4 animate-spin text-sky-600" /> : st?.phase === "done" ? <Check className="h-4 w-4 text-emerald-600" /> : <X className="h-4 w-4 text-destructive" />}
        <span className="font-medium">在瀏覽器執行 Python</span>
        <span className="text-xs text-muted-foreground">{st ? PHASE_LABEL[st.phase] : notStarted ? "尚未開始" : "準備中…"}</span>
        {!!args.mounts?.length && <span className="text-xs text-muted-foreground">掛載 {args.mounts.length} 個檔案</span>}
      </div>
      {st?.message && <div className="mb-2 text-xs text-destructive">{st.message}</div>}
      <pre className="mb-2 max-h-56 overflow-auto rounded bg-muted/60 p-2 text-xs">{args.code ?? ""}</pre>
      <div className="flex items-center gap-2">
        {notStarted && onStart && <Button size="sm" onClick={() => onStart(false)}><Play /> 執行</Button>}
        {stuck && onStart && <Button size="sm" variant="outline" onClick={() => onStart(true)}><Play /> 重新執行</Button>}
        {active && <Button size="sm" variant="outline" onClick={() => cancelClientTool(a.toolCallId)}>取消執行</Button>}
        <span className="text-xs text-muted-foreground">請保持此分頁開啟直到完成；逾時 {args.timeoutSec ?? 30} 秒（不含載入）。</span>
      </div>
    </div>
  );
}

export function ApprovalCard({ a, onDecide, onAnswer, onStartClient }: {
  a: PendingApprovalDTO;
  onDecide(decision: ApprovalDecision): Promise<void>;
  onAnswer?(answer: string): Promise<void>;
  /** Start (or force re-run) a browser-side item. */
  onStartClient?(force: boolean): void;
}) {
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState("");
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  if (a.kind === "client") return <ClientToolCard a={a} onStart={onStartClient} />;
  if (a.kind === "question") {
    const q = (a.args ?? {}) as { question?: string; choices?: string[] };
    return (
      <div className="my-2 rounded-lg border border-primary/40 bg-primary/5 p-3 text-sm">
        <div className="mb-2 flex items-center gap-2 font-medium"><CircleHelp className="h-4 w-4 text-primary" /> 助理想問你</div>
        <div className="mb-3 whitespace-pre-wrap">{q.question}</div>
        {Array.isArray(q.choices) && q.choices.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-2">
            {q.choices.map((ch) => (
              <Button key={ch} size="sm" variant="outline" disabled={busy} onClick={() => run(() => onAnswer!(ch))}>{ch}</Button>
            ))}
          </div>
        )}
        <div className="flex gap-2">
          <textarea value={answer} onChange={(e) => setAnswer(e.target.value)} rows={2} placeholder="輸入你的回答…"
            className="min-h-9 flex-1 resize-y rounded-md border bg-background px-3 py-1.5 text-sm" />
          <div className="flex flex-col gap-1">
            <Button size="sm" disabled={busy || !answer.trim()} onClick={() => run(() => onAnswer!(answer.trim()))}>回答</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => onDecide("deny"))}>略過</Button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="my-2 rounded-lg border border-amber-500/50 bg-amber-500/5 p-3 text-sm">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <AlertTriangle className="h-4 w-4 text-amber-600" />
        <span className="font-medium">需要你的批准</span>
        <span className="font-mono text-[13px]">{a.toolName}</span>
        <RiskBadge risk={a.risk} />
      </div>
      {a.reason && <div className="mb-2 text-xs text-muted-foreground">{a.reason}</div>}
      <pre className="mb-3 max-h-56 overflow-auto rounded bg-muted/60 p-2 text-xs">{pretty(a.args)}</pre>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy} onClick={() => run(() => onDecide("allow_once"))}>允許一次</Button>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => run(() => onDecide("allow_conversation"))}>本對話一律允許</Button>
        <Button size="sm" variant="outline" className="text-destructive" disabled={busy} onClick={() => run(() => onDecide("deny"))}>拒絕</Button>
      </div>
    </div>
  );
}

export function AttachmentChip({ name, mime, onRemove, uploading }: { name: string; mime: string; onRemove?(): void; uploading?: boolean }) {
  return (
    <span className="inline-flex max-w-56 items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1 text-xs">
      {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5 shrink-0" />}
      <span className="truncate" title={`${name}（${mime}）`}>{name}</span>
      {onRemove && <button onClick={onRemove} aria-label="移除附件" className="text-muted-foreground hover:text-foreground"><X className="h-3.5 w-3.5" /></button>}
    </span>
  );
}
