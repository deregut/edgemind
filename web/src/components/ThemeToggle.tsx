import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme, type Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

const OPTIONS: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: "system", label: "系統", icon: Monitor },
  { value: "light", label: "淺色", icon: Sun },
  { value: "dark", label: "深色", icon: Moon },
];

/**
 * Theme switcher.
 * - `compact` (default): one icon button that cycles 系統 → 淺色 → 深色, with a hover/focus tooltip.
 * - `segmented`: the three options side by side (used on the settings page, where space is not tight).
 */
export function ThemeToggle({ className, variant = "compact", side = "top" }: { className?: string; variant?: "compact" | "segmented"; side?: "top" | "bottom" }) {
  const { theme, setTheme } = useTheme();

  if (variant === "segmented") {
    return (
      <div className={cn("inline-flex rounded-lg bg-muted p-0.5", className)} role="radiogroup" aria-label="主題">
        {OPTIONS.map(({ value, label, icon: Icon }) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={theme === value}
            onClick={() => setTheme(value)}
            className={cn(
              "flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors",
              theme === value && "bg-background text-foreground shadow-sm",
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            <span>{label}</span>
          </button>
        ))}
      </div>
    );
  }

  const idx = Math.max(0, OPTIONS.findIndex((o) => o.value === theme));
  const current = OPTIONS[idx];
  const next = OPTIONS[(idx + 1) % OPTIONS.length];
  const Icon = current.icon;
  const hint = `主題：${current.label}（點擊切換為${next.label}）`;

  return (
    <div className={cn("group relative inline-flex", className)}>
      <button
        type="button"
        onClick={() => setTheme(next.value)}
        aria-label={hint}
        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Icon className="h-4 w-4" />
      </button>
      <span
        role="tooltip"
        className={cn(
          "pointer-events-none absolute z-50 whitespace-nowrap rounded-md bg-foreground px-2 py-1 text-xs text-background opacity-0 shadow-md transition-opacity delay-150 group-hover:opacity-100 group-focus-within:opacity-100",
          side === "top" ? "bottom-full left-1/2 mb-1.5 -translate-x-1/2" : "right-0 top-full mt-1.5",
        )}
      >
        {hint}
      </span>
    </div>
  );
}
