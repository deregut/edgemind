import { useCallback, useEffect, useState } from "react";
import type { StatusResponse } from "@edgemind/shared";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { EnvErrorPage } from "@/pages/EnvErrorPage";
import { ThemeToggle } from "@/components/ThemeToggle";

export function App() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setStatus(await api<StatusResponse>("/status"));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (error) return <EnvErrorPage status={{ env: { ok: true, issues: [] }, db: { ok: false, error }, setupRequired: false, authenticated: false, version: "" }} onRetry={load} />;
  if (!status) return <div className="flex min-h-screen items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  if (!status.env.ok || !status.db.ok) return <EnvErrorPage status={status} onRetry={load} />;

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4">
      <h1 className="text-2xl font-semibold">EdgeMind</h1>
      <p className="text-muted-foreground">環境與資料庫已就緒。</p>
      <ThemeToggle />
    </div>
  );
}
