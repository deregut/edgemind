import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Loader2, PlugZap, XCircle } from "lucide-react";
import { toast } from "sonner";
import {
  LLM_PRESETS, PROVIDER_KINDS, PROVIDER_TYPE_LABELS, getKindSpec,
  type ProviderDTO, type ProviderType, type TestResult,
} from "@edgemind/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";

interface Props {
  type: ProviderType;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  editing?: ProviderDTO | null;
  onSaved: () => void;
}

export function ProviderDialog({ type, open, onOpenChange, editing, onSaved }: Props) {
  const kinds = useMemo(() => PROVIDER_KINDS.filter((k) => k.type === type), [type]);
  const [kind, setKind] = useState(kinds[0].kind);
  const [preset, setPreset] = useState(0);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [priority, setPriority] = useState(100);
  const [config, setConfig] = useState<Record<string, string>>({});
  const [testModel, setTestModel] = useState("");
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [result, setResult] = useState<TestResult | null>(null);

  useEffect(() => {
    if (!open) return;
    setResult(null);
    setApiKey("");
    setClearKey(false);
    setTestModel("");
    if (editing) {
      setKind(editing.kind);
      setName(editing.name);
      setBaseUrl(editing.baseUrl);
      setEnabled(editing.enabled);
      setPriority(editing.priority);
      setConfig(editing.config ?? {});
    } else if (type === "llm") {
      applyPreset(0);
      setEnabled(true);
      setPriority(100);
      setConfig({});
    } else {
      const k = kinds[0];
      setKind(k.kind);
      setName(k.label);
      setBaseUrl(k.defaultBaseUrl);
      setEnabled(true);
      setPriority(100);
      setConfig({});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing, type]);

  function applyPreset(i: number) {
    const p = LLM_PRESETS[i];
    setPreset(i);
    setKind(p.protocol);
    setName(p.label.replace(/（.*）/, ""));
    setBaseUrl(p.baseUrl);
  }

  function changeKind(k: string) {
    setKind(k);
    const spec = getKindSpec(type, k)!;
    setBaseUrl(spec.defaultBaseUrl);
    if (!editing) setName(spec.label);
    setConfig({});
  }

  const spec = getKindSpec(type, kind)!;
  const keyRequired = type === "llm" && !editing ? LLM_PRESETS[preset].keyRequired || spec.keyRequired : spec.keyRequired;

  function payload() {
    const body: Record<string, unknown> = { type, kind, name: name.trim(), baseUrl: baseUrl.trim(), enabled, priority, config };
    if (apiKey) body.apiKey = apiKey;
    else if (clearKey) body.apiKey = "";
    return body;
  }

  async function test() {
    setBusy("test");
    setResult(null);
    try {
      const body = { ...payload(), id: editing?.id, model: testModel.trim() || undefined };
      setResult(await api<TestResult>("/providers/test", { method: "POST", body }));
    } catch (e) {
      setResult({ ok: false, latencyMs: 0, message: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    if (!name.trim()) return toast.error("請輸入名稱");
    setBusy("save");
    try {
      if (editing) await api(`/providers/${editing.id}`, { method: "PATCH", body: payload() });
      else await api("/providers", { method: "POST", body: payload() });
      toast.success(editing ? "已更新供應商" : "已新增供應商");
      onSaved();
      onOpenChange(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{editing ? "編輯" : "新增"}{PROVIDER_TYPE_LABELS[type]}供應商</DialogTitle>
          <DialogDescription>API Key 會以 AES-GCM 加密後存入資料庫，之後不會再以明文顯示。</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          {type === "llm" && !editing && (
            <Field label="快速套用">
              <NativeSelect value={preset} onChange={(e) => applyPreset(Number(e.target.value))}>
                {LLM_PRESETS.map((p, i) => <option key={p.label} value={i}>{p.label}</option>)}
              </NativeSelect>
            </Field>
          )}
          <Field label={type === "llm" ? "協定" : "服務"}>
            <NativeSelect value={kind} disabled={!!editing} onChange={(e) => changeKind(e.target.value)}>
              {kinds.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
            </NativeSelect>
          </Field>
          <Field label="名稱">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
          </Field>
          <Field label="Base URL" hint={spec.defaultBaseUrl ? `預設：${spec.defaultBaseUrl}` : "必填"}>
            <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={spec.defaultBaseUrl || "https://"} />
          </Field>
          <Field label={`API Key${keyRequired ? "" : "（選填）"}`} hint={editing?.hasApiKey ? `目前：${editing.apiKeyPreview}；留空表示保留原值` : undefined}>
            <Input type="password" autoComplete="off" value={apiKey} onChange={(e) => { setApiKey(e.target.value); setClearKey(false); }} placeholder={editing?.hasApiKey ? "••••••••（保留原值）" : ""} />
            {editing?.hasApiKey && (
              <label className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                <input type="checkbox" checked={clearKey} onChange={(e) => { setClearKey(e.target.checked); if (e.target.checked) setApiKey(""); }} /> 清除已儲存的 Key
              </label>
            )}
          </Field>
          {(spec.configFields ?? []).map((f) => (
            <Field key={f.key} label={f.label + (f.required ? "" : "（選填）")}>
              <Input value={config[f.key] ?? ""} placeholder={f.placeholder} onChange={(e) => setConfig({ ...config, [f.key]: e.target.value })} />
            </Field>
          ))}
          <div className="grid grid-cols-2 gap-4">
            <Field label="優先順序" hint="數字越小越優先（備援順序）">
              <Input type="number" min={0} value={priority} onChange={(e) => setPriority(Number(e.target.value) || 0)} />
            </Field>
            <Field label="啟用">
              <div className="flex h-9 items-center"><Switch checked={enabled} onCheckedChange={setEnabled} /></div>
            </Field>
          </div>

          <div className="rounded-lg border bg-muted/40 p-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <Field
                label="測試用模型（選填）"
                className="flex-1"
                hint={type === "llm" ? "留空只抓模型清單；填入則實際送出一個極短請求" : spec.suggestedModels?.length ? `預設：${spec.suggestedModels[0]}` : undefined}
              >
                <Input value={testModel} onChange={(e) => setTestModel(e.target.value)} placeholder={spec.suggestedModels?.[0] ?? ""} />
              </Field>
              <Button variant="outline" onClick={test} disabled={busy !== null}>
                {busy === "test" ? <Loader2 className="animate-spin" /> : <PlugZap />} 測試連線
              </Button>
            </div>
            {result && (
              <p className={`mt-2 flex items-start gap-2 text-sm ${result.ok ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"}`} role="status">
                {result.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0" />}
                <span className="break-all">{result.message}{result.latencyMs ? `（${result.latencyMs} ms）` : ""}</span>
              </p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={save} disabled={busy !== null}>
            {busy === "save" && <Loader2 className="animate-spin" />} 儲存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, hint, children, className }: { label: string; hint?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`space-y-1.5 ${className ?? ""}`}>
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
