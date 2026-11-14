/** Minimal glob → RegExp: `**` (any depth), `*` (no slash), `?`, `{a,b}`. Paths are normalized (no leading ./ or /). */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  let inBrace = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      inBrace++;
      re += "(?:";
    } else if (c === "}" && inBrace) {
      inBrace--;
      re += ")";
    } else if (c === "," && inBrace) re += "|";
    else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export function normalizePath(p: string): string {
  const parts: string[] = [];
  for (const seg of p.replace(/\\/g, "/").split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

export function matchGlob(path: string, globs: string | string[]): boolean {
  const p = normalizePath(path);
  return (Array.isArray(globs) ? globs : [globs]).some((g) => globToRegExp(normalizePath(g) || g).test(p));
}

/** Domain allowlist entry: exact host, or "*.example.com" (subdomains and the apex). */
export function matchDomain(host: string, patterns: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return patterns.some((raw) => {
    const p = raw.toLowerCase().trim();
    if (p.startsWith("*.")) {
      const base = p.slice(2);
      return h === base || h.endsWith(`.${base}`);
    }
    return h === p;
  });
}

/** Tool-name pattern: exact, "*", or with "*" wildcards (e.g. "file_*", "mcp:github/*"). Returns specificity or -1. */
export function toolNameSpecificity(pattern: string, name: string): number {
  if (pattern === name) return 2;
  if (pattern === "*") return 0;
  if (!pattern.includes("*")) return -1;
  const re = new RegExp(`^${pattern.split("*").map((s) => s.replace(/[.+?^$(){}|[\]\\/]/g, "\\$&")).join(".*")}$`);
  return re.test(name) ? 1 : -1;
}
