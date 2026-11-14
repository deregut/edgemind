import { NavLink, Outlet } from "react-router-dom";
import { MessageSquare, Settings, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/ThemeToggle";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/", label: "聊天", icon: MessageSquare, end: true },
  { to: "/settings", label: "設定", icon: Settings, end: false },
];

export function Shell({ onLogout }: { onLogout: () => void }) {
  async function logout() {
    await api("/auth/logout", { method: "POST" }).catch(() => {});
    onLogout();
  }
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="flex shrink-0 items-center gap-2 border-b bg-card/50 p-3 md:w-56 md:flex-col md:items-stretch md:border-b-0 md:border-r">
        <div className="flex items-center gap-2 px-2 py-1 font-semibold">
          <img src="/favicon.svg" alt="" className="h-6 w-6" /> EdgeMind
        </div>
        <nav className="flex flex-1 gap-1 md:mt-4 md:flex-col">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn("flex items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground", isActive && "bg-accent font-medium text-accent-foreground")
              }
            >
              <Icon className="h-4 w-4" /> <span className="hidden sm:inline">{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="flex items-center gap-2 md:flex-col md:items-stretch">
          <ThemeToggle />
          <Button variant="ghost" size="sm" onClick={logout} className="justify-start">
            <LogOut /> <span className="hidden sm:inline">登出</span>
          </Button>
        </div>
      </aside>
      <main className="min-w-0 flex-1">
        <Outlet />
      </main>
    </div>
  );
}
