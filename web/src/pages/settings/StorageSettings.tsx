import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api";

interface StorageStatus { endpoint: string; bucket: string; region: string; corsOrigins: string[]; origin: string }

export function StorageSection() {
  const [s, setS] = useState<StorageStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => api<StorageStatus>("/storage/status").then(setS).catch((e) => toast.error(e.message));
  useEffect(() => {
    load();
  }, []);
  if (!s) return null;
  const ok = s.corsOrigins.includes(location.origin);
  return (
    <Card>
      <CardHeader>
        <CardTitle>物件儲存（S3）</CardTitle>
        <CardDescription>連線資訊來自環境變數。瀏覽器直傳需要 Bucket 允許此網站來源（CORS），首次上傳時會自動設定。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="grid grid-cols-[6rem_1fr] gap-y-1">
          <span className="text-muted-foreground">端點</span><span className="break-all">{s.endpoint}</span>
          <span className="text-muted-foreground">Bucket</span><span>{s.bucket}</span>
          <span className="text-muted-foreground">區域</span><span>{s.region}</span>
          <span className="text-muted-foreground">CORS 來源</span><span>{s.corsOrigins.length ? s.corsOrigins.join("、") : "尚未設定"}</span>
        </div>
        <div className="flex items-center gap-3">
          <Button size="sm" disabled={busy} onClick={async () => {
            setBusy(true);
            try {
              await api("/storage/cors", { method: "POST", body: { origin: location.origin } });
              toast.success("已設定 Bucket CORS");
              load();
            } catch (e) {
              toast.error((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}>{ok ? "重新套用 CORS" : `允許 ${location.origin} 直傳`}</Button>
          {!ok && <span className="text-xs text-amber-600">目前網址尚未加入 CORS。部分服務（例如部分 R2 權杖）不允許用 API 設定，請改到服務商後台設定。</span>}
        </div>
      </CardContent>
    </Card>
  );
}
