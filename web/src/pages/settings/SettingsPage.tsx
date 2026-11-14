import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Boxes, KeyRound, Loader2, MoreHorizontal, Pencil, PlugZap, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { PROVIDER_TYPES, PROVIDER_TYPE_LABELS, getKindSpec, type ProviderDTO, type ProviderType, type TestResult } from "@edgemind/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { SkillsSection } from "@/components/Skills";
import { McpSection } from "@/components/Mcp";
import { useSearchParams } from "react-router-dom";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { KnowledgeBase } from "@/components/KnowledgeBase";
import { ThemeToggle } from "@/components/ThemeToggle";
import { api } from "@/lib/api";
import { ProviderDialog } from "./ProviderDialog";
import { ModelsDialog } from "./ModelsDialog";
import { AgentSettingsSection } from "./AgentSettings";
import { StorageSection } from "./StorageSettings";

const TYPE_HELP: Record<ProviderType, string> = {
  llm: "支援 OpenAI 相容、Anthropic Messages、Gemini 三種協定，涵蓋 OpenRouter、DeepSeek、Groq、Mistral、xAI、Ollama 等。",
  search: "可設定多個搜尋服務，依優先順序作為備援：Tavily、Serper、SearXNG、Jina、Google PSE。",
  embedding: "知識庫與記憶使用的向量模型。測試連線會回報向量維度。",
  rerank: "（選用）知識庫檢索結果重排序。",
  image: "（選用）圖片生成。",
};

export function SettingsPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "providers";
  useEffect(() => {
    const o = params.get("oauth");
    if (!o) return;
    if (o === "ok") toast.success("MCP 授權完成");
    else toast.error(`MCP 授權失敗：${params.get("message") ?? "未知錯誤"}`);
    setParams({ tab: "mcp" }, { replace: true });
  }, [params, setParams]);
  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4 md:p-8">
      <h1 className="text-2xl font-semibold">設定</h1>
      <Tabs value={tab} onValueChange={(v) => setParams({ tab: v }, { replace: true })}>
        <TabsList>
          <TabsTrigger value="providers">供應商</TabsTrigger>
          <TabsTrigger value="agent">Agent 與權限</TabsTrigger>
          <TabsTrigger value="kb">知識庫</TabsTrigger>
          <TabsTrigger value="skills">Skills</TabsTrigger>
          <TabsTrigger value="mcp">MCP</TabsTrigger>
          <TabsTrigger value="storage">儲存空間</TabsTrigger>
          <TabsTrigger value="security">帳號安全</TabsTrigger>
          <TabsTrigger value="appearance">外觀</TabsTrigger>
        </TabsList>
        <TabsContent value="providers"><ProvidersSection /></TabsContent>
        <TabsContent value="agent"><AgentSettingsSection /></TabsContent>
        <TabsContent value="kb"><KnowledgeBase projectId={null} /></TabsContent>
        <TabsContent value="skills"><SkillsSection /></TabsContent>
        <TabsContent value="mcp"><McpSection /></TabsContent>
        <TabsContent value="storage"><StorageSection /></TabsContent>
        <TabsContent value="security"><SecuritySection /></TabsContent>
        <TabsContent value="appearance">
          <Card>
            <CardHeader><CardTitle>主題</CardTitle><CardDescription>選擇淺色、深色，或跟隨系統設定。</CardDescription></CardHeader>
            <CardContent><ThemeToggle /></CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ProvidersSection() {
  const [type, setType] = useState<ProviderType>("llm");
  const [items, setItems] = useState<ProviderDTO[] | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ProviderDTO | null>(null);
  const [modelsFor, setModelsFor] = useState<ProviderDTO | null>(null);
  const [testing, setTesting] = useState<string | null>(null);

  const load = useCallback(async () => {
    setItems(null);
    try {
      setItems(await api<ProviderDTO[]>(`/providers?type=${type}`));
    } catch (e) {
      toast.error((e as Error).message);
      setItems([]);
    }
  }, [type]);

  useEffect(() => { load(); }, [load]);

  async function toggle(p: ProviderDTO, enabled: boolean) {
    try {
      await api(`/providers/${p.id}`, { method: "PATCH", body: { enabled } });
      setItems((xs) => xs?.map((x) => (x.id === p.id ? { ...x, enabled } : x)) ?? null);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function test(p: ProviderDTO) {
    setTesting(p.id);
    try {
      const r = await api<TestResult>(`/providers/${p.id}/test`, { method: "POST", body: {} });
      (r.ok ? toast.success : toast.error)(`${p.name}：${r.message}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setTesting(null);
    }
  }

  async function remove(p: ProviderDTO) {
    if (!confirm(`確定要刪除「${p.name}」？已儲存的模型設定也會一併刪除。`)) return;
    try {
      await api(`/providers/${p.id}`, { method: "DELETE" });
      toast.success("已刪除");
      load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <div className="space-y-4">
      <Tabs value={type} onValueChange={(v) => setType(v as ProviderType)}>
        <TabsList>
          {PROVIDER_TYPES.map((t) => <TabsTrigger key={t} value={t}>{PROVIDER_TYPE_LABELS[t]}</TabsTrigger>)}
        </TabsList>
      </Tabs>
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-muted-foreground">{TYPE_HELP[type]}</p>
        <Button onClick={() => { setEditing(null); setDialogOpen(true); }}><Plus /> 新增</Button>
      </div>

      {items === null ? (
        <div className="flex justify-center p-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : items.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="p-8 text-center text-sm text-muted-foreground">尚未新增{PROVIDER_TYPE_LABELS[type]}供應商。</CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {items.map((p) => (
            <Card key={p.id} className={p.enabled ? "" : "opacity-60"}>
              <CardContent className="flex flex-wrap items-center gap-3 p-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{p.name}</span>
                    <Badge variant="secondary">{getKindSpec(p.type, p.kind)?.label ?? p.kind}</Badge>
                    <Badge variant="outline">優先 {p.priority}</Badge>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                    <span className="truncate">{p.baseUrl}</span>
                    <span className="flex items-center gap-1"><KeyRound className="h-3 w-3" />{p.hasApiKey ? p.apiKeyPreview : "無 Key"}</span>
                  </div>
                </div>
                <Button variant="outline" size="sm" onClick={() => test(p)} disabled={testing === p.id}>
                  {testing === p.id ? <Loader2 className="animate-spin" /> : <PlugZap />} 測試
                </Button>
                <Switch checked={p.enabled} onCheckedChange={(v) => toggle(p, v)} aria-label="啟用" />
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" aria-label="更多"><MoreHorizontal /></Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {(p.type === "llm" || p.type === "embedding" || p.type === "image" || p.type === "rerank") && (
                      <DropdownMenuItem onSelect={() => setModelsFor(p)}><Boxes /> 模型清單</DropdownMenuItem>
                    )}
                    <DropdownMenuItem onSelect={() => { setEditing(p); setDialogOpen(true); }}><Pencil /> 編輯</DropdownMenuItem>
                    <DropdownMenuItem className="text-destructive" onSelect={() => remove(p)}><Trash2 /> 刪除</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <ProviderDialog type={type} open={dialogOpen} onOpenChange={setDialogOpen} editing={editing} onSaved={load} />
      <ModelsDialog provider={modelsFor} onOpenChange={(o) => !o && setModelsFor(null)} />
    </div>
  );
}

function SecuritySection() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (next.length < 10) return toast.error("新密碼至少需要 10 個字元");
    if (next !== confirmPw) return toast.error("兩次輸入的新密碼不一致");
    setBusy(true);
    try {
      await api("/auth/password", { method: "POST", body: { currentPassword: current, newPassword: next } });
      toast.success("密碼已更新，其他裝置的登入已全部失效");
      setCurrent(""); setNext(""); setConfirmPw("");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader><CardTitle>變更密碼</CardTitle><CardDescription>變更後，除了目前這個瀏覽器，其他登入的裝置都會被登出。</CardDescription></CardHeader>
      <CardContent>
        <form onSubmit={submit} className="max-w-sm space-y-3">
          <div className="space-y-1.5"><Label htmlFor="cur">目前密碼</Label><Input id="cur" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} /></div>
          <div className="space-y-1.5"><Label htmlFor="new">新密碼</Label><Input id="new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></div>
          <div className="space-y-1.5"><Label htmlFor="new2">再次輸入新密碼</Label><Input id="new2" type="password" autoComplete="new-password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} /></div>
          <Button type="submit" disabled={busy || !current || !next}>{busy && <Loader2 className="animate-spin" />} 更新密碼</Button>
        </form>
      </CardContent>
    </Card>
  );
}
