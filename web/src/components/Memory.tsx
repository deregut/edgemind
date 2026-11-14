import { useCallback, useEffect, useState } from "react";
import { Brain, Check, Loader2, Pencil, Plus, RefreshCw, Search, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import type { MemoryDTO, MemoryScope, MemorySettingsDTO, ProviderDTO } from "@edgemind/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { ConfirmDialog } from "@/components/PromptDialog";
import { api } from "@/lib/api";
import { useWorkspace } from "@/lib/workspace";

const SCOPE_LABEL: Record<MemoryScope, string> = { global: "全域", project: "專案", conversation: "對話" };
const SOURCE_LABEL: Record<MemoryDTO["source"], string> = { tool: "模型儲存", auto: "自動萃取", user: "手動新增" };

/** Settings → 記憶: behaviour switches + the global memory list. */
export function MemorySection() {
  return (
    <div className="space-y-6">
      <MemorySettingsCard />
      <MemoryList projectId={null} />
    </div>
  );
}

function MemorySettingsCard() {
  const ws = useWorkspace();
  const [s, setS] = useState<MemorySettingsDTO | null>(null);
  const [embModels, setEmbModels] = useState<{ id: string; label: string }[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<MemorySettingsDTO>("/settings/memory").then(setS).catch((e) => toast.error((e as Error).message));
    (async () => {
      const provs = (await api<ProviderDTO[]>("/providers?type=embedding")).filter((p) => p.enabled);
      const out: { id: string; label: string }[] = [];
      for (const p of provs) for (const m of await api<{ id: string; modelId: string }[]>(`/providers/${p.id}/models`)) out.push({ id: m.id, label: `${p.name} · ${m.modelId}` });
      setEmbModels(out);
    })().catch(() => {});
  }, []);

  async function save(next: MemorySettingsDTO) {
    setS(next);
    try {
      setS(await api<MemorySettingsDTO>("/settings/memory", { method: "PUT", body: next }));
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function reembed() {
    setBusy(true);
    try {
      let total = 0;
      for (let i = 0; i < 100; i++) {
        const r = await api<{ done: number; remaining: number; model: string }>("/memories/reembed", { method: "POST" });
        total += r.done;
        if (!r.remaining || !r.done) break;
      }
      toast.success(`已重新向量化 ${total} 則記憶`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!s) return <Loader2 className="size-4 animate-spin text-muted-foreground" />;
  const c = s.compaction;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Brain className="size-4" /> 記憶與對話壓縮</CardTitle>
        <CardDescription>自動召回會在每個回合把最相關的記憶放進系統提示；自動萃取會在每次回覆後由輔助模型整理值得長期記住的事（會多一次模型呼叫）。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex items-center gap-3 text-sm"><Switch checked={s.autoRecall} onCheckedChange={(v) => save({ ...s, autoRecall: v })} /> 自動召回相關記憶</label>
          <label className="flex items-center gap-3 text-sm"><Switch checked={s.autoExtract} onCheckedChange={(v) => save({ ...s, autoExtract: v })} /> 自動萃取新記憶</label>
          <div className="space-y-1.5">
            <Label>每回合召回筆數</Label>
            <Input type="number" min={1} max={20} value={s.recallK} onChange={(e) => setS({ ...s, recallK: Number(e.target.value) })} onBlur={() => save(s)} />
          </div>
          <div className="space-y-1.5">
            <Label>相似度門檻（0–1，向量模式）</Label>
            <Input type="number" min={0} max={1} step={0.05} value={s.minScore} onChange={(e) => setS({ ...s, minScore: Number(e.target.value) })} onBlur={() => save(s)} />
          </div>
          <div className="space-y-1.5">
            <Label>輔助模型（萃取記憶、壓縮摘要）</Label>
            <NativeSelect value={s.helperModelId ?? ""} onChange={(e) => save({ ...s, helperModelId: e.target.value || null })}>
              <option value="">使用對話本身的模型</option>
              {ws.models.map((m) => <option key={m.id} value={m.id}>{m.providerName} · {m.displayName ?? m.modelId}</option>)}
            </NativeSelect>
          </div>
          <div className="space-y-1.5">
            <Label>記憶用的 Embedding 模型</Label>
            <div className="flex gap-2">
              <NativeSelect value={s.embeddingModelId ?? ""} onChange={(e) => save({ ...s, embeddingModelId: e.target.value || null })}>
                <option value="">第一個啟用的 Embedding 供應商</option>
                {embModels.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </NativeSelect>
              <Button variant="outline" size="icon" title="以目前的 Embedding 模型重新向量化舊記憶" disabled={busy} onClick={reembed}>
                {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              </Button>
            </div>
          </div>
        </div>
        <div className="space-y-3 rounded-md border p-3">
          <label className="flex items-center gap-3 text-sm font-medium"><Switch checked={c.enabled} onCheckedChange={(v) => save({ ...s, compaction: { ...c, enabled: v } })} /> 對話過長時自動壓縮</label>
          <p className="text-xs text-muted-foreground">提示詞超過模型上下文長度的門檻比例時，把較早的回合整理成摘要；原始訊息仍保留在歷史紀錄中，只是不再送給模型。</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label>觸發門檻（比例）</Label>
              <Input type="number" min={0.3} max={0.95} step={0.05} value={c.threshold} onChange={(e) => setS({ ...s, compaction: { ...c, threshold: Number(e.target.value) } })} onBlur={() => save(s)} />
            </div>
            <div className="space-y-1.5">
              <Label>保留最近（比例）</Label>
              <Input type="number" min={0.05} max={0.6} step={0.05} value={c.keepRecentRatio} onChange={(e) => setS({ ...s, compaction: { ...c, keepRecentRatio: Number(e.target.value) } })} onBlur={() => save(s)} />
            </div>
            <div className="space-y-1.5">
              <Label>預設上下文長度（token）</Label>
              <Input type="number" min={4000} step={1000} value={c.defaultContextTokens} onChange={(e) => setS({ ...s, compaction: { ...c, defaultContextTokens: Number(e.target.value) } })} onBlur={() => save(s)} />
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/** Memory list: global page (projectId = null → every scope, filterable) or one project's memories. */
export function MemoryList({ projectId }: { projectId: string | null }) {
  const [items, setItems] = useState<MemoryDTO[] | null>(null);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<"" | MemoryScope>(projectId ? "project" : "");
  const [source, setSource] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [newText, setNewText] = useState("");
  const [newScope, setNewScope] = useState<MemoryScope>(projectId ? "project" : "global");
  const [clearAll, setClearAll] = useState(false);
  const [limit, setLimit] = useState(50);

  const query = useCallback(() => {
    const p = new URLSearchParams({ limit: String(limit) });
    if (q.trim()) p.set("q", q.trim());
    if (scope) p.set("scope", scope);
    if (source) p.set("source", source);
    if (projectId) p.set("projectId", projectId);
    return p.toString();
  }, [q, scope, source, projectId, limit]);

  const load = useCallback(async () => {
    const r = await api<{ items: MemoryDTO[]; total: number }>(`/memories?${query()}`);
    setItems(r.items);
    setTotal(r.total);
  }, [query]);
  useEffect(() => {
    const t = setTimeout(() => load().catch((e) => toast.error((e as Error).message)), 200);
    return () => clearTimeout(t);
  }, [load]);

  async function add() {
    try {
      await api("/memories", { method: "POST", body: { content: newText, scope: newScope, ...(newScope === "project" ? { projectId } : {}) } });
      setNewText("");
      setAdding(false);
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function saveEdit(m: MemoryDTO) {
    try {
      await api(`/memories/${m.id}`, { method: "PATCH", body: { content: draft } });
      setEditing(null);
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{projectId ? "專案記憶" : "全部記憶"}</CardTitle>
        <CardDescription>{projectId ? "只在這個專案的對話中召回。全域記憶在「設定 → 記憶」管理。" : "全域記憶在所有對話召回；專案與對話記憶只在各自範圍內召回。"}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-48 flex-1">
            <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
            <Input className="pl-8" value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜尋記憶內容" />
          </div>
          {!projectId && (
            <NativeSelect className="w-auto" value={scope} onChange={(e) => setScope(e.target.value as "" | MemoryScope)}>
              <option value="">全部範圍</option>
              {(Object.keys(SCOPE_LABEL) as MemoryScope[]).map((k) => <option key={k} value={k}>{SCOPE_LABEL[k]}</option>)}
            </NativeSelect>
          )}
          <NativeSelect className="w-auto" value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">全部來源</option>
            {Object.entries(SOURCE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </NativeSelect>
          <Button size="sm" onClick={() => setAdding(!adding)}><Plus /> 新增</Button>
          {total > 0 && <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setClearAll(true)}><Trash2 /> 全部刪除</Button>}
        </div>

        {adding && (
          <div className="space-y-2 rounded-md border p-3">
            <textarea value={newText} onChange={(e) => setNewText(e.target.value)} rows={2} className="w-full rounded-md border bg-background px-3 py-2 text-sm" placeholder="例如：我習慣用 pnpm 而不是 npm" />
            <div className="flex items-center gap-2">
              {!projectId && (
                <NativeSelect className="w-auto" value={newScope} onChange={(e) => setNewScope(e.target.value as MemoryScope)}>
                  <option value="global">全域</option>
                </NativeSelect>
              )}
              {projectId && (
                <NativeSelect className="w-auto" value={newScope} onChange={(e) => setNewScope(e.target.value as MemoryScope)}>
                  <option value="project">本專案</option>
                  <option value="global">全域</option>
                </NativeSelect>
              )}
              <Button size="sm" disabled={!newText.trim()} onClick={add}>儲存</Button>
            </div>
          </div>
        )}

        {!items ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        ) : !items.length ? (
          <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">沒有符合的記憶。</p>
        ) : (
          <div className="divide-y rounded-md border">
            {items.map((m) => (
              <div key={m.id} className="flex items-start gap-3 p-3 text-sm">
                <div className="min-w-0 flex-1 space-y-1">
                  {editing === m.id ? (
                    <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} autoFocus className="w-full rounded-md border bg-background px-3 py-2 text-sm" />
                  ) : (
                    <p className="whitespace-pre-wrap break-words">{m.content}</p>
                  )}
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Badge variant="outline">{SCOPE_LABEL[m.scope]}</Badge>
                    <span>{SOURCE_LABEL[m.source]}</span>
                    <span>{new Date(m.updatedAt).toLocaleString("zh-TW")}</span>
                    {!m.embeddingModel && <span title="未向量化：只能用關鍵字找到">僅關鍵字</span>}
                  </div>
                </div>
                <div className="flex shrink-0 gap-1">
                  {editing === m.id ? (
                    <>
                      <Button size="icon" variant="ghost" title="儲存" disabled={!draft.trim()} onClick={() => saveEdit(m)}><Check /></Button>
                      <Button size="icon" variant="ghost" title="取消" onClick={() => setEditing(null)}><X /></Button>
                    </>
                  ) : (
                    <>
                      <Button size="icon" variant="ghost" title="編輯" onClick={() => { setEditing(m.id); setDraft(m.content); }}><Pencil /></Button>
                      <Button size="icon" variant="ghost" title="刪除" onClick={async () => { await api(`/memories/${m.id}`, { method: "DELETE" }); await load(); }}><Trash2 /></Button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        {items && total > items.length && <Button variant="ghost" size="sm" onClick={() => setLimit(limit + 50)}>顯示更多（共 {total} 則）</Button>}
      </CardContent>
      <ConfirmDialog open={clearAll} onOpenChange={setClearAll} title={projectId ? "刪除這個專案的全部記憶？" : scope ? `刪除全部「${SCOPE_LABEL[scope]}」記憶？` : "刪除全部記憶？"}
        description="此動作無法復原。" destructive confirmLabel="全部刪除"
        onConfirm={async () => {
          const r = await api<{ deleted: number }>("/memories/bulk-delete", { method: "POST", body: { all: true, ...(scope ? { scope } : {}), ...(projectId ? { projectId } : {}) } });
          toast.success(`已刪除 ${r.deleted} 則記憶`);
          setClearAll(false);
          await load();
        }} />
    </Card>
  );
}
