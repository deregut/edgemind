/** HTML → readable Markdown: linkedom DOM + Mozilla Readability (main content), then a small DOM → Markdown walker. */
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";

type N = { nodeType: number; nodeName: string; textContent: string | null; childNodes: ArrayLike<N>; getAttribute?(n: string): string | null };

const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "IFRAME", "SVG", "CANVAS", "FORM", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "TEMPLATE", "NAV", "FOOTER"]);

function abs(href: string | null | undefined, base: string): string | null {
  if (!href) return null;
  try {
    const u = new URL(href, base);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

const inlineText = (s: string) => s.replace(/\s+/g, " ");

function children(n: N, base: string, ctx: { list: number }): string {
  let out = "";
  for (let i = 0; i < n.childNodes.length; i++) out += node(n.childNodes[i], base, ctx);
  return out;
}

function node(n: N, base: string, ctx: { list: number }): string {
  if (n.nodeType === 3) return inlineText(n.textContent ?? "");
  if (n.nodeType !== 1) return "";
  const tag = n.nodeName.toUpperCase();
  if (SKIP.has(tag)) return "";
  const inner = () => children(n, base, ctx);
  switch (tag) {
    case "H1": case "H2": case "H3": case "H4": case "H5": case "H6": {
      const t = inner().trim();
      return t ? `\n\n${"#".repeat(Number(tag[1]))} ${t}\n\n` : "";
    }
    case "P": case "SECTION": case "ARTICLE": case "MAIN": case "HEADER": case "FIGURE":
      return `\n\n${inner().trim()}\n\n`;
    case "DIV":
      return `\n${inner()}\n`;
    case "BR":
      return "  \n";
    case "HR":
      return "\n\n---\n\n";
    case "STRONG": case "B": {
      const t = inner().trim();
      return t ? `**${t}**` : "";
    }
    case "EM": case "I": {
      const t = inner().trim();
      return t ? `*${t}*` : "";
    }
    case "CODE":
      return `\`${(n.textContent ?? "").replace(/`/g, "\\`")}\``;
    case "PRE":
      return `\n\n\`\`\`\n${(n.textContent ?? "").replace(/\n+$/, "")}\n\`\`\`\n\n`;
    case "BLOCKQUOTE":
      return `\n\n${inner().trim().split("\n").map((l) => `> ${l}`).join("\n")}\n\n`;
    case "A": {
      const t = inner().trim();
      const href = abs(n.getAttribute?.("href"), base);
      return href && t ? `[${t}](${href})` : t;
    }
    case "IMG": {
      const alt = n.getAttribute?.("alt")?.trim();
      const src = abs(n.getAttribute?.("src"), base);
      return alt && src ? `![${alt}](${src})` : "";
    }
    case "UL": case "OL": {
      ctx.list++;
      let i = 0;
      let out = "\n";
      for (let k = 0; k < n.childNodes.length; k++) {
        const c = n.childNodes[k];
        if (c.nodeType === 1 && c.nodeName.toUpperCase() === "LI") {
          i++;
          const body = children(c, base, ctx).trim().replace(/\n+/g, `\n${"  ".repeat(ctx.list)}`);
          out += `${"  ".repeat(ctx.list - 1)}${tag === "OL" ? `${i}.` : "-"} ${body}\n`;
        }
      }
      ctx.list--;
      return `${out}\n`;
    }
    case "TABLE": {
      const rows: string[][] = [];
      const walk = (x: N) => {
        for (let k = 0; k < x.childNodes.length; k++) {
          const c = x.childNodes[k];
          if (c.nodeType !== 1) continue;
          const t = c.nodeName.toUpperCase();
          if (t === "TR") {
            const cells: string[] = [];
            for (let j = 0; j < c.childNodes.length; j++) {
              const td = c.childNodes[j];
              if (td.nodeType === 1 && /^(TD|TH)$/i.test(td.nodeName)) cells.push(children(td, base, ctx).trim().replace(/\|/g, "\\|").replace(/\n+/g, " "));
            }
            if (cells.length) rows.push(cells);
          } else walk(c);
        }
      };
      walk(n);
      if (!rows.length) return "";
      const w = Math.max(...rows.map((r) => r.length));
      const line = (r: string[]) => `| ${[...r, ...Array(w - r.length).fill("")].join(" | ")} |`;
      return `\n\n${line(rows[0])}\n| ${Array(w).fill("---").join(" | ")} |\n${rows.slice(1).map(line).join("\n")}\n\n`;
    }
    default:
      return inner();
  }
}

export function domToMarkdown(root: N, base: string): string {
  return children(root, base, { list: 0 })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function htmlToMarkdown(html: string, url: string): { title: string; markdown: string } {
  const { document } = parseHTML(html);
  const title = (document.querySelector("title")?.textContent ?? "").trim();
  let article: { title?: string | null; content?: string | null } | null = null;
  try {
    article = new Readability(document.cloneNode(true) as unknown as Document, { charThreshold: 200 }).parse();
  } catch {
    article = null;
  }
  if (article?.content) {
    const { document: d2 } = parseHTML(`<!doctype html><html><body>${article.content}</body></html>`);
    const md = domToMarkdown(d2.body as unknown as N, url);
    if (md.length > 200) return { title: article.title?.trim() || title, markdown: md };
  }
  return { title, markdown: domToMarkdown((document.body ?? document.documentElement) as unknown as N, url) };
}
