import { useCallback, useEffect, useRef, useState } from "react";
import { Download, FilePlus2, GitBranch, KeyRound, Loader2, Pencil, Plus, Sparkles, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { SKILL_TEMPLATE, type ProjectDTO, type SkillDTO, type SkillDetailDTO, type SkillImportResult } from "@edgemind/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ConfirmDialog, PromptDialog } from "@/components/PromptDialog";
import { api, apiUpload } from "@/lib/api";
import { useWorkspace } from "@/lib/workspace";

const SOURCE: Record<string, string> = { upload: "zip 上傳", editor: "編輯器", github: "GitHub", model: "模型建立" };
const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);
const TEXT_RE = /\.(md|markdown|txt|py|js|ts|mjs|cjs|sh|json|ya?ml|toml|csv|html?|css|xml|sql|rb|go|rs|java|r|lua|ini|cfg)$/i;

function reportImport(r: SkillImportResult) {
  if (r.imported.length) toast.success(`已匯入 ${r.imported.length} 個 Skill：${r.imported.map((s) => s.name).join("、")}`);
  for (const s of r.skipped) (s.reason.startsWith("已匯入") ? toast.message : toast.error)(`${s.name}：${s.reason}`);
  if (!r.imported.length && !r.skipped.length) toast.error("沒有匯入任何 Skill");
}

/** Settings → Skills: list, enable, create in the editor, zip upload, GitHub import, export, delete. */
export function SkillsSection() {
  const [skills, setSkills] = useState<SkillDTO[] | null>(null);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [deleting, setDeleting] = useState<SkillDTO | null>(null);
  const [github, setGithub] = useState(false);
  const [tokenOpen, setTokenOpen] = useState(false);
  const [overwrite, setOverwrite] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => setSkills(await api<SkillDTO[]>("/skills")), []);
  useEffect(() => {
    load().catch((e) => toast.error((e as Error).message));
  }, [load]);

  async function upload(f: File) {
    if (f.size > 6 * 1024 * 1024) return toast.error("zip 上限 6 MB（較大的 Skill 請從 GitHub 匯入）");
    setUploading(true);
    try {
      reportImport(await apiUpload<SkillImportResult>(`/skills/upload${overwrite ? "?overwrite=1" : ""}`, f, "application/zip"));
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setUploading(false);
    }
  }

  async function toggle(s: SkillDTO, enabled: boolean) {
    try {
      const r = await api<SkillDTO>(`/skills/${s.id}`, { method: "PATCH", body: { enabled } });
      setSkills((xs) => xs?.map((x) => (x.id === r.id ? r : x)) ?? null);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Sparkles className="size-4" /> Skills</CardTitle>
        <CardDescription>
          相容 Agent Skills 格式（資料夾內含 SKILL.md）。系統提示只放名稱與描述，模型判斷需要時才用 skill_load 載入完整內容；模型也能用 skill_write 建立或修改 Skill（受權限模式控管）。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => setEditing("new")}><Plus /> 新增 Skill</Button>
          <Button size="sm" variant="outline" disabled={uploading} onClick={() => fileRef.current?.click()}>
            {uploading ? <Loader2 className="animate-spin" /> : <Upload />} 上傳 zip
          </Button>
          <Button size="sm" variant="outline" onClick={() => setGithub(true)}><GitBranch /> 從 GitHub 匯入</Button>
          <Button size="sm" variant="ghost" onClick={() => setTokenOpen(true)}><KeyRound /> GitHub Token</Button>
          <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
            <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} /> 同名時覆寫
          </label>
          <input ref={fileRef} type="file" accept=".zip,application/zip" className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) upload(f);
            }} />
        </div>

        {!skills ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> 載入中…</div>
        ) : !skills.length ? (
          <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">還沒有 Skill。可以從編輯器新增、上傳 zip，或貼上 GitHub 網址匯入（例如 anthropics/skills）。</p>
        ) : (
          <div className="divide-y rounded-md border">
            {skills.map((s) => (
              <div key={s.id} className="flex items-start gap-3 p-3">
                <Switch checked={s.enabled} onCheckedChange={(v) => toggle(s, v)} aria-label="啟用" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm font-medium">{s.name}</span>
                    <Badge variant="outline">{SOURCE[s.source] ?? s.source}</Badge>
                    <span className="text-xs text-muted-foreground">{s.files.length} 個檔案</span>
                  </div>
                  <p className="line-clamp-2 text-xs text-muted-foreground">{s.description}</p>
                  {s.sourceUrl && <a href={s.sourceUrl} target="_blank" rel="noreferrer" className="text-xs text-primary underline-offset-2 hover:underline">{s.sourceUrl}</a>}
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button size="icon" variant="ghost" title="編輯" onClick={() => setEditing(s.id)}><Pencil /></Button>
                  <Button size="icon" variant="ghost" title="匯出 zip" asChild><a href={`/api/skills/${s.id}/export`} download><Download /></a></Button>
                  <Button size="icon" variant="ghost" title="刪除" onClick={() => setDeleting(s)}><Trash2 /></Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      {editing && <SkillEditor id={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => load()} onCreated={(id) => setEditing(id)} />}
      <GithubImportDialog open={github} onOpenChange={setGithub} overwrite={overwrite} onDone={load} />
      <GithubTokenDialog open={tokenOpen} onOpenChange={setTokenOpen} />
      <ConfirmDialog open={!!deleting} onOpenChange={(v) => !v && setDeleting(null)} title={`刪除 Skill「${deleting?.name}」？`}
        description="會一併刪除儲存空間裡的所有檔案，並從各專案的啟用清單移除。" destructive confirmLabel="刪除"
        onConfirm={async () => {
          await api(`/skills/${deleting!.id}`, { method: "DELETE" });
          setDeleting(null);
          await load();
        }} />
    </Card>
  );
}

function GithubImportDialog({ open, onOpenChange, overwrite, onDone }: { open: boolean; onOpenChange(v: boolean): void; overwrite: boolean; onDone(): void }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    try {
      reportImport(await api<SkillImportResult>("/skills/import", { method: "POST", body: { url: url.trim(), overwrite } }));
      onDone();
      onOpenChange(false);
      setUrl("");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>從 GitHub 匯入 Skills</DialogTitle>
          <DialogDescription>
            貼上 repo、資料夾或 SKILL.md 的網址。資料夾裡有多個 Skill 時會全部匯入（一次最多 30 個）。分支名稱不能含「/」。
          </DialogDescription>
        </DialogHeader>
        <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/anthropics/skills/tree/main/skills/pdf" onKeyDown={(e) => e.key === "Enter" && url.trim() && run()} />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button disabled={busy || !url.trim()} onClick={run}>{busy && <Loader2 className="animate-spin" />} 匯入</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function GithubTokenDialog({ open, onOpenChange }: { open: boolean; onOpenChange(v: boolean): void }) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [token, setToken] = useState("");
  useEffect(() => {
    if (open) api<{ configured: boolean }>("/settings/github").then((r) => setConfigured(r.configured)).catch(() => {});
  }, [open]);
  async function save(v: string | null) {
    try {
      const r = await api<{ configured: boolean }>("/settings/github", { method: "PUT", body: { token: v } });
      setConfigured(r.configured);
      setToken("");
      toast.success(v ? "已儲存 GitHub Token" : "已移除 GitHub Token");
      onOpenChange(false);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>GitHub Token（選填）</DialogTitle>
          <DialogDescription>
            匯入私有 repo 或遇到速率限制時使用。建議建立只有 Contents: Read-only 權限的 fine-grained token；Token 會加密存放。目前狀態：{configured === null ? "…" : configured ? "已設定" : "未設定"}
          </DialogDescription>
        </DialogHeader>
        <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="github_pat_…" autoComplete="off" />
        <DialogFooter>
          {configured && <Button variant="outline" className="text-destructive" onClick={() => save(null)}>移除</Button>}
          <Button disabled={!token.trim()} onClick={() => save(token.trim())}>儲存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Online editor: SKILL.md + any text file of the skill folder. */
function SkillEditor({ id, onClose, onSaved, onCreated }: { id: string | null; onClose(): void; onSaved(): void; onCreated(id: string): void }) {
  const [skill, setSkill] = useState<SkillDetailDTO | null>(null);
  const [path, setPath] = useState("SKILL.md");
  const [text, setText] = useState(id ? "" : SKILL_TEMPLATE);
  const [original, setOriginal] = useState(id ? "" : SKILL_TEMPLATE);
  const [loadingFile, setLoadingFile] = useState(false);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const dirty = text !== original;

  useEffect(() => {
    if (!id) return;
    api<SkillDetailDTO>(`/skills/${id}`)
      .then((s) => {
        setSkill(s);
        setPath("SKILL.md");
        setText(s.skillMd);
        setOriginal(s.skillMd);
      })
      .catch((e) => toast.error((e as Error).message));
  }, [id]);

  async function open(p: string) {
    if (!skill || p === path) return;
    if (dirty && !window.confirm("目前檔案尚未儲存，要放棄修改嗎？")) return;
    if (!TEXT_RE.test(p) && p !== "SKILL.md") {
      toast.message("這不是文字檔，無法在編輯器開啟；可匯出 zip 後在電腦上編輯。");
      return;
    }
    setLoadingFile(true);
    try {
      const res = await fetch(`/api/skills/${skill.id}/file?path=${encodeURIComponent(p)}`, { credentials: "same-origin" });
      if (!res.ok) throw new Error(`讀取失敗（HTTP ${res.status}）`);
      const t = await res.text();
      setPath(p);
      setText(t);
      setOriginal(t);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoadingFile(false);
    }
  }

  async function save() {
    setBusy(true);
    try {
      if (!skill) {
        const s = await api<SkillDetailDTO>("/skills", { method: "POST", body: { content: text } });
        toast.success(`已建立 Skill「${s.name}」`);
        onSaved();
        onCreated(s.id);
        return;
      }
      const s = await api<SkillDetailDTO>(`/skills/${skill.id}/file`, { method: "PUT", body: { path, content: text } });
      setSkill(s);
      setOriginal(text);
      toast.success("已儲存");
      onSaved();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function removeFile(p: string) {
    if (!skill || !window.confirm(`刪除 ${p}？`)) return;
    try {
      const s = await api<SkillDetailDTO>(`/skills/${skill.id}/file?path=${encodeURIComponent(p)}`, { method: "DELETE" });
      setSkill(s);
      if (p === path) {
        setPath("SKILL.md");
        setText(s.skillMd);
        setOriginal(s.skillMd);
      }
      onSaved();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && (!dirty || window.confirm("尚未儲存，確定關閉？")) && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-5xl overflow-hidden">
        <DialogHeader>
          <DialogTitle>{skill ? <>編輯 Skill <span className="font-mono">{skill.name}</span></> : "新增 Skill"}</DialogTitle>
          <DialogDescription>SKILL.md 的 front matter 需要 name（小寫英數與連字號）與 description（做什麼、何時使用）。</DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 gap-3 md:grid-cols-[200px_1fr]">
          <div className="space-y-1 overflow-y-auto md:max-h-[60vh]">
            {(skill?.files ?? [{ path: "SKILL.md", size: text.length, mime: "text/markdown" }]).map((f) => (
              <div key={f.path} className={`group flex items-center gap-1 rounded px-2 py-1 text-xs ${f.path === path ? "bg-accent" : "hover:bg-accent/50"}`}>
                <button className="min-w-0 flex-1 truncate text-left font-mono" title={f.path} onClick={() => open(f.path)}>{f.path}</button>
                <span className="shrink-0 text-[10px] text-muted-foreground">{fmtSize(f.size)}</span>
                {skill && f.path !== "SKILL.md" && (
                  <button className="hidden text-destructive group-hover:block" title="刪除" onClick={() => removeFile(f.path)}><Trash2 className="size-3" /></button>
                )}
              </div>
            ))}
            {skill && <Button size="sm" variant="ghost" className="w-full justify-start" onClick={() => setAdding(true)}><FilePlus2 /> 新增檔案</Button>}
          </div>
          <div className="min-w-0 space-y-1.5">
            <Label className="font-mono text-xs">{path}{dirty && " •"}</Label>
            {loadingFile ? (
              <div className="flex h-[55vh] items-center justify-center text-muted-foreground"><Loader2 className="animate-spin" /></div>
            ) : (
              <textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck={false}
                className="h-[55vh] w-full resize-none rounded-md border bg-background px-3 py-2 font-mono text-[13px] leading-relaxed" />
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>關閉</Button>
          <Button disabled={busy || (!dirty && !!skill)} onClick={save}>{busy && <Loader2 className="animate-spin" />} {skill ? "儲存" : "建立"}</Button>
        </DialogFooter>
        <PromptDialog open={adding} onOpenChange={setAdding} title="新增檔案" placeholder="references/guide.md" description="路徑相對於 Skill 資料夾。" confirmLabel="建立"
          onSubmit={async (p) => {
            if (!skill) return;
            try {
              const s = await api<SkillDetailDTO>(`/skills/${skill.id}/file`, { method: "PUT", body: { path: p, content: "" } });
              setSkill(s);
              setPath(p.replace(/^\/+/, ""));
              setText("");
              setOriginal("");
              onSaved();
            } catch (e) {
              toast.error((e as Error).message);
            }
          }} />
      </DialogContent>
    </Dialog>
  );
}

/** Project → Skills: which skills this project's conversations may see (null = every enabled skill). */
export function ProjectSkills({ p, onSaved }: { p: ProjectDTO; onSaved(p: ProjectDTO): void }) {
  const ws = useWorkspace();
  const [skills, setSkills] = useState<SkillDTO[] | null>(null);
  useEffect(() => {
    api<SkillDTO[]>("/skills").then(setSkills).catch((e) => toast.error((e as Error).message));
  }, []);
  const all = p.enabledSkills === null;
  const enabled = new Set(p.enabledSkills ?? skills?.map((s) => s.id) ?? []);

  async function save(enabledSkills: string[] | null) {
    try {
      onSaved(await api<ProjectDTO>(`/projects/${p.id}`, { method: "PATCH", body: { enabledSkills } }));
      await ws.refreshProjects();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>啟用的 Skills</CardTitle>
        <CardDescription>只有勾選的 Skills 會出現在這個專案的系統提示裡。Skill 本身在「設定 → Skills」管理；停用的 Skill 在任何地方都不會出現。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <label className="flex items-center gap-3 text-sm font-medium">
          <Switch checked={all} onCheckedChange={(v) => save(v ? null : (skills ?? []).map((s) => s.id))} />
          啟用全部 Skills（包含之後新增的）
        </label>
        {!skills ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        ) : !skills.length ? (
          <p className="text-sm text-muted-foreground">還沒有 Skill。</p>
        ) : (
          <div className="divide-y rounded-md border">
            {skills.map((s) => (
              <label key={s.id} className="flex items-start gap-3 p-3 text-sm">
                <input type="checkbox" className="mt-1" disabled={all} checked={all || enabled.has(s.id)}
                  onChange={(e) => {
                    const next = new Set(enabled);
                    if (e.target.checked) next.add(s.id);
                    else next.delete(s.id);
                    save([...next]);
                  }} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2"><span className="font-mono text-[13px]">{s.name}</span>{!s.enabled && <Badge variant="outline">已停用</Badge>}</div>
                  <div className="line-clamp-2 text-xs text-muted-foreground">{s.description}</div>
                </div>
              </label>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
