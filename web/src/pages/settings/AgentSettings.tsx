import { useEffect, useState } from "react";
import { toast } from "sonner";
import { PERMISSION_MODES, PERMISSION_MODE_LABELS, type AgentSettingsDTO, type PermissionMode } from "@edgemind/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { api } from "@/lib/api";
import { modelLabel, useWorkspace } from "@/lib/workspace";

const numOrNull = (s: string) => (s.trim() === "" || Number(s) <= 0 ? null : Number(s));

export function AgentSettingsSection() {
  const ws = useWorkspace();
  const [s, setS] = useState<AgentSettingsDTO | null>(null);
  const [mode, setMode] = useState<PermissionMode>("normal");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<AgentSettingsDTO>("/settings/agent").then(setS).catch((e) => toast.error(e.message));
    api<{ globalMode: PermissionMode }>("/permissions").then((r) => setMode(r.globalMode)).catch(() => {});
  }, []);
  if (!s) return null;

  const price = (id: string, k: "input" | "output" | "cachedInput") => s.modelPrices[id]?.[k] ?? "";
  const setPrice = (id: string, k: "input" | "output" | "cachedInput", v: string) => {
    const cur = s.modelPrices[id] ?? { input: 0, output: 0 };
    const next = { ...cur, [k]: k === "cachedInput" && v === "" ? undefined : Number(v) || 0 };
    setS({ ...s, modelPrices: { ...s.modelPrices, [id]: next } });
  };

  async function save() {
    setBusy(true);
    try {
      await api("/settings/agent", { method: "PUT", body: s });
      await api("/permissions/mode", { method: "PUT", body: { scope: "global", mode } });
      await ws.refreshMeta();
      toast.success("已儲存");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle>預設值</CardTitle><CardDescription>專案與個別對話可以覆蓋這些設定。</CardDescription></CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>預設模型</Label>
            <NativeSelect value={s.defaultModelId ?? ""} onChange={(e) => setS({ ...s, defaultModelId: e.target.value || null })}>
              <option value="">（第一個可用模型）</option>
              {ws.models.map((m) => <option key={m.id} value={m.id}>{m.providerName} · {modelLabel(m)}</option>)}
            </NativeSelect>
          </div>
          <div className="space-y-1.5">
            <Label>自動命名使用的模型</Label>
            <NativeSelect value={s.titleModelId ?? ""} onChange={(e) => setS({ ...s, titleModelId: e.target.value || null })}>
              <option value="">（與對話相同）</option>
              {ws.models.map((m) => <option key={m.id} value={m.id}>{m.providerName} · {modelLabel(m)}</option>)}
            </NativeSelect>
          </div>
          <div className="space-y-1.5">
            <Label>全域權限模式</Label>
            <NativeSelect value={mode} onChange={(e) => setMode(e.target.value as PermissionMode)}>
              {PERMISSION_MODES.map((m) => <option key={m} value={m}>{PERMISSION_MODE_LABELS[m]}</option>)}
            </NativeSelect>
          </div>
          <div className="space-y-1.5">
            <Label>每次執行的步數上限</Label>
            <Input type="number" min={1} max={200} value={s.maxSteps} onChange={(e) => setS({ ...s, maxSteps: Number(e.target.value) || 1 })} />
          </div>
        </CardContent>
      </Card>
      <Card className="border-red-500/40">
        <CardHeader>
          <CardTitle>「全部權限」模式上限</CardTitle>
          <CardDescription>全部權限模式下工具不經詢問就執行；達到任一上限時該次執行會自動結束。留空表示不限。</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label>步數上限</Label>
            <Input type="number" min={1} value={s.fullModeCaps.maxSteps ?? ""} onChange={(e) => setS({ ...s, fullModeCaps: { ...s.fullModeCaps, maxSteps: numOrNull(e.target.value) } })} />
          </div>
          <div className="space-y-1.5">
            <Label>Token 上限（輸入＋輸出）</Label>
            <Input type="number" min={1} value={s.fullModeCaps.maxTokens ?? ""} onChange={(e) => setS({ ...s, fullModeCaps: { ...s.fullModeCaps, maxTokens: numOrNull(e.target.value) } })} />
          </div>
          <div className="space-y-1.5">
            <Label>花費上限（USD）</Label>
            <Input type="number" min={0} step="0.01" value={s.fullModeCaps.maxCostUsd ?? ""} onChange={(e) => setS({ ...s, fullModeCaps: { ...s.fullModeCaps, maxCostUsd: numOrNull(e.target.value) } })} />
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>模型價格</CardTitle><CardDescription>每百萬 tokens 的美元價格（輸入／快取輸入／輸出），用來計算「用量」頁的花費與花費上限；快取輸入留空時以輸入價格計算，未填的模型不計費。</CardDescription></CardHeader>
        <CardContent className="space-y-2">
          {!ws.models.length && <p className="text-sm text-muted-foreground">尚未設定模型。</p>}
          {ws.models.map((m) => (
            <div key={m.id} className="grid grid-cols-[1fr_6rem_6rem_6rem] items-center gap-2 text-sm">
              <span className="truncate">{m.providerName} · {modelLabel(m)}</span>
              <Input type="number" min={0} step="0.01" placeholder="輸入" value={price(m.id, "input")} onChange={(e) => setPrice(m.id, "input", e.target.value)} />
              <Input type="number" min={0} step="0.01" placeholder="快取輸入" value={price(m.id, "cachedInput")} onChange={(e) => setPrice(m.id, "cachedInput", e.target.value)} />
              <Input type="number" min={0} step="0.01" placeholder="輸出" value={price(m.id, "output")} onChange={(e) => setPrice(m.id, "output", e.target.value)} />
            </div>
          ))}
        </CardContent>
      </Card>
      <div className="flex justify-end"><Button onClick={save} disabled={busy}>儲存</Button></div>
    </div>
  );
}
