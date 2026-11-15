import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, BarChart3, Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { SpendCaps, SpendStatus, UsageReport, UsageRow } from "@edgemind/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";

const usd = (n: number) => `$${n < 1 ? n.toFixed(4) : n.toFixed(2)}`;
const num = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
const KIND: Record<string, string> = { chat: "對話", embedding: "嵌入", rerank: "重排序", search: "搜尋", image: "圖片" };
const dateStr = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);

export function UsagePage() {
  const [to, setTo] = useState(() => dateStr(new Date()));
  const [from, setFrom] = useState(() => dateStr(new Date(Date.now() - 29 * 86_400_000)));
  const [report, setReport] = useState<UsageReport | null>(null);
  const [status, setStatus] = useState<SpendStatus | null>(null);
  const [metric, setMetric] = useState<"cost" | "tokens">("cost");
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [r, s] = await Promise.all([
        api<UsageReport>(`/usage?from=${from}&to=${to}`),
        api<SpendStatus>("/usage/status"),
      ]);
      setReport(r);
      setStatus(s);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    load();
  }, []);

  const preset = (days: number) => {
    setTo(dateStr(new Date()));
    setFrom(dateStr(new Date(Date.now() - (days - 1) * 86_400_000)));
  };

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 p-4 md:p-6">
      <h1 className="flex items-center gap-2 text-xl font-semibold"><BarChart3 className="h-5 w-5" /> 用量</h1>
      {status?.message && (
        <div className={`flex items-start gap-2 rounded-md border p-3 text-sm ${status.daily === "blocked" || status.monthly === "blocked" ? "border-destructive text-destructive" : "border-amber-500 text-amber-700 dark:text-amber-400"}`}>
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {status.message}
        </div>
      )}
      <CapsCard status={status} onSaved={load} />
      <Card>
        <CardHeader className="space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1"><Label>開始</Label><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
            <div className="space-y-1"><Label>結束</Label><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
            <Button onClick={load} disabled={loading}>{loading && <Loader2 className="animate-spin" />} 查詢</Button>
            <Button variant="ghost" size="sm" onClick={() => preset(7)}>近 7 天</Button>
            <Button variant="ghost" size="sm" onClick={() => preset(30)}>近 30 天</Button>
            <Button variant="ghost" size="sm" onClick={() => preset(90)}>近 90 天</Button>
          </div>
          {report && (
            <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <Stat label="花費" value={usd(report.totals.costUsd)} />
              <Stat label="呼叫次數" value={num(report.totals.calls)} />
              <Stat label="輸入 Token（快取）" value={`${num(report.totals.inputTokens)}（${num(report.totals.cachedTokens)}）`} />
              <Stat label="輸出 Token（推理）" value={`${num(report.totals.outputTokens)}（${num(report.totals.reasoningTokens)}）`} />
            </div>
          )}
          {report && report.unpricedCalls > 0 && (
            <CardDescription>有 {report.unpricedCalls} 次模型呼叫沒有設定價格，未計入花費。到 <Link className="underline" to="/settings?tab=agent">設定 → Agent 與權限</Link> 填入每百萬 Token 價格。</CardDescription>
          )}
        </CardHeader>
        <CardContent>
          {!report ? <Loader2 className="h-4 w-4 animate-spin" /> : (
            <>
              <div className="mb-2 flex gap-1">
                <Button size="sm" variant={metric === "cost" ? "default" : "outline"} onClick={() => setMetric("cost")}>花費</Button>
                <Button size="sm" variant={metric === "tokens" ? "default" : "outline"} onClick={() => setMetric("tokens")}>Token</Button>
                <span className="ml-auto self-center text-xs text-muted-foreground">時區：{report.timezone}</span>
              </div>
              <DailyChart rows={report.daily} metric={metric} />
              <Tabs defaultValue="model" className="mt-4">
                <TabsList>
                  <TabsTrigger value="model">依模型</TabsTrigger>
                  <TabsTrigger value="conversation">依對話</TabsTrigger>
                  <TabsTrigger value="project">依專案</TabsTrigger>
                  <TabsTrigger value="kind">依類型</TabsTrigger>
                </TabsList>
                <TabsContent value="model"><Breakdown rows={report.byModel} /></TabsContent>
                <TabsContent value="conversation"><Breakdown rows={report.byConversation} link={(k) => (k ? `/c/${k}` : null)} /></TabsContent>
                <TabsContent value="project"><Breakdown rows={report.byProject} link={(k) => (k ? `/p/${k}` : null)} /></TabsContent>
                <TabsContent value="kind"><Breakdown rows={report.byKind.map((r) => ({ ...r, label: KIND[r.key] ?? r.key }))} /></TabsContent>
              </Tabs>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

const Stat = ({ label, value }: { label: string; value: string }) => (
  <div className="rounded-md border p-2"><div className="text-xs text-muted-foreground">{label}</div><div className="font-semibold tabular-nums">{value}</div></div>
);

function DailyChart({ rows, metric }: { rows: (UsageRow & { date: string })[]; metric: "cost" | "tokens" }) {
  const val = (r: UsageRow) => (metric === "cost" ? r.costUsd : r.inputTokens + r.outputTokens);
  const max = Math.max(...rows.map(val), metric === "cost" ? 0.0001 : 1);
  const W = 800, H = 180, pad = 4;
  const bw = (W - pad * 2) / Math.max(rows.length, 1);
  const labelEvery = Math.ceil(rows.length / 8);
  return (
    <svg viewBox={`0 0 ${W} ${H + 18}`} className="w-full" role="img" aria-label="每日用量圖">
      <line x1={0} x2={W} y1={H} y2={H} className="stroke-border" />
      {rows.map((r, i) => {
        const h = (val(r) / max) * (H - 10);
        return (
          <g key={r.date}>
            <rect x={pad + i * bw + bw * 0.15} y={H - h} width={Math.max(bw * 0.7, 1)} height={h} rx={2} className="fill-primary/80">
              <title>{`${r.date}：${usd(r.costUsd)}・${num(r.inputTokens)} 輸入／${num(r.outputTokens)} 輸出・${r.calls} 次`}</title>
            </rect>
            {i % labelEvery === 0 && <text x={pad + i * bw + bw / 2} y={H + 14} textAnchor="middle" className="fill-muted-foreground text-[10px]">{r.date.slice(5)}</text>}
          </g>
        );
      })}
      <text x={W - 2} y={10} textAnchor="end" className="fill-muted-foreground text-[10px]">{metric === "cost" ? usd(max) : num(max)}</text>
    </svg>
  );
}

function Breakdown({ rows, link }: { rows: UsageRow[]; link?: (key: string) => string | null }) {
  const total = useMemo(() => rows.reduce((a, r) => a + r.costUsd, 0), [rows]);
  if (!rows.length) return <p className="py-4 text-sm text-muted-foreground">這段期間沒有用量。</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-muted-foreground">
          <tr><th className="py-2 pr-2">名稱</th><th className="px-2 text-right">次數</th><th className="px-2 text-right">輸入</th><th className="px-2 text-right">快取</th><th className="px-2 text-right">輸出</th><th className="px-2 text-right">推理</th><th className="pl-2 text-right">花費</th></tr>
        </thead>
        <tbody className="divide-y tabular-nums">
          {rows.map((r) => {
            const href = link?.(r.key);
            return (
              <tr key={r.key + r.label}>
                <td className="max-w-[16rem] truncate py-2 pr-2">{href ? <Link className="hover:underline" to={href}>{r.label}</Link> : r.label}</td>
                <td className="px-2 text-right">{r.calls}</td>
                <td className="px-2 text-right">{num(r.inputTokens)}</td>
                <td className="px-2 text-right">{num(r.cachedTokens)}</td>
                <td className="px-2 text-right">{num(r.outputTokens)}</td>
                <td className="px-2 text-right">{num(r.reasoningTokens)}</td>
                <td className="pl-2 text-right">{usd(r.costUsd)}{total > 0 && <span className="ml-1 text-xs text-muted-foreground">{Math.round((r.costUsd / total) * 100)}%</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function CapsCard({ status, onSaved }: { status: SpendStatus | null; onSaved(): void }) {
  const [caps, setCaps] = useState<{ daily: string; monthly: string; warn: string; tz: string } | null>(null);
  useEffect(() => {
    api<SpendCaps>("/settings/spend-caps").then((c) => setCaps({
      daily: c.dailyUsd?.toString() ?? "", monthly: c.monthlyUsd?.toString() ?? "", warn: String(Math.round(c.warnRatio * 100)),
      tz: c.timezone === "UTC" && !c.dailyUsd && !c.monthlyUsd ? Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" : c.timezone,
    })).catch((e) => toast.error(e.message));
  }, []);
  async function save() {
    if (!caps) return;
    try {
      await api("/settings/spend-caps", {
        method: "PUT",
        body: { dailyUsd: caps.daily ? Number(caps.daily) : null, monthlyUsd: caps.monthly ? Number(caps.monthly) : null, warnRatio: Number(caps.warn) / 100, timezone: caps.tz },
      });
      toast.success("已儲存");
      onSaved();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">花費上限</CardTitle>
        <CardDescription>
          每次呼叫模型前檢查；達到上限時停止並顯示錯誤，達到警告比例時提醒。花費依各模型的價格設定計算（<Link className="underline" to="/settings?tab=agent">設定 → Agent 與權限</Link>）。
          {status && <> 今日 {usd(status.todayUsd)}・本月 {usd(status.monthUsd)}。</>}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!caps ? <Loader2 className="h-4 w-4 animate-spin" /> : (
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1"><Label>每日上限（USD）</Label><Input type="number" min={0} step="0.01" placeholder="不限" value={caps.daily} onChange={(e) => setCaps({ ...caps, daily: e.target.value })} className="w-32" /></div>
            <div className="space-y-1"><Label>每月上限（USD）</Label><Input type="number" min={0} step="0.01" placeholder="不限" value={caps.monthly} onChange={(e) => setCaps({ ...caps, monthly: e.target.value })} className="w-32" /></div>
            <div className="space-y-1"><Label>警告比例（%）</Label><Input type="number" min={1} max={99} value={caps.warn} onChange={(e) => setCaps({ ...caps, warn: e.target.value })} className="w-24" /></div>
            <div className="space-y-1"><Label>時區（計算「今天」）</Label><Input value={caps.tz} onChange={(e) => setCaps({ ...caps, tz: e.target.value })} className="w-44" /></div>
            <Button onClick={save}>儲存</Button>
          </div>
        )}
        <p className="mt-2 text-xs text-muted-foreground">「全部權限」模式另有每次執行的步數／Token／花費上限。</p>
      </CardContent>
    </Card>
  );
}
