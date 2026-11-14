import { useEffect, useMemo, useState } from "react";
import { Link, NavLink, useNavigate, useParams } from "react-router-dom";
import { Archive, ArchiveRestore, FolderInput, FolderOpen, FolderPlus, LogOut, MoreHorizontal, Pencil, Pin, PinOff, Plus, Search, Settings, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import type { ConversationDTO } from "@edgemind/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { NativeSelect } from "@/components/ui/native-select";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ConfirmDialog, PromptDialog } from "@/components/PromptDialog";
import { api } from "@/lib/api";
import { useWorkspace } from "@/lib/workspace";
import { cn } from "@/lib/utils";

export function Sidebar({ onLogout, onNavigate }: { onLogout(): void; onNavigate?(): void }) {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const { id: activeId } = useParams();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<ConversationDTO[] | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [archived, setArchived] = useState<ConversationDTO[]>([]);
  const [newProject, setNewProject] = useState(false);

  useEffect(() => {
    if (!q.trim()) return setResults(null);
    const t = setTimeout(() => {
      api<ConversationDTO[]>(`/conversations?archived=all&q=${encodeURIComponent(q.trim())}`).then(setResults).catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    if (showArchived) api<ConversationDTO[]>("/conversations?archived=1").then(setArchived).catch(() => {});
  }, [showArchived, ws.conversations]);

  const pinned = useMemo(() => ws.conversations.filter((c) => c.pinned), [ws.conversations]);
  const recent = useMemo(() => ws.conversations.filter((c) => !c.pinned), [ws.conversations]);

  async function logout() {
    await api("/auth/logout", { method: "POST" }).catch(() => {});
    onLogout();
  }

  const item = (c: ConversationDTO) => <ConversationItem key={c.id} c={c} active={c.id === activeId} onNavigate={onNavigate} />;

  return (
    <div className="flex h-full flex-col gap-2 p-3">
      <div className="flex items-center justify-between px-1">
        <Link to="/" onClick={onNavigate} className="flex items-center gap-2 font-semibold">
          <img src="/favicon.svg" alt="" className="h-6 w-6" /> EdgeMind
        </Link>
        <Button size="icon" variant="ghost" title="新對話" aria-label="新對話" onClick={() => { navigate("/"); onNavigate?.(); }}>
          <Plus />
        </Button>
      </div>
      <div className="relative">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜尋對話…" className="pl-8 pr-8" />
        {q && (
          <button className="absolute right-2 top-2.5 text-muted-foreground" onClick={() => setQ("")} aria-label="清除搜尋">
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
        {results ? (
          <Section title={`搜尋結果（${results.length}）`}>
            {results.map((c) => (
              <Link key={c.id} to={`/c/${c.id}`} onClick={onNavigate} className="block rounded-md px-2 py-1.5 text-sm hover:bg-accent">
                <div className="truncate font-medium">{c.title || "未命名對話"}</div>
                {c.snippet && <div className="line-clamp-2 text-xs text-muted-foreground">{c.snippet}</div>}
              </Link>
            ))}
            {!results.length && <p className="px-2 py-1 text-xs text-muted-foreground">找不到符合的對話</p>}
          </Section>
        ) : (
          <>
            <Section
              title="專案"
              action={<button className="text-muted-foreground hover:text-foreground" title="新增專案" aria-label="新增專案" onClick={() => setNewProject(true)}><FolderPlus className="h-4 w-4" /></button>}
            >
              {ws.projects.map((p) => (
                <NavLink key={p.id} to={`/p/${p.id}`} onClick={onNavigate}
                  className={({ isActive }) => cn("flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent", isActive && "bg-accent font-medium")}>
                  <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="truncate">{p.name}</span>
                  <span className="ml-auto text-xs text-muted-foreground">{p.conversationCount ?? ""}</span>
                </NavLink>
              ))}
              {!ws.projects.length && <p className="px-2 py-1 text-xs text-muted-foreground">尚無專案</p>}
            </Section>
            {pinned.length > 0 && <Section title="已釘選">{pinned.map(item)}</Section>}
            <Section title="最近對話">
              {recent.map(item)}
              {!recent.length && <p className="px-2 py-1 text-xs text-muted-foreground">還沒有對話</p>}
            </Section>
            <button className="mt-2 px-2 text-xs text-muted-foreground hover:text-foreground" onClick={() => setShowArchived((v) => !v)}>
              {showArchived ? "隱藏已封存" : "顯示已封存"}
            </button>
            {showArchived && <Section title="已封存">{archived.map(item)}{!archived.length && <p className="px-2 py-1 text-xs text-muted-foreground">沒有封存的對話</p>}</Section>}
          </>
        )}
      </div>

      <div className="flex items-center gap-1 border-t pt-2">
        <Button asChild variant="ghost" size="sm" className="flex-1 justify-start">
          <Link to="/settings" onClick={onNavigate}><Settings /> 設定</Link>
        </Button>
        <ThemeToggle />
        <Button variant="ghost" size="icon" onClick={logout} title="登出" aria-label="登出"><LogOut /></Button>
      </div>

      <PromptDialog
        open={newProject}
        onOpenChange={setNewProject}
        title="新增專案"
        placeholder="專案名稱"
        confirmLabel="建立"
        onSubmit={async (name) => {
          const p = await api<{ id: string }>("/projects", { method: "POST", body: { name } });
          await ws.refreshProjects();
          navigate(`/p/${p.id}`);
          onNavigate?.();
        }}
      />
    </div>
  );
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="mt-3">
      <div className="mb-1 flex items-center justify-between px-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <span>{title}</span>
        {action}
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function ConversationItem({ c, active, onNavigate }: { c: ConversationDTO; active: boolean; onNavigate?(): void }) {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const [rename, setRename] = useState(false);
  const [del, setDel] = useState(false);
  const [move, setMove] = useState(false);
  const [target, setTarget] = useState<string>(c.projectId ?? "");

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      await ws.refreshConversations();
      await ws.refreshProjects();
      if (ok) toast.success(ok);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <div className={cn("group flex items-center rounded-md hover:bg-accent", active && "bg-accent")}>
      <Link to={`/c/${c.id}`} onClick={onNavigate} className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5 text-sm">
        {c.pinned && <Pin className="h-3 w-3 shrink-0 text-muted-foreground" />}
        <span className={cn("truncate", active && "font-medium")}>{c.title || "未命名對話"}</span>
      </Link>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="mr-1 rounded p-1 text-muted-foreground opacity-0 hover:text-foreground focus:opacity-100 group-hover:opacity-100" aria-label="對話選項">
            <MoreHorizontal className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setRename(true)}><Pencil /> 重新命名</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => act(() => ws.patchConversation(c.id, { pinned: !c.pinned }))}>
            {c.pinned ? <><PinOff /> 取消釘選</> : <><Pin /> 釘選</>}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setMove(true)}><FolderInput /> 移至專案</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => act(() => ws.patchConversation(c.id, { archived: !c.archived }), c.archived ? "已取消封存" : "已封存")}>
            {c.archived ? <><ArchiveRestore /> 取消封存</> : <><Archive /> 封存</>}
          </DropdownMenuItem>
          <DropdownMenuItem className="text-destructive" onSelect={() => setDel(true)}><Trash2 /> 刪除</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <PromptDialog open={rename} onOpenChange={setRename} title="重新命名對話" initial={c.title ?? ""} confirmLabel="儲存"
        onSubmit={(title) => act(() => ws.patchConversation(c.id, { title }))} />
      <ConfirmDialog open={del} onOpenChange={setDel} title="刪除對話？" description="此對話的所有訊息都會被永久刪除，無法復原。" confirmLabel="刪除" destructive
        onConfirm={() => act(async () => {
          await api(`/conversations/${c.id}`, { method: "DELETE" });
          if (active) navigate("/");
        }, "已刪除")} />
      <Dialog open={move} onOpenChange={setMove}>
        <DialogContent>
          <DialogHeader><DialogTitle>移至專案</DialogTitle></DialogHeader>
          <NativeSelect value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">（不屬於任何專案）</option>
            {ws.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </NativeSelect>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setMove(false)}>取消</Button>
            <Button onClick={() => act(async () => { await ws.patchConversation(c.id, { projectId: target || null }); setMove(false); }, "已移動")}>移動</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
