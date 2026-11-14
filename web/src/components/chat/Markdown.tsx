/**
 * Heavy Markdown renderer (react-markdown + GFM + KaTeX + highlight.js). Loaded lazily through
 * `LazyMarkdown` so the main bundle stays small; Mermaid is a further lazy chunk loaded only when a
 * ```mermaid block appears.
 */
import { lazy, memo, Suspense, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import { Check, Copy } from "lucide-react";
import "katex/dist/katex.min.css";
import "./highlight.css";

const Mermaid = lazy(() => import("./Mermaid"));

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in node) return textOf((node as { props: { children?: ReactNode } }).props.children);
  return "";
}

function CodeBlock({ lang, children }: { lang: string; children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const code = textOf(children).replace(/\n$/, "");
  return (
    <div className="group/code relative my-3 overflow-hidden rounded-lg border bg-muted/50">
      <div className="flex items-center justify-between border-b px-3 py-1 text-xs text-muted-foreground">
        <span>{lang || "text"}</span>
        <button
          className="flex items-center gap-1 hover:text-foreground"
          onClick={() => {
            navigator.clipboard.writeText(code).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} {copied ? "已複製" : "複製"}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 text-[13px] leading-relaxed"><code className={`hljs language-${lang}`}>{children}</code></pre>
    </div>
  );
}

function MarkdownImpl({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: true }]]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false }], [rehypeHighlight, { detect: false, ignoreMissing: true }]]}
        components={{
          a: ({ node: _n, ...p }) => <a {...p} target="_blank" rel="noopener noreferrer" />,
          pre: ({ children }) => <>{children}</>,
          code: ({ node: _n, className, children, ...rest }) => {
            const m = /language-([\w+-]+)/.exec(className ?? "");
            const isBlock = !!m || textOf(children).includes("\n");
            if (!isBlock) return <code className="rounded bg-muted px-1 py-0.5 text-[0.9em]" {...rest}>{children}</code>;
            const lang = m?.[1] ?? "";
            if (lang === "mermaid" && !streaming) {
              return (
                <Suspense fallback={<CodeBlock lang="mermaid">{children}</CodeBlock>}>
                  <Mermaid code={textOf(children)} />
                </Suspense>
              );
            }
            return <CodeBlock lang={lang}>{children}</CodeBlock>;
          },
          table: ({ node: _n, ...p }) => <div className="my-3 overflow-x-auto"><table {...p} /></div>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

export default memo(MarkdownImpl);
