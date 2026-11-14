import type { StatusResponse } from "@edgemind/shared";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function EnvErrorPage({ status, onRetry }: { status: StatusResponse; onRetry: () => void }) {
  const envBad = !status.env.ok;
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-2xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-5 w-5" /> {envBad ? "環境變數設定不完整" : "無法連線資料庫"}
          </CardTitle>
          <CardDescription>
            {envBad
              ? "EdgeMind 只從環境變數讀取資料庫、物件儲存與兩把金鑰。請在 Netlify（Site settings → Environment variables）或 Cloudflare Pages（Settings → Variables and Secrets）補上以下項目後重新部署。"
              : "環境變數已就緒，但資料庫連線或自動 migrate 失敗。請確認 DATABASE_URL 正確、Neon 專案已啟用 pgvector 擴充。"}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {envBad ? (
            <ul className="divide-y rounded-lg border">
              {status.env.issues.map((i) => (
                <li key={i.key} className="p-3">
                  <div className="flex items-center gap-2 font-mono text-sm font-semibold">
                    {i.key}
                    <span className="rounded bg-destructive/10 px-1.5 py-0.5 font-sans text-xs text-destructive">
                      {i.problem === "missing" ? "未設定" : "格式錯誤"}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">{i.hint}</p>
                </li>
              ))}
            </ul>
          ) : (
            <pre className="overflow-x-auto rounded-lg bg-muted p-3 text-xs">{status.db.error}</pre>
          )}
          <Button onClick={onRetry} variant="outline">
            <RefreshCw /> 重新檢查
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
