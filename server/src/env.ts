import type { EnvIssue } from "../../shared/src/index";

/** The ONLY configuration read from environment variables. Everything else lives in the DB. */
export interface AppEnv {
  DATABASE_URL: string;
  S3_ENDPOINT: string;
  S3_BUCKET: string;
  S3_REGION: string;
  S3_ACCESS_KEY_ID: string;
  S3_SECRET_ACCESS_KEY: string;
  ENCRYPTION_KEY: string;
  JWT_SECRET: string;
  /** Optional. "true" (default) = path-style `{endpoint}/{bucket}/{key}`; "false" = virtual-hosted `{bucket}.{endpoint host}/{key}`. */
  S3_FORCE_PATH_STYLE?: string;
}

export const ENV_KEYS = [
  "DATABASE_URL", "S3_ENDPOINT", "S3_BUCKET", "S3_REGION",
  "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "ENCRYPTION_KEY", "JWT_SECRET",
] as const satisfies readonly (keyof AppEnv)[];

/** Optional variables (read by the platform adapters, never required). */
export const OPTIONAL_ENV_KEYS = ["S3_FORCE_PATH_STYLE"] as const satisfies readonly (keyof AppEnv)[];

const HINTS: Record<(typeof ENV_KEYS)[number], string> & Partial<Record<keyof AppEnv, string>> = {
  DATABASE_URL: "Neon Postgres 連線字串，例如 postgresql://user:pass@ep-xxx.neon.tech/db?sslmode=require",
  S3_ENDPOINT: "S3 相容端點，例如 https://<account>.r2.cloudflarestorage.com",
  S3_BUCKET: "Bucket 名稱",
  S3_REGION: "區域，例如 auto 或 us-east-1",
  S3_ACCESS_KEY_ID: "S3 Access Key ID",
  S3_SECRET_ACCESS_KEY: "S3 Secret Access Key",
  ENCRYPTION_KEY: "32 位元組金鑰的 base64（產生：openssl rand -base64 32）",
  JWT_SECRET: "至少 32 字元的隨機字串（產生：openssl rand -base64 48）",
};

export function decodeKey32(value: string): Uint8Array | null {
  const v = value.trim();
  if (/^[0-9a-fA-F]{64}$/.test(v)) {
    return Uint8Array.from(v.match(/../g)!.map((h) => parseInt(h, 16)));
  }
  try {
    const bin = atob(v.replace(/-/g, "+").replace(/_/g, "/"));
    if (bin.length !== 32) return null;
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export interface EnvValidation {
  ok: boolean;
  issues: EnvIssue[];
  env?: AppEnv;
}

export function validateEnv(raw: Record<string, unknown>): EnvValidation {
  const issues: EnvIssue[] = [];
  const get = (k: keyof AppEnv) => {
    const v = raw[k];
    return typeof v === "string" ? v.trim() : "";
  };
  for (const k of ENV_KEYS) {
    if (!get(k)) issues.push({ key: k, problem: "missing", hint: HINTS[k] });
  }
  const bad = (k: keyof AppEnv, hint?: string) => issues.push({ key: k, problem: "invalid", hint: hint ?? HINTS[k] ?? "" });
  const db = get("DATABASE_URL");
  if (db && !/^postgres(ql)?:\/\//.test(db)) bad("DATABASE_URL");
  const ep = get("S3_ENDPOINT");
  if (ep && !/^https?:\/\//.test(ep)) bad("S3_ENDPOINT");
  const ek = get("ENCRYPTION_KEY");
  if (ek && !decodeKey32(ek)) bad("ENCRYPTION_KEY", "必須是 32 位元組的 base64 或 64 個十六進位字元（openssl rand -base64 32）");
  const js = get("JWT_SECRET");
  if (js && js.length < 32) bad("JWT_SECRET", "長度至少 32 字元（openssl rand -base64 48）");

  const ps = get("S3_FORCE_PATH_STYLE").toLowerCase();
  if (ps && !["true", "false", "1", "0"].includes(ps)) bad("S3_FORCE_PATH_STYLE", "選填：true（預設，路徑式）或 false（虛擬主機式）");

  if (issues.length) return { ok: false, issues };
  const env = Object.fromEntries(ENV_KEYS.map((k) => [k, get(k)])) as unknown as AppEnv;
  if (ps) env.S3_FORCE_PATH_STYLE = ps;
  return { ok: true, issues: [], env };
}
