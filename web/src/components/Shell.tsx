import { useState } from "react";
import { Outlet } from "react-router-dom";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sidebar } from "@/components/Sidebar";
import { WorkspaceProvider } from "@/lib/workspace";
import { cn } from "@/lib/utils";

export function Shell({ onLogout }: { onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <WorkspaceProvider>
      <div className="flex h-dvh overflow-hidden">
        {/* desktop sidebar */}
        <aside className="hidden w-72 shrink-0 border-r bg-card/50 md:block">
          <Sidebar onLogout={onLogout} />
        </aside>
        {/* mobile drawer */}
        <div className={cn("fixed inset-0 z-40 bg-black/40 md:hidden", open ? "block" : "hidden")} onClick={() => setOpen(false)} />
        <aside className={cn("fixed inset-y-0 left-0 z-50 w-72 border-r bg-background transition-transform md:hidden", open ? "translate-x-0" : "-translate-x-full")}>
          <Sidebar onLogout={onLogout} onNavigate={() => setOpen(false)} />
        </aside>
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2 border-b p-2 md:hidden">
            <Button variant="ghost" size="icon" onClick={() => setOpen(true)} aria-label="開啟選單"><Menu /></Button>
            <span className="font-semibold">EdgeMind</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <Outlet />
          </div>
        </main>
      </div>
    </WorkspaceProvider>
  );
}
