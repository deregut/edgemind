import { useEffect, useId, useState } from "react";

let loaded: Promise<typeof import("mermaid").default> | null = null;
function getMermaid() {
  loaded ??= import("mermaid").then((m) => {
    const dark = document.documentElement.classList.contains("dark");
    m.default.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "default" });
    return m.default;
  });
  return loaded;
}

export default function Mermaid({ code }: { code: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    getMermaid()
      .then((m) => m.render(`mmd${id}`, code))
      .then((r) => alive && setSvg(r.svg))
      .catch((e) => alive && setError(String(e?.message ?? e)));
    return () => {
      alive = false;
    };
  }, [code, id]);
  if (error) {
    return (
      <div className="my-3 rounded-lg border border-destructive/40 p-3 text-xs">
        <div className="mb-2 text-destructive">Mermaid 圖表無法繪製：{error.slice(0, 200)}</div>
        <pre className="overflow-x-auto">{code}</pre>
      </div>
    );
  }
  if (!svg) return <div className="my-3 h-24 animate-pulse rounded-lg bg-muted" />;
  return <div className="my-3 flex justify-center overflow-x-auto rounded-lg border bg-white p-3 dark:bg-muted/30" dangerouslySetInnerHTML={{ __html: svg }} />;
}
