import { useEffect, useState, type FormEvent } from "react";
import { AlertTriangle, KeyRound, Loader2, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { normalizeSecretName, parseAllowedDomains, type SecretDTO } from "@edgemind/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";

/** Settings → 密鑰: secrets vault for http_request `{{secret:NAME}}` (values are write-only). */
export function SecretsSection() {
  const [items, setItems] = useState<SecretDTO[] | null>(null);
  const [editing, setEditing] = useState<SecretDTO | null>(null);
  const [open, setOpen] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Reloads the list; a failure is shown in the card (not an endless spinner) with the server's message. */
  const load = () =>
    api<{ secrets: SecretDTO[] }>("/secrets")
      .then((r) => {
        setItems(r.secrets);
        setLoadError(null);
        return r.secrets;
      })
      .catch((e) => {
        setLoadError((e as Error).message);
        return null;
      });
  useEffect(() => {
    load();
  }, []);

  async function remove(s: SecretDTO) {
    if (!window.confirm(`刪除密鑰 ${s.name}？使用它的 Skill 或請求將無法運作。`)) return;
    try {
      await api(`/secrets/${s.id}`, { method: "DELETE" });
      toast.success("已刪除");
      load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div className="space-y-1.5">
          <CardTitle>密鑰</CardTitle>
          <CardDescription>
            給 http_request 工具與 Skills（例如 e2b-sandbox、self-hosted-runner）使用的 API Key 等機密。模型只看得到名稱，
            在請求中寫 <code className="rounded bg-muted px-1">{"{{secret:名稱}}"}</code> 由伺服器端替換；每個密鑰只能送往你允許的網域，回應中出現的密鑰值會自動遮蔽。
            值以 AES-GCM 加密儲存，存入後不會再顯示。
          </CardDescription>
        </div>
        <Button size="sm" onClick={() => { setEditing(null); setOpen(true); }}><Plus /> 新增密鑰</Button>
      </CardHeader>
      <CardContent>
        {loadError ? (
          <div role="alert" className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span className="min-w-0 flex-1">無法載入密鑰清單：{loadError}</span>
            <Button size="sm" variant="outline" onClick={() => load()}><RefreshCw /> 重試</Button>
          </div>
        ) : !items ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : !items.length ? (
          <p className="text-sm text-muted-foreground">尚未新增任何密鑰。例如新增 <code>E2B_API_KEY</code>（允許網域 <code>api.e2b.app</code>）即可讓 e2b-sandbox Skill 使用 E2B 雲端沙盒。</p>
        ) : (
          <ul className="divide-y">
            {items.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-3 py-3">
                <KeyRound className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm font-medium">{s.name}</span>
                    <span className="font-mono text-xs text-muted-foreground">{s.preview}</span>
                  </div>
                  {s.description && <div className="text-xs text-muted-foreground">{s.description}</div>}
                  <div className="mt-1 flex flex-wrap gap-1">
                    {s.allowedDomains.length ? s.allowedDomains.map((d) => <Badge key={d} variant="secondary" className="font-mono text-[11px]">{d}</Badge>) : <Badge variant="destructive">未設定允許網域（無法使用）</Badge>}
                  </div>
                </div>
                <Button variant="ghost" size="icon" aria-label="編輯" onClick={() => { setEditing(s); setOpen(true); }}><Pencil /></Button>
                <Button variant="ghost" size="icon" aria-label="刪除" className="text-destructive" onClick={() => remove(s)}><Trash2 /></Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <SecretDialog open={open} onOpenChange={setOpen} editing={editing} onSaved={async (saved) => {
        setOpen(false);
        const list = await load();
        // Never let a save look successful when the list (what the model sees) does not contain it.
        if (list && !list.some((x) => x.id === saved.id && x.name === saved.name)) toast.error(`已送出，但重新載入後清單中沒有 ${saved.name}；請重新整理頁面確認，或把瀏覽器開發者工具中 /api/secrets 的回應提供給管理者。`);
        else if (list) toast.success(`已儲存 ${saved.name}`);
      }} />
    </Card>
  );
}

function SecretDialog({ open, onOpenChange, editing, onSaved }: { open: boolean; onOpenChange(v: boolean): void; editing: SecretDTO | null; onSaved(saved: SecretDTO): void }) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [domains, setDomains] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setError(null);
    setName(editing?.name ?? "");
    setValue("");
    setDomains(editing?.allowedDomains.join("\n") ?? "");
    setDescription(editing?.description ?? "");
  }, [open, editing]);

  const parsed = parseAllowedDomains(domains);
  const nm = normalizeSecretName(name);
  const dirty = !!(value || (!editing && (name.trim() || domains.trim())));
  // Show what will be stored when normalization changed what was typed (https://, trailing slash, path, case…).
  const rewritten = domains.split(/[\s,，、；;]+/).filter(Boolean).some((d) => !parsed.domains.includes(d));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (parsed.errors.length) {
      setError(parsed.errors.join("；"));
      return;
    }
    setBusy(true);
    const allowedDomains = parsed.domains;
    try {
      // The server normalizes the name the same way (NFKC, invisible characters, trim) and answers 400 with the reason.
      const r = editing
        ? await api<{ secret: SecretDTO }>(`/secrets/${editing.id}`, { method: "PATCH", body: { name, allowedDomains, description, ...(value ? { value } : {}) } })
        : await api<{ secret: SecretDTO }>("/secrets", { method: "POST", body: { name, value, allowedDomains, description } });
      if (!r?.secret?.id) throw new Error("伺服器沒有回傳已儲存的密鑰（回應格式不符），密鑰可能沒有存入。");
      onSaved(r.secret);
    } catch (err) {
      const msg = (err as Error).message || "儲存失敗";
      setError(`儲存失敗：${msg}`); // shown inside the dialog, which stays open with what was typed
      toast.error(`儲存失敗：${msg}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[90dvh] max-w-lg overflow-y-auto"
        // A click outside / Esc must not silently throw away a typed value (it looked like 「已儲存」 but nothing was sent).
        onInteractOutside={(e) => { if (dirty) e.preventDefault(); }}
        onEscapeKeyDown={(e) => { if (dirty && !window.confirm("放棄尚未儲存的密鑰？")) e.preventDefault(); }}
      >
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{editing ? "編輯密鑰" : "新增密鑰"}</DialogTitle>
            <DialogDescription>值會加密儲存，之後不會再顯示；模型只能透過名稱引用它。</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="secret-name">名稱</Label>
            <Input id="secret-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="E2B_API_KEY" className="font-mono" required autoComplete="off" />
            <p className="text-xs text-muted-foreground">英文字母、數字與底線，不可以數字開頭；需與對話中 <code>{"{{secret:名稱}}"}</code> 完全相符（區分大小寫）。</p>
            {name && nm.error && <p className="text-xs text-destructive">{nm.error}</p>}
            {name && !nm.error && nm.name !== name && <p className="text-xs text-muted-foreground">將儲存為：<span className="font-mono">{nm.name}</span></p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="secret-value">值</Label>
            <Input id="secret-value" type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder={editing ? "留空則保留目前的值" : "貼上 API Key"} required={!editing} autoComplete="new-password" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="secret-domains">允許網域</Label>
            <textarea id="secret-domains" value={domains} onChange={(e) => setDomains(e.target.value)} rows={3} placeholder={"api.e2b.app\n*.example.com"}
              className="w-full resize-y rounded-md border bg-background px-3 py-2 font-mono text-sm" />
            <p className="text-xs text-muted-foreground">
              每行一個主機名稱（貼上網址也可以，會自動去掉 <code>https://</code> 與路徑）；<code>*.example.com</code> 代表所有子網域（不含 example.com 本身），
              <code>example.com</code> 則只比對它本身、不含子網域。沒有設定時此密鑰無法使用。
            </p>
            {parsed.errors.map((err) => <p key={err} className="text-xs text-destructive">{err}</p>)}
            {!parsed.errors.length && rewritten && parsed.domains.length > 0 && (
              <p className="text-xs text-muted-foreground">將儲存為：<span className="font-mono">{parsed.domains.join("、")}</span></p>
            )}
            {!parsed.errors.length && !parsed.domains.length && name.trim() && (
              <p className="text-xs text-amber-600 dark:text-amber-500">尚未填寫允許網域：儲存後模型會看到此密鑰，但無法使用。</p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="secret-desc">說明（選填，模型看得到）</Label>
            <Input id="secret-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="E2B 雲端沙盒 API Key" maxLength={500} />
          </div>
          {error && (
            <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="min-w-0 break-words">{error}</span>
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>取消</Button>
            <Button type="submit" disabled={busy || parsed.errors.length > 0}>{busy && <Loader2 className="animate-spin" />} 儲存</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
