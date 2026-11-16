/** M11a: code_run (QuickJS server JS + Pyodide browser Python) and the secrets vault. */

export interface SecretDTO {
  id: string;
  name: string;
  /** Masked preview, never the value. */
  preview: string | null;
  allowedDomains: string[];
  description: string;
  createdAt: string;
  updatedAt: string;
}

/** A project file mounted into a client-side (Pyodide) run; the browser fetches it via /api/files/:id/download. */
export interface ClientMount {
  path: string;
  fileId: string;
  size: number;
  mime: string | null;
}

/** Args stored on a pending `client` tool_approvals row (what the browser must execute). */
export interface ClientToolArgs {
  language: "python";
  code: string;
  files?: string[];
  timeoutSec?: number;
  projectId: string | null;
  conversationId: string;
  mounts: ClientMount[];
}

/** Result the browser POSTs to /api/runs/:id/client-results. */
export interface ClientToolResult {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  /** repr() of the last expression, if any. */
  result?: string | null;
  error?: string | null;
  durationMs?: number;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  /** Full output saved as a project file when truncated. */
  fullOutput?: { path: string; fileId: string } | null;
  /** New / changed files uploaded to the project (figures included). */
  files?: { path: string; fileId: string; size: number; kind?: "file" | "figure" }[];
  /** Files produced but not saved (no project / too large). */
  notSaved?: { path: string; reason: string }[];
}

export const CODE_RUN_DEFAULT_TIMEOUT_SEC = 10;
export const CODE_RUN_MAX_TIMEOUT_SEC = 30;
export const PYODIDE_VERSION = "314.0.8";
export const PYODIDE_INDEX_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
/** Per-stream cap on stdout / stderr / return value sent back to the model. */
export const CODE_OUTPUT_CAP = 20_000;
/** Python runs in the browser (the run is paused meanwhile), so it may take longer; package loading is not counted. */
export const PYTHON_DEFAULT_TIMEOUT_SEC = 30;
export const PYTHON_MAX_TIMEOUT_SEC = 120;

/**
 * Parse what a user typed as a secret's allowed domains (shared by the server and the settings UI).
 * Accepts whitespace / comma / 、/ ，/ ；/ ; separated entries and forgives URL decoration: `https://api.e2b.app/`,
 * `api.e2b.app/v2`, `api.e2b.app:443`, `API.E2B.APP.` all become `api.e2b.app`. `*.example.com` covers every
 * subdomain (not the apex). Returns the normalized, deduped hostnames and a 正體中文 error per rejected entry.
 */
export function parseAllowedDomains(input: string | readonly unknown[]): { domains: string[]; errors: string[] } {
  const list = typeof input === "string" ? input.split(/[\s,，、；;]+/) : [...input];
  const out = new Set<string>();
  const errors: string[] = [];
  for (const raw of list) {
    let d = String(raw ?? "").trim().toLowerCase();
    if (!d) continue;
    d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^[^/@]*@/, "").replace(/[/?#].*$/, "").replace(/:\d*$/, "").replace(/\.+$/, "");
    const wildcard = d.startsWith("*.");
    const host = wildcard ? d.slice(2) : d;
    if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(host)) {
      errors.push(`無效的網域：${String(raw).trim()}（請填主機名稱，例如 api.e2b.app 或 *.example.com）`);
      continue;
    }
    if (wildcard && !host.includes(".")) {
      errors.push(`萬用字元網域太寬：${String(raw).trim()}（至少要像 *.example.com）`);
      continue;
    }
    out.add(wildcard ? `*.${host}` : host);
  }
  return { domains: [...out], errors };
}

/** Secret names: ASCII letters, digits and underscore, not starting with a digit, at most 64 characters. */
export const SECRET_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/**
 * Normalize a secret name as typed / pasted (shared by the server and the settings UI so both always agree on the
 * stored name): Unicode NFKC (fullwidth `ＥＲＲ＿ＫＥＹ` → `ERR_KEY`), invisible characters (zero-width space, BOM,
 * soft hyphen, other format characters) removed, surrounding whitespace trimmed. Returns the name plus a 正體中文
 * error when the result is still not a valid name (e.g. `MY-KEY`, `1KEY`, a space inside).
 */
export function normalizeSecretName(input: unknown): { name: string; error: string | null } {
  const name = String(input ?? "").normalize("NFKC").replace(/\p{Cf}/gu, "").trim();
  if (!name) return { name, error: "請輸入名稱，例如 E2B_API_KEY" };
  if (SECRET_NAME_PATTERN.test(name)) return { name, error: null };
  const bad = [...new Set([...name].filter((ch) => !/[A-Za-z0-9_]/.test(ch)))].map((ch) => (/\s/.test(ch) ? "空白" : `「${ch}」`));
  const why = bad.length ? `（不能包含 ${bad.join("、")}）` : /^[0-9]/.test(name) ? "（不可以數字開頭）" : name.length > 64 ? "（超過 64 字元）" : "";
  return { name, error: `名稱只能使用英文字母、數字與底線，且不可以數字開頭（最多 64 字元），例如 E2B_API_KEY${why}` };
}
