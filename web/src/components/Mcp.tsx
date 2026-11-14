import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, KeyRound, Loader2, LogOut, Pencil, Plug, Plus, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  RISK_LABELS, RISK_LEVELS, type McpAuthType, type McpServerDTO, type McpServerInput, type McpSyncResponse, type McpToolDTO, type McpTransportKind, type ProjectDTO, type RiskLevel,
} from "@edgemind/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { ConfirmDialog } from "@/components/PromptDialog";
import { RiskBadge } from "@/components/chat/Parts";
import { api } from "@/lib/api";
import { useWorkspace } from "@/lib/workspace";

const AUTH_LABEL: Record<McpAuthType, string> = { none: "無", bearer: "Bearer Token", headers: "自訂 Header", oauth: "OAuth 2.1" };
const STATUS: Record<McpServerDTO["authStatus"], { label: string; variant: "success" | "destructive" | "outline" | "secondary" }> = {
  none: { label: "不需授權", variant: "outline" },
  configured: { label: "已設定憑證", variant: "secondary" },
  needs_auth: { label: "需要授權", variant: "destructive" },
  authorized: { label: "已授權", variant: "success" },
};

async function startOAuth(id: string) {
  const r = await api<{ authorizeUrl: string }>(`/mcp/servers/${id}/oauth/start`, { method: "POST" });
  window.location.href = r.authorizeUrl;
}

/** Settings → MCP: remote MCP servers, auth, tool discovery, per-tool enable + risk level. */
export function McpSection() {
  const ws = useWorkspace();
  const [servers, setServers] = useState<McpServerDTO[] | null>(null);
  const [editing, setEditing] = useState<McpServerDTO | "new" | null>(null);
  const [deleting, setDeleting] = useState<McpServerDTO | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => setServers(await api<McpServerDTO[]>("/mcp/servers")), []);
  useEffect(() => {
    load().catch((e) => toast.error((e as Error).message));
  }, [load]);

  async function sync(s: McpServerDTO) {
    setBusy(s.id);
    try {
      const r = await api<McpSyncResponse>(`/mcp/servers/${s.id}/sync`, { method: "POST" });
      if (r.error) toast.error(r.needsAuth ? `需要授權：${r.error}` : r.error);
      else toast.success(`已同步 ${r.tools.length} 個工具${r.added ? `（新增 ${r.added}）` : ""}${r.removed ? `（移除 ${r.removed}）` : ""}`);
      await load();
      await ws.refreshMeta();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function patch(s: McpServerDTO, body: McpServerInput) {
    try {
      await api(`/mcp/servers/${s.id}`, { method: "PATCH", body });
      await load();
      await ws.refreshMeta();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Plug className="size-4" /> MCP 伺服器</CardTitle>
        <CardDescription>
          連接遠端 MCP 伺服器（Streamable HTTP 或舊版 SSE；Serverless 環境不支援 stdio）。工具會以 mcp__名稱__工具 提供給模型，並依風險等級套用權限模式。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Button size="sm" onClick={() => setEditing("new")}><Plus /> 新增 MCP 伺服器</Button>
        {!servers ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        ) : !servers.length ? (
          <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">還沒有 MCP 伺服器。</p>
        ) : (
          <div className="divide-y rounded-md border">
            {servers.map((s) => (
              <div key={s.id} className="p-3">
                <div className="flex items-start gap-3">
                  <Switch checked={s.enabled} onCheckedChange={(v) => patch(s, { enabled: v })} aria-label="啟用" />
                  <button className="min-w-0 flex-1 text-left" onClick={() => setOpen(open === s.id ? null : s.id)}>
                    <div className="flex flex-wrap items-center gap-2">
                      {open === s.id ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                      <span className="font-medium">{s.name}</span>
                      <Badge variant={STATUS[s.authStatus].variant}>{STATUS[s.authStatus].label}</Badge>
                      <span className="text-xs text-muted-foreground">{s.enabledToolCount}/{s.toolCount} 個工具啟用</span>
                    </div>
                    <div className="truncate pl-6 font-mono text-xs text-muted-foreground">{s.url} · {s.transport === "sse" ? "SSE" : "Streamable HTTP"} · mcp__{s.toolPrefix}__…</div>
                    {s.lastError && <div className="pl-6 text-xs text-destructive">{s.lastError}</div>}
                  </button>
                  <div className="flex shrink-0 gap-1">
                    {s.authType === "oauth" && (s.authStatus === "authorized" ? (
                      <Button size="icon" variant="ghost" title="登出（清除 token）" onClick={async () => { await api(`/mcp/servers/${s.id}/oauth/logout`, { method: "POST" }); await load(); }}><LogOut /></Button>
                    ) : (
                      <Button size="sm" variant="outline" onClick={() => startOAuth(s.id).catch((e) => toast.error((e as Error).message))}><KeyRound /> 授權</Button>
                    ))}
                    <Button size="icon" variant="ghost" title="同步工具" disabled={busy === s.id} onClick={() => sync(s)}>
                      {busy === s.id ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                    </Button>
                    <Button size="icon" variant="ghost" title="編輯" onClick={() => setEditing(s)}><Pencil /></Button>
                    <Button size="icon" variant="ghost" title="刪除" onClick={() => setDeleting(s)}><Trash2 /></Button>
                  </div>
                </div>
                {open === s.id && <ServerTools server={s} onChanged={() => { load(); ws.refreshMeta(); }} />}
              </div>
            ))}
          </div>
        )}
      </CardContent>
      {editing && <ServerDialog server={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={async () => { await load(); await ws.refreshMeta(); }} />}
      <ConfirmDialog open={!!deleting} onOpenChange={(v) => !v && setDeleting(null)} title={`刪除 MCP 伺服器「${deleting?.name}」？`}
        description="會刪除它的工具設定與已儲存的憑證。" destructive confirmLabel="刪除"
        onConfirm={async () => {
          await api(`/mcp/servers/${deleting!.id}`, { method: "DELETE" });
          setDeleting(null);
          await load();
          await ws.refreshMeta();
        }} />
    </Card>
  );
}

function ServerTools({ server, onChanged }: { server: McpServerDTO; onChanged(): void }) {
  const [tools, setTools] = useState<McpToolDTO[] | null>(null);
  const [show, setShow] = useState<string | null>(null);
  useEffect(() => {
    api<McpToolDTO[]>(`/mcp/servers/${server.id}/tools`).then(setTools).catch((e) => toast.error((e as Error).message));
  }, [server.id, server.lastSyncedAt]);

  async function patch(t: McpToolDTO, body: { enabled?: boolean; riskLevel?: RiskLevel }) {
    try {
      const r = await api<McpToolDTO>(`/mcp/tools/${t.id}`, { method: "PATCH", body });
      setTools((ts) => ts?.map((x) => (x.id === r.id ? r : x)) ?? null);
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  if (!tools) return <Loader2 className="ml-6 mt-2 size-4 animate-spin text-muted-foreground" />;
  return (
    <div className="mt-3 space-y-2 pl-6">
      {server.instructions && <p className="whitespace-pre-wrap rounded bg-muted/50 p-2 text-xs text-muted-foreground">{server.instructions}</p>}
      {!tools.length ? (
        <p className="text-xs text-muted-foreground">沒有工具。{server.authStatus === "needs_auth" ? "請先完成授權再同步。" : "按右上角的同步取得工具清單。"}</p>
      ) : (
        <>
          <div className="flex gap-2 text-xs">
            <Button size="sm" variant="ghost" onClick={async () => { for (const t of tools) if (!t.enabled) await patch(t, { enabled: true }); }}>全部啟用</Button>
            <Button size="sm" variant="ghost" onClick={async () => { for (const t of tools) if (t.enabled) await patch(t, { enabled: false }); }}>全部停用</Button>
          </div>
          <div className="divide-y rounded-md border">
            {tools.map((t) => (
              <div key={t.id} className="flex items-start gap-3 p-2 text-sm">
                <input type="checkbox" className="mt-1" checked={t.enabled} onChange={(e) => patch(t, { enabled: e.target.checked })} />
                <div className="min-w-0 flex-1">
                  <button className="flex items-center gap-2 text-left" onClick={() => setShow(show === t.id ? null : t.id)}>
                    <span className="font-mono text-[13px]">{t.name}</span>
                    {t.title && t.title !== t.name && <span className="text-xs text-muted-foreground">{t.title}</span>}
                    <RiskBadge risk={t.riskLevel} />
                  </button>
                  {t.description && <div className="line-clamp-2 text-xs text-muted-foreground">{t.description}</div>}
                  {show === t.id && (
                    <pre className="mt-1 max-h-60 overflow-auto rounded bg-muted p-2 text-[11px]">{JSON.stringify({ qualifiedName: t.qualifiedName, annotations: t.annotations, inputSchema: t.inputSchema }, null, 2)}</pre>
                  )}
                </div>
                <NativeSelect className="h-8 w-32 shrink-0 text-xs" value={t.riskLevel} onChange={(e) => patch(t, { riskLevel: e.target.value as RiskLevel })} title="風險等級（決定權限模式是否需要批准）">
                  {RISK_LEVELS.map((r) => <option key={r} value={r}>{RISK_LABELS[r]}</option>)}
                </NativeSelect>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground">預設風險依伺服器的工具標註（readOnlyHint 等）推定，未標註一律視為「外部副作用」。你改過的等級在同步時會保留。</p>
        </>
      )}
    </div>
  );
}

function ServerDialog({ server, onClose, onSaved }: { server: McpServerDTO | null; onClose(): void; onSaved(): Promise<void> }) {
  const [name, setName] = useState(server?.name ?? "");
  const [url, setUrl] = useState(server?.url ?? "");
  const [transport, setTransport] = useState<McpTransportKind>(server?.transport ?? "streamable_http");
  const [authType, setAuthType] = useState<McpAuthType>(server?.authType ?? "none");
  const [bearer, setBearer] = useState("");
  const [headers, setHeaders] = useState<{ k: string; v: string }[]>(server?.headerNames.map((k) => ({ k, v: "" })) ?? [{ k: "", v: "" }]);
  const [clientId, setClientId] = useState(server?.oauthClientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [scope, setScope] = useState(server?.oauthScope ?? "");
  const [busy, setBusy] = useState(false);

  async function save() {
    const body: McpServerInput = { name: name.trim(), url: url.trim(), transport, authType };
    if (authType === "bearer" && bearer.trim()) body.bearer = bearer.trim();
    if (authType === "headers") {
      const filled = headers.filter((h) => h.k.trim());
      // editing: untouched values keep the stored headers; changing any value replaces the whole set
      if (server && filled.some((h) => h.v) && filled.some((h) => !h.v)) return toast.error("修改 Header 時請重新填入所有 Header 的值");
      if (!server || filled.some((h) => h.v) || filled.length !== server.headerNames.length) body.headers = Object.fromEntries(filled.map((h) => [h.k.trim(), h.v]));
    }
    if (authType === "oauth") {
      body.oauthClientId = clientId.trim() || null;
      if (clientSecret.trim()) body.oauthClientSecret = clientSecret.trim();
      body.oauthScope = scope.trim() || null;
    }
    setBusy(true);
    try {
      if (server) {
        await api(`/mcp/servers/${server.id}`, { method: "PATCH", body });
        await api<McpSyncResponse>(`/mcp/servers/${server.id}/sync`, { method: "POST" }).catch(() => {});
        toast.success("已儲存");
      } else {
        const r = await api<McpSyncResponse>("/mcp/servers", { method: "POST", body });
        if (r.needsAuth && authType === "oauth") {
          toast.message("已新增，接著前往授權…");
          await onSaved();
          await startOAuth(r.server.id);
          return;
        }
        if (r.error) toast.error(`已新增，但連線失敗：${r.error}`);
        else toast.success(`已新增並取得 ${r.tools.length} 個工具`);
      }
      await onSaved();
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{server ? "編輯 MCP 伺服器" : "新增 MCP 伺服器"}</DialogTitle>
          <DialogDescription>憑證加密存放，儲存後不再顯示；編輯時留空代表沿用原本的值。</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5"><Label>名稱</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="GitHub" /></div>
          <div className="space-y-1.5"><Label>網址</Label><Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/mcp" /></div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>傳輸方式</Label>
              <NativeSelect value={transport} onChange={(e) => setTransport(e.target.value as McpTransportKind)}>
                <option value="streamable_http">Streamable HTTP</option>
                <option value="sse">SSE（舊版）</option>
              </NativeSelect>
            </div>
            <div className="space-y-1.5">
              <Label>授權方式</Label>
              <NativeSelect value={authType} onChange={(e) => setAuthType(e.target.value as McpAuthType)}>
                {(Object.keys(AUTH_LABEL) as McpAuthType[]).map((a) => <option key={a} value={a}>{AUTH_LABEL[a]}</option>)}
              </NativeSelect>
            </div>
          </div>
          {authType === "bearer" && (
            <div className="space-y-1.5"><Label>Bearer Token</Label><Input type="password" value={bearer} onChange={(e) => setBearer(e.target.value)} placeholder={server?.authStatus === "configured" ? "（已設定，留空沿用）" : ""} autoComplete="off" /></div>
          )}
          {authType === "headers" && (
            <div className="space-y-1.5">
              <Label>自訂 Header</Label>
              {headers.map((h, i) => (
                <div key={i} className="flex gap-2">
                  <Input value={h.k} onChange={(e) => setHeaders(headers.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)))} placeholder="X-Api-Key" />
                  <Input type="password" value={h.v} onChange={(e) => setHeaders(headers.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))} placeholder={server ? "（留空沿用）" : "值"} autoComplete="off" />
                  <Button size="icon" variant="ghost" onClick={() => setHeaders(headers.filter((_, j) => j !== i))}><Trash2 /></Button>
                </div>
              ))}
              <Button size="sm" variant="ghost" onClick={() => setHeaders([...headers, { k: "", v: "" }])}><Plus /> 新增 Header</Button>
            </div>
          )}
          {authType === "oauth" && (
            <div className="space-y-3 rounded-md border p-3">
              <p className="text-xs text-muted-foreground">
                依 MCP 授權規格自動探索授權伺服器並動態註冊用戶端（PKCE）。若伺服器不支援動態註冊，請填入你在該服務建立的 Client ID，回呼網址設為：
                <code className="ml-1 break-all">{`${window.location.origin}/api/mcp/oauth/callback`}</code>
              </p>
              <div className="space-y-1.5"><Label>Client ID（選填）</Label><Input value={clientId} onChange={(e) => setClientId(e.target.value)} /></div>
              <div className="space-y-1.5"><Label>Client Secret（選填）</Label><Input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} autoComplete="off" /></div>
              <div className="space-y-1.5"><Label>Scope（選填）</Label><Input value={scope} onChange={(e) => setScope(e.target.value)} placeholder="以空白分隔" /></div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button disabled={busy || !name.trim() || !url.trim()} onClick={save}>{busy && <Loader2 className="animate-spin" />} {server ? "儲存" : "新增"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Project → MCP: which servers this project's conversations may use (null = every enabled server). */
export function ProjectMcp({ p, onSaved }: { p: ProjectDTO; onSaved(p: ProjectDTO): void }) {
  const ws = useWorkspace();
  const [servers, setServers] = useState<McpServerDTO[] | null>(null);
  useEffect(() => {
    api<McpServerDTO[]>("/mcp/servers").then(setServers).catch((e) => toast.error((e as Error).message));
  }, []);
  const all = p.enabledMcpServers === null;
  const enabled = new Set(p.enabledMcpServers ?? servers?.map((s) => s.id) ?? []);
  async function save(enabledMcpServers: string[] | null) {
    try {
      onSaved(await api<ProjectDTO>(`/projects/${p.id}`, { method: "PATCH", body: { enabledMcpServers } }));
      await ws.refreshProjects();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>啟用的 MCP 伺服器</CardTitle>
        <CardDescription>只有勾選的伺服器的工具會提供給這個專案的對話。個別工具的啟用與風險等級在「設定 → MCP」調整。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <label className="flex items-center gap-3 text-sm font-medium">
          <Switch checked={all} onCheckedChange={(v) => save(v ? null : (servers ?? []).map((s) => s.id))} />
          啟用全部 MCP 伺服器（包含之後新增的）
        </label>
        {!servers ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        ) : !servers.length ? (
          <p className="text-sm text-muted-foreground">還沒有 MCP 伺服器。</p>
        ) : (
          <div className="divide-y rounded-md border">
            {servers.map((s) => (
              <label key={s.id} className="flex items-center gap-3 p-3 text-sm">
                <input type="checkbox" disabled={all} checked={all || enabled.has(s.id)}
                  onChange={(e) => {
                    const next = new Set(enabled);
                    if (e.target.checked) next.add(s.id);
                    else next.delete(s.id);
                    save([...next]);
                  }} />
                <span className="font-medium">{s.name}</span>
                <span className="text-xs text-muted-foreground">{s.enabledToolCount} 個工具</span>
                {!s.enabled && <Badge variant="outline">已停用</Badge>}
              </label>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
