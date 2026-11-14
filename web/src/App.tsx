import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import type { StatusResponse } from "@edgemind/shared";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { EnvErrorPage } from "@/pages/EnvErrorPage";
import { AuthPage } from "@/pages/AuthPage";
import { Shell } from "@/components/Shell";
import { ChatPage } from "@/pages/ChatPage";

const ProjectPage = lazy(() => import("@/pages/ProjectPage").then((m) => ({ default: m.ProjectPage })));
const SettingsPage = lazy(() => import("@/pages/settings/SettingsPage").then((m) => ({ default: m.SettingsPage })));
const Spin = () => <div className="flex justify-center p-10"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;

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
    const onUnauthorized = () => load();
    window.addEventListener("em:unauthorized", onUnauthorized);
    return () => window.removeEventListener("em:unauthorized", onUnauthorized);
  }, [load]);

  if (error) {
    return <EnvErrorPage status={{ env: { ok: true, issues: [] }, db: { ok: false, error }, setupRequired: false, authenticated: false, version: "" }} onRetry={load} />;
  }
  if (!status) {
    return <div className="flex min-h-screen items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }
  if (!status.env.ok || !status.db.ok) return <EnvErrorPage status={status} onRetry={load} />;
  if (status.setupRequired) return <AuthPage mode="setup" onDone={load} />;
  if (!status.authenticated) return <AuthPage mode="login" onDone={load} />;

  return (
    <Routes>
      <Route element={<Shell onLogout={load} />}>
        <Route index element={<ChatPage />} />
        <Route path="c/:id" element={<ChatPage />} />
        <Route path="p/:id" element={<Suspense fallback={<Spin />}><ProjectPage /></Suspense>} />
        <Route path="settings" element={<Suspense fallback={<Spin />}><SettingsPage /></Suspense>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
