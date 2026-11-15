import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { CalendarClock, Copy, History, Loader2, Pencil, Play, Plus, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  PERMISSION_MODES, PERMISSION_MODE_LABELS,
  type CronSettingsDTO, type ScheduleSpec, type ScheduledTaskDTO, type ScheduledTaskRunDTO, type ScheduleType,
} from "@edgemind/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { modelLabel, useWorkspace } from "@/lib/workspace";

const STATUS: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  pending: { label: "等待中", variant: "secondary" },
  running: { label: "執行中", variant: "default" },
  paused: { label: "執行中", variant: "default" },
  waiting_approval: { label: "等待批准", variant: "outline" },
  stopping: { label: "停止中", variant: "secondary" },
  completed: { label: "完成", variant: "secondary" },
  failed: { label: "失敗", variant: "destructive" },
  stopped: { label: "已停止", variant: "secondary" },
  error: { label: "無法啟動", variant: "destructive" },
};
const StatusBadge = ({ s }: { s: string | null }) => (s ? <Badge variant={STATUS[s]?.variant ?? "secondary"}>{STATUS[s]?.label ?? s}</Badge> : null);
const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("zh-TW", { hour12: false }) : "—");
const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
const localTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export function SchedulesPage() {
  const [tasks, setTasks] = useState<ScheduledTaskDTO[] | null>(null);
  const [editing, setEditing] = useState<ScheduledTaskDTO | null>(null);
  const [open, setOpen] = useState(false);
  const [historyOf, setHistoryOf] = useState<ScheduledTaskDTO | null>(null);
  const { projects } = useWorkspace();
  const load = () => api<{ tasks: ScheduledTaskDTO[] }>("/schedules").then((r) => setTasks(r.tasks)).catch((e) => toast.error(e.message));
  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, []);

  async function toggle(t: ScheduledTaskDTO, enabled: boolean) {
    try {
      await api(`/schedules/${t.id}`, { method: "PATCH", body: { enabled } });
      load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  async function runNow(t: ScheduledTaskDTO) {
    try {
      const r = await api<{ conversationId: string }>(`/schedules/${t.id}/run`, { method: "POST", body: {} });
      toast.success("已開始執行", { action: { label: "查看對話", onClick: () => (window.location.href = `/c/${r.conversationId}`) } });
      load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  async function remove(t: ScheduledTaskDTO) {
    if (!window.confirm(`刪除排程「${t.name}」？已產生的對話會保留。`)) return;
    try {
      await api(`/schedules/${t.id}`, { method: "DELETE" });
      load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 p-4 md:p-6">
      <div className="flex items-center justify-between gap-2">
        <h1 className="flex items-center gap-2 text-xl font-semibold"><CalendarClock className="h-5 w-5" /> 排程</h1>
        <Button size="sm" onClick={() => { setEditing(null); setOpen(true); }}><Plus /> 新增排程</Button>
      </div>
      <p className="text-sm text-muted-foreground">
        排程任務會在指定時間以背景模式開一個新對話執行提示詞。需要批准的工具（依任務的權限模式）會讓執行停在「等待批准」，到對話裡批准後繼續；
        想完全無人值守請用「全部權限」（受其步數／Token／花費上限保護）。
      </p>
      <Card>
        <CardContent className="p-0">
          {!tasks ? (
            <div className="p-6"><Loader2 className="h-4 w-4 animate-spin" /></div>
          ) : !tasks.length ? (
            <p className="p-6 text-sm text-muted-foreground">尚未建立排程。例如「每天 08:00 整理我關注主題的新聞」。</p>
          ) : (
            <ul className="divide-y">
              {tasks.map((t) => (
                <li key={t.id} className="flex flex-wrap items-center gap-3 p-4">
                  <Switch checked={t.enabled} onCheckedChange={(v) => toggle(t, v)} aria-label="啟用" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{t.name}</span>
                      {t.permissionMode && <Badge variant={t.permissionMode === "full" ? "destructive" : "outline"}>{PERMISSION_MODE_LABELS[t.permissionMode as keyof typeof PERMISSION_MODE_LABELS] ?? t.permissionMode}</Badge>}
                      {t.projectId && <Badge variant="secondary">{projects.find((p) => p.id === t.projectId)?.name ?? "專案"}</Badge>}
                    </div>
                    <div className="text-xs text-muted-foreground">{t.summary}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span>下次：{t.enabled ? fmt(t.nextRunAt) : "已停用"}</span>
                      <span>上次：{fmt(t.lastRunAt)}</span>
                      <StatusBadge s={t.lastStatus} />
                      {t.lastConversationId && <Link className="underline" to={`/c/${t.lastConversationId}`}>開啟對話</Link>}
                      {t.lastStatus === "error" && t.lastError && <span className="text-destructive">{t.lastError}</span>}
                    </div>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => runNow(t)}><Play /> 立即執行</Button>
                  <Button variant="ghost" size="icon" aria-label="執行紀錄" title="執行紀錄" onClick={() => setHistoryOf(t)}><History /></Button>
                  <Button variant="ghost" size="icon" aria-label="編輯" onClick={() => { setEditing(t); setOpen(true); }}><Pencil /></Button>
                  <Button variant="ghost" size="icon" aria-label="刪除" className="text-destructive" onClick={() => remove(t)}><Trash2 /></Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      <DispatcherCard />
      <TaskDialog open={open} onOpenChange={setOpen} editing={editing} onSaved={() => { setOpen(false); load(); }} />
      <HistoryDialog task={historyOf} onClose={() => setHistoryOf(null)} />
    </div>
  );
}

function TaskDialog({ open, onOpenChange, editing, onSaved }: { open: boolean; onOpenChange(v: boolean): void; editing: ScheduledTaskDTO | null; onSaved(): void }) {
  const { projects, models } = useWorkspace();
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [projectId, setProjectId] = useState("");
  const [modelId, setModelId] = useState("");
  const [mode, setMode] = useState("");
  const [spec, setSpec] = useState<ScheduleSpec>({ type: "daily", time: "08:00", timezone: localTz() });
  const [preview, setPreview] = useState<string[]>([]);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(editing?.name ?? "");
    setPrompt(editing?.prompt ?? "");
    setProjectId(editing?.projectId ?? "");
    setModelId(editing?.modelId ?? "");
    setMode(editing?.permissionMode ?? "");
    setSpec(editing?.schedule ?? { type: "daily", time: "08:00", timezone: localTz() });
  }, [open, editing]);

  const specKey = JSON.stringify(spec);
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      api<{ next: string[] }>("/schedules/preview", { method: "POST", body: { schedule: spec } })
        .then((r) => { setPreview(r.next); setPreviewErr(null); })
        .catch((e) => { setPreview([]); setPreviewErr(e.message); });
    }, 300);
    return () => clearTimeout(t);
  }, [specKey, open]);

  const setType = (type: ScheduleType) => {
    const tz = spec.timezone;
    const base: Record<ScheduleType, ScheduleSpec> = {
      once: { type, at: new Date(Date.now() + 3600_000 - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16), timezone: tz },
      interval: { type, everyMinutes: 60, timezone: tz },
      daily: { type, time: "08:00", timezone: tz },
      weekly: { type, time: "08:00", weekdays: [1], timezone: tz },
      cron: { type, cron: "0 9 * * 1-5", timezone: tz },
    };
    setSpec(base[type]);
  };
  const timezones = useMemo(() => {
    try {
      return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf("timeZone");
    } catch {
      return [];
    }
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const body = { name, prompt, projectId: projectId || null, modelId: modelId || null, permissionMode: mode || null, schedule: spec };
      if (editing) await api(`/schedules/${editing.id}`, { method: "PATCH", body });
      else await api("/schedules", { method: "POST", body });
      toast.success("已儲存");
      onSaved();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={submit} className="space-y-3">
          <DialogHeader>
            <DialogTitle>{editing ? "編輯排程" : "新增排程"}</DialogTitle>
            <DialogDescription>每次執行都會開一個新對話（標題「[排程] 名稱」）。</DialogDescription>
          </DialogHeader>
          <div className="space-y-1"><Label>名稱</Label><Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} /></div>
          <div className="space-y-1">
            <Label>提示詞</Label>
            <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} required rows={4} className="w-full rounded-md border bg-background px-3 py-2 text-sm" placeholder="例如：搜尋今天的 AI 新聞，整理成 5 點摘要" />
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <Label>專案</Label>
              <NativeSelect value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">（無）</option>
                {projects.filter((p) => !p.archived).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </NativeSelect>
            </div>
            <div className="space-y-1">
              <Label>模型</Label>
              <NativeSelect value={modelId} onChange={(e) => setModelId(e.target.value)}>
                <option value="">（預設）</option>
                {models.map((m) => <option key={m.id} value={m.id}>{modelLabel(m)}</option>)}
              </NativeSelect>
            </div>
            <div className="space-y-1">
              <Label>權限模式</Label>
              <NativeSelect value={mode} onChange={(e) => setMode(e.target.value)}>
                <option value="">（沿用專案／全域）</option>
                {PERMISSION_MODES.map((m) => <option key={m} value={m}>{PERMISSION_MODE_LABELS[m]}</option>)}
              </NativeSelect>
            </div>
          </div>
          {mode === "full" && <p className="rounded-md border border-destructive/50 p-2 text-xs text-destructive">全部權限：所有工具（含危險操作）都會在無人監看時自動執行。</p>}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>頻率</Label>
              <NativeSelect value={spec.type} onChange={(e) => setType(e.target.value as ScheduleType)}>
                <option value="once">單次</option>
                <option value="interval">固定間隔</option>
                <option value="daily">每天</option>
                <option value="weekly">每週</option>
                <option value="cron">cron 運算式</option>
              </NativeSelect>
            </div>
            <div className="space-y-1">
              <Label>時區</Label>
              <Input list="em-timezones" value={spec.timezone} onChange={(e) => setSpec({ ...spec, timezone: e.target.value })} />
              <datalist id="em-timezones">{timezones.map((z) => <option key={z} value={z} />)}</datalist>
            </div>
          </div>
          {spec.type === "once" && <div className="space-y-1"><Label>日期時間</Label><Input type="datetime-local" value={spec.at ?? ""} onChange={(e) => setSpec({ ...spec, at: e.target.value.slice(0, 16) })} /></div>}
          {spec.type === "interval" && <div className="space-y-1"><Label>每幾分鐘（至少 5）</Label><Input type="number" min={5} value={spec.everyMinutes ?? 60} onChange={(e) => setSpec({ ...spec, everyMinutes: Number(e.target.value) })} /></div>}
          {(spec.type === "daily" || spec.type === "weekly") && <div className="space-y-1"><Label>時間</Label><Input type="time" value={spec.time ?? ""} onChange={(e) => setSpec({ ...spec, time: e.target.value })} /></div>}
          {spec.type === "weekly" && (
            <div className="flex flex-wrap gap-1">
              {WEEKDAYS.map((d, i) => {
                const on = spec.weekdays?.includes(i);
                return (
                  <Button key={i} type="button" size="sm" variant={on ? "default" : "outline"}
                    onClick={() => setSpec({ ...spec, weekdays: on ? spec.weekdays!.filter((x) => x !== i) : [...(spec.weekdays ?? []), i].sort() })}>
                    {d}
                  </Button>
                );
              })}
            </div>
          )}
          {spec.type === "cron" && (
            <div className="space-y-1">
              <Label>cron（分 時 日 月 星期）</Label>
              <Input className="font-mono" value={spec.cron ?? ""} onChange={(e) => setSpec({ ...spec, cron: e.target.value })} />
              <p className="text-xs text-muted-foreground">例如 <code>0 9 * * 1-5</code>（平日 9 點）、<code>*/30 * * * *</code>、<code>@daily</code>。</p>
            </div>
          )}
          <div className="rounded-md bg-muted p-2 text-xs">
            {previewErr ? <span className="text-destructive">{previewErr}</span> : preview.length ? <>接下來：{preview.map(fmt).join("、")}</> : "（不會再執行）"}
            <div className="mt-1 text-muted-foreground">實際觸發時間取決於排程器的檢查頻率（Netlify 預設每 15 分鐘）。</div>
          </div>
          <DialogFooter><Button type="submit" disabled={busy}>{busy && <Loader2 className="animate-spin" />} 儲存</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function HistoryDialog({ task, onClose }: { task: ScheduledTaskDTO | null; onClose(): void }) {
  const [runs, setRuns] = useState<ScheduledTaskRunDTO[] | null>(null);
  useEffect(() => {
    setRuns(null);
    if (task) api<{ runs: ScheduledTaskRunDTO[] }>(`/schedules/${task.id}/runs`).then((r) => setRuns(r.runs)).catch((e) => toast.error(e.message));
  }, [task]);
  return (
    <Dialog open={!!task} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader><DialogTitle>執行紀錄：{task?.name}</DialogTitle></DialogHeader>
        {!runs ? <Loader2 className="h-4 w-4 animate-spin" /> : !runs.length ? <p className="text-sm text-muted-foreground">尚未執行過。</p> : (
          <ul className="divide-y text-sm">
            {runs.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2 py-2">
                <span className="tabular-nums">{fmt(r.createdAt)}</span>
                <Badge variant="outline">{r.trigger === "manual" ? "手動" : "排程"}</Badge>
                <StatusBadge s={r.status} />
                {r.conversationId && <Link className="text-xs underline" to={`/c/${r.conversationId}`} onClick={onClose}>開啟對話</Link>}
                {r.error && <span className="w-full text-xs text-destructive">{r.error}</span>}
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

function DispatcherCard() {
  const [s, setS] = useState<CronSettingsDTO | null>(null);
  const load = () => api<CronSettingsDTO>("/settings/cron").then(setS).catch((e) => toast.error(e.message));
  useEffect(() => {
    load();
  }, []);
  const url = `${window.location.origin}/api/cron/tick`;
  async function regen() {
    if (s?.token && !window.confirm("重新產生後，舊的 token 立即失效，外部排程器需要更新。繼續？")) return;
    try {
      await api("/settings/cron/token", { method: "POST", body: {} });
      load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  const copy = (t: string) => navigator.clipboard.writeText(t).then(() => toast.success("已複製"));
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">排程器（觸發來源）</CardTitle>
        <CardDescription>
          Netlify：內建排程函式每 15 分鐘自動觸發，不需設定。Cloudflare Pages：Pages Functions 沒有 cron，請用下方 token 搭配
          另一個免費的 Cloudflare Worker（cron trigger，見 <code>cron-worker/</code> 與部署說明）或 cron-job.org 等外部服務，
          以 <code>POST</code> 呼叫下列網址並帶上 <code>Authorization: Bearer &lt;token&gt;</code>。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div className="flex items-center gap-2"><code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1">{url}</code><Button size="icon" variant="ghost" aria-label="複製網址" onClick={() => copy(url)}><Copy /></Button></div>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1">{s?.token ?? "（尚未產生）"}</code>
          {s?.token && <Button size="icon" variant="ghost" aria-label="複製 token" onClick={() => copy(s.token!)}><Copy /></Button>}
          <Button size="sm" variant="outline" onClick={regen}><RefreshCw /> {s?.token ? "重新產生" : "產生 token"}</Button>
        </div>
        <p className="text-xs text-muted-foreground">最近一次觸發：{s?.lastTickAt ? `${fmt(s.lastTickAt)}（${s.lastTickSource}）` : "從未"}</p>
      </CardContent>
    </Card>
  );
}
