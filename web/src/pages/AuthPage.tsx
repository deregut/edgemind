import { useState, type FormEvent } from "react";
import { Loader2, LockKeyhole } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ThemeToggle } from "@/components/ThemeToggle";
import { api } from "@/lib/api";

const MIN = 10;

export function AuthPage({ mode, onDone }: { mode: "setup" | "login"; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const setup = mode === "setup";

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (setup) {
      if (password.length < MIN) return setError(`密碼至少需要 ${MIN} 個字元`);
      if (password !== confirm) return setError("兩次輸入的密碼不一致");
    }
    setBusy(true);
    try {
      await api(setup ? "/auth/setup" : "/auth/login", { method: "POST", body: { password } });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-gradient-to-br from-indigo-500/10 via-background to-violet-500/10 p-4">
      <ThemeToggle className="absolute right-4 top-4" side="bottom" />
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-500 text-white">
            <LockKeyhole className="h-6 w-6" />
          </div>
          <CardTitle className="text-xl">{setup ? "歡迎使用 EdgeMind" : "登入 EdgeMind"}</CardTitle>
          <CardDescription>{setup ? "首次啟動：請設定管理密碼。這是單人自用系統，之後只需輸入這組密碼即可登入。" : "請輸入管理密碼"}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="pw">密碼</Label>
              <Input id="pw" type="password" autoComplete={setup ? "new-password" : "current-password"} autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            {setup && (
              <div className="space-y-2">
                <Label htmlFor="pw2">再次輸入密碼</Label>
                <Input id="pw2" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
                <p className="text-xs text-muted-foreground">至少 {MIN} 個字元。</p>
              </div>
            )}
            {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
            <Button type="submit" className="w-full" disabled={busy || !password}>
              {busy && <Loader2 className="animate-spin" />}
              {setup ? "設定密碼並開始" : "登入"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
