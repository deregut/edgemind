import { Link } from "react-router-dom";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ChatPlaceholder() {
  return (
    <div className="flex h-full min-h-[60vh] flex-col items-center justify-center gap-4 p-6 text-center">
      <Sparkles className="h-10 w-10 text-primary" />
      <h1 className="text-2xl font-semibold">聊天功能即將推出</h1>
      <p className="max-w-md text-muted-foreground">請先到設定新增至少一個語言模型供應商並測試連線，聊天與 Agent 功能完成後即可直接使用。</p>
      <Button asChild>
        <Link to="/settings">前往供應商設定</Link>
      </Button>
    </div>
  );
}
