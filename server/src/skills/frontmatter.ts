/**
 * SKILL.md front matter: a small YAML subset parser (no dependency) that covers what Agent Skills use:
 * `key: value` scalars (plain / 'single' / "double" quoted), block scalars (`|`, `>`, with -/+ chomping),
 * nested maps by indentation, `- item` lists, and inline `[a, b]` lists. Anything else is kept as a string.
 */

export interface ParsedSkillMd {
  frontmatter: Record<string, unknown>;
  body: string;
  /** False when the file has no `---` front matter block. */
  hasFrontmatter: boolean;
}

export function splitFrontmatter(text: string): { yaml: string | null; body: string } {
  const t = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!t.startsWith("---\n") && t !== "---") return { yaml: null, body: t };
  const end = t.indexOf("\n---", 3);
  if (end < 0) return { yaml: null, body: t };
  const after = t.indexOf("\n", end + 4);
  const closing = t.slice(end + 1, after < 0 ? undefined : after);
  if (closing.trim() !== "---") return { yaml: null, body: t };
  return { yaml: t.slice(4, end + 1), body: after < 0 ? "" : t.slice(after + 1) };
}

export function parseSkillMd(text: string): ParsedSkillMd {
  const { yaml, body } = splitFrontmatter(text);
  if (yaml === null) return { frontmatter: {}, body, hasFrontmatter: false };
  return { frontmatter: parseYamlSubset(yaml), body, hasFrontmatter: true };
}

function unquote(v: string): string {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      return JSON.parse(v);
    } catch {
      return v.slice(1, -1);
    }
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

function scalar(raw: string): unknown {
  let v = raw.trim();
  // strip trailing comment on unquoted values
  if (!/^["']/.test(v)) v = v.replace(/\s+#.*$/, "");
  if (v === "") return "";
  if (v.startsWith("[") && v.endsWith("]")) {
    const inner = v.slice(1, -1).trim();
    return inner ? inner.split(",").map((s) => scalar(s)) : [];
  }
  if (/^["']/.test(v)) return unquote(v);
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null" || v === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

const indentOf = (l: string) => l.length - l.trimStart().length;

export function parseYamlSubset(yaml: string): Record<string, unknown> {
  const lines = yaml.split("\n");
  let i = 0;

  function block(minIndent: number): unknown {
    // skip blanks/comments
    while (i < lines.length && (!lines[i].trim() || lines[i].trimStart().startsWith("#"))) i++;
    if (i >= lines.length) return null;
    const indent = indentOf(lines[i]);
    if (indent < minIndent) return null;
    if (lines[i].trimStart().startsWith("- ") || lines[i].trim() === "-") {
      const arr: unknown[] = [];
      while (i < lines.length) {
        const l = lines[i];
        if (!l.trim() || l.trimStart().startsWith("#")) { i++; continue; }
        if (indentOf(l) !== indent || !(l.trimStart().startsWith("- ") || l.trim() === "-")) break;
        const rest = l.trimStart().slice(1).trim();
        i++;
        if (!rest) arr.push(block(indent + 1));
        else if (/^[^"'\s][^:]*:\s/.test(rest) || /^[^"'\s][^:]*:$/.test(rest)) {
          // "- key: v" → map item; continuation lines indented deeper
          lines.splice(i, 0, " ".repeat(indent + 2) + rest);
          arr.push(block(indent + 1));
        } else arr.push(scalar(rest));
      }
      return arr;
    }
    const obj: Record<string, unknown> = {};
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim() || l.trimStart().startsWith("#")) { i++; continue; }
      const ind = indentOf(l);
      if (ind < indent) break;
      if (ind > indent) { i++; continue; } // stray deeper line
      const m = /^([^:#]+?)\s*:(?:\s+(.*)|\s*)$/.exec(l.trim());
      i++;
      if (!m) continue;
      const key = unquote(m[1].trim());
      const rest = (m[2] ?? "").trim();
      const bs = /^([|>])([+-]?)\d*\s*(#.*)?$/.exec(rest);
      if (bs) {
        const collected: string[] = [];
        let bIndent = -1;
        while (i < lines.length) {
          const bl = lines[i];
          if (bl.trim() === "") { collected.push(""); i++; continue; }
          const bi = indentOf(bl);
          if (bi <= indent) break;
          if (bIndent < 0) bIndent = bi;
          collected.push(bl.slice(Math.min(bIndent, bi)));
          i++;
        }
        while (collected.length && collected[collected.length - 1] === "" && bs[2] !== "+") collected.pop();
        const text = bs[1] === "|" ? collected.join("\n") : collected.reduce((acc, cur) => (acc === "" ? cur : cur === "" ? acc + "\n" : acc.endsWith("\n") ? acc + cur : acc + " " + cur), "");
        obj[key] = bs[2] === "-" ? text : text + "\n";
        continue;
      }
      if (rest === "") obj[key] = block(indent + 1) ?? "";
      else obj[key] = scalar(rest);
    }
    return obj;
  }

  const out = block(0);
  return out && typeof out === "object" && !Array.isArray(out) ? (out as Record<string, unknown>) : {};
}

const needsQuote = (s: string) => s === "" || /^[\s\-?:,[\]{}#&*!|>'"%@`]|: |\s#|\s$|^(true|false|null|~|-?\d+(\.\d+)?)$/.test(s) || s.includes("\n");

/** Rewrite the name/description of a SKILL.md, keeping every other line as written. */
export function setFrontmatterFields(text: string, fields: { name?: string; description?: string }): string {
  const { yaml, body } = splitFrontmatter(text);
  const fmt = (v: string) => (needsQuote(v) ? JSON.stringify(v) : v);
  if (yaml === null) {
    const head = [`name: ${fmt(fields.name ?? "")}`, `description: ${fmt(fields.description ?? "")}`].join("\n");
    return `---\n${head}\n---\n\n${body.replace(/^\n+/, "")}`;
  }
  const lines = yaml.replace(/\n$/, "").split("\n");
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    const idx = lines.findIndex((l) => new RegExp(`^${k}\\s*:`).test(l));
    if (idx < 0) {
      lines.unshift(`${k}: ${fmt(v)}`);
      continue;
    }
    // drop continuation lines of a block scalar / nested value
    let j = idx + 1;
    while (j < lines.length && (lines[j].trim() === "" || indentOf(lines[j]) > 0)) j++;
    lines.splice(idx, j - idx, `${k}: ${fmt(v)}`);
  }
  return `---\n${lines.join("\n")}\n---\n${body}`;
}
