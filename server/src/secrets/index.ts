/**
 * Secrets vault (M11a): named values AES-GCM encrypted in the DB (AAD `secret:{id}`), each bound to the hostnames it
 * may be sent to. Only http_request reads values (server-side `{{secret:NAME}}` substitution); the API and the model
 * only ever see names, masked previews and allowed domains.
 */
import { asc, eq, inArray } from "drizzle-orm";
import { normalizeSecretName, parseAllowedDomains, SECRET_NAME_PATTERN, type SecretDTO } from "../../../shared/src/index";
import type { Database } from "../db/client";
import { secrets } from "../db/schema";
import { decryptSecret, encryptSecret, maskSecret } from "../lib/crypto";
import { BadInput } from "../lib/errors";

export type SecretRow = typeof secrets.$inferSelect;

export const SECRET_NAME_RE = SECRET_NAME_PATTERN;
export const SECRET_REF_RE = /\{\{\s*secret:([A-Za-z_][A-Za-z0-9_]{0,63})\s*\}\}/g;
const MAX_VALUE = 16_384;
const MAX_DOMAINS = 50;

export const aadOf = (id: string) => `secret:${id}`;

export function toSecretDTO(r: SecretRow): SecretDTO {
  return {
    id: r.id, name: r.name, preview: r.valuePreview, allowedDomains: r.allowedDomains ?? [], description: r.description,
    createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
  };
}

/**
 * Hostname patterns: `api.example.com`, `*.example.com` (any subdomain depth, not the apex). Lowercased, deduped.
 * URL decoration a user may type (`https://api.e2b.app/`, `api.e2b.app:443`) is stripped; anything else is rejected.
 */
export function normalizeDomains(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) && typeof v !== "string") throw new BadInput("allowedDomains 必須是網域陣列");
  const { domains, errors } = parseAllowedDomains(v);
  if (errors.length) throw new BadInput(errors.join("；"));
  if (domains.length > MAX_DOMAINS) throw new BadInput(`最多 ${MAX_DOMAINS} 個網域`);
  return domains;
}

export function hostAllowed(host: string, patterns: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return patterns.some((p) => (p.startsWith("*.") ? h.endsWith(p.slice(1)) && h.length > p.length - 1 : h === p));
}

/** Same normalization as the settings UI (NFKC, invisible characters removed, trimmed), so the stored name is exactly what the list shows. */
function validateName(v: unknown): string {
  const { name, error } = normalizeSecretName(v);
  if (error) throw new BadInput(error);
  return name;
}

function validateValue(v: unknown): string {
  if (typeof v !== "string" || !v.length) throw new BadInput("請輸入密鑰值");
  if (v.length > MAX_VALUE) throw new BadInput(`密鑰值過長（上限 ${MAX_VALUE} 字元）`);
  if (v.length < 4) throw new BadInput("密鑰值至少 4 個字元（太短的值無法可靠地從回應中遮蔽）");
  return v;
}

export async function listSecrets(database: Database): Promise<SecretRow[]> {
  return database.db.select().from(secrets).orderBy(asc(secrets.name));
}

export async function createSecret(database: Database, key: Uint8Array, body: any): Promise<SecretRow> {
  const name = validateName(body?.name);
  const value = validateValue(body?.value);
  const allowedDomains = normalizeDomains(body?.allowedDomains);
  const description = String(body?.description ?? "").trim().slice(0, 500);
  const [dup] = await database.db.select({ id: secrets.id }).from(secrets).where(eq(secrets.name, name)).limit(1);
  if (dup) throw new BadInput(`已有名為 ${name} 的密鑰`);
  const id = crypto.randomUUID();
  const [row] = await database.db.insert(secrets).values({
    id, name, valueEnc: await encryptSecret(value, key, aadOf(id)), valuePreview: maskSecret(value), allowedDomains, description,
  }).returning();
  return row;
}

export async function updateSecret(database: Database, key: Uint8Array, id: string, body: any): Promise<SecretRow | undefined> {
  const [cur] = await database.db.select().from(secrets).where(eq(secrets.id, id)).limit(1);
  if (!cur) return undefined;
  const patch: Partial<typeof secrets.$inferInsert> = { updatedAt: new Date() };
  if (body?.name !== undefined) {
    const name = validateName(body.name);
    if (name !== cur.name) {
      const [dup] = await database.db.select({ id: secrets.id }).from(secrets).where(eq(secrets.name, name)).limit(1);
      if (dup) throw new BadInput(`已有名為 ${name} 的密鑰`);
    }
    patch.name = name;
  }
  if (body?.value !== undefined && body.value !== "") {
    const value = validateValue(body.value);
    patch.valueEnc = await encryptSecret(value, key, aadOf(id));
    patch.valuePreview = maskSecret(value);
  }
  if (body?.allowedDomains !== undefined) patch.allowedDomains = normalizeDomains(body.allowedDomains);
  if (body?.description !== undefined) patch.description = String(body.description ?? "").trim().slice(0, 500);
  const [row] = await database.db.update(secrets).set(patch).where(eq(secrets.id, id)).returning();
  return row;
}

export async function deleteSecret(database: Database, id: string): Promise<boolean> {
  const r = await database.db.delete(secrets).where(eq(secrets.id, id)).returning({ id: secrets.id });
  return r.length > 0;
}

/** Names referenced as `{{secret:NAME}}` anywhere in `text`. */
export function referencedNames(text: string): string[] {
  return [...new Set([...text.matchAll(SECRET_REF_RE)].map((m) => m[1]))];
}

export interface LoadedSecret {
  name: string;
  value: string;
  allowedDomains: string[];
}

export async function loadSecrets(database: Database, key: Uint8Array, names: string[]): Promise<Map<string, LoadedSecret>> {
  const out = new Map<string, LoadedSecret>();
  if (!names.length) return out;
  const rows = await database.db.select().from(secrets).where(inArray(secrets.name, names));
  for (const r of rows) out.set(r.name, { name: r.name, value: await decryptSecret(r.valueEnc, key, aadOf(r.id)), allowedDomains: r.allowedDomains ?? [] });
  return out;
}

/**
 * Error for `{{secret:NAME}}` references with no saved secret: says plainly whether the vault is EMPTY (nothing was
 * ever saved, or it was saved on another deployment / database) or which names DO exist (a name mismatch), with a
 * case-insensitive near match when there is one.
 */
export async function missingSecretsMessage(database: Database, missing: string[]): Promise<string> {
  const existing = (await database.db.select({ name: secrets.name }).from(secrets).orderBy(asc(secrets.name))).map((r) => r.name);
  const head = `找不到密鑰：${missing.join("、")}`;
  if (!existing.length) {
    return `${head}。「設定 → 密鑰」目前沒有任何已儲存的密鑰（這個部署的資料庫裡是空的）。請使用者到「設定 → 密鑰」按「新增密鑰」，名稱填 ${missing[0]}、貼上值、允許網域填要呼叫的 API 主機，儲存後確認清單中出現它；不要請使用者在對話中貼出密鑰值。`;
  }
  const near = missing.flatMap((m) => existing.filter((e) => e.toLowerCase() === m.toLowerCase() || e.replace(/_/g, "").toLowerCase() === m.replace(/_/g, "").toLowerCase()).map((e) => `${m} → ${e}`));
  const shown = existing.slice(0, 30).join("、") + (existing.length > 30 ? ` 等 ${existing.length} 個` : "");
  return `${head}（名稱需完全相符、區分大小寫）。目前已儲存的密鑰：${shown}${near.length ? `；可能是指：${near.join("、")}` : ""}。請改用上列名稱，或請使用者到「設定 → 密鑰」新增 ${missing.join("、")}。`;
}

/** Hint appended when `host` is refused although a pattern looks like it was meant to cover it. */
export function domainMismatchHint(host: string, patterns: string[]): string {
  const h = host.toLowerCase();
  const parent = patterns.find((p) => !p.startsWith("*.") && h.endsWith(`.${p}`));
  return parent ? `；「${parent}」只比對這個主機本身，要涵蓋 ${host} 請在「設定 → 密鑰」改填 ${host} 或 *.${parent}` : "";
}

/**
 * System-prompt section: the configured secret NAMES + allowed domains (never values), worded so the model knows
 * they are ready to use and how. `httpUnavailable` (why http_request is not offered in this run, e.g. plan mode or a
 * project tool list without it) is stated plainly so the model reports the real reason instead of guessing.
 */
export async function secretsSection(database: Database, opts: { httpUnavailable?: string | null } = {}): Promise<string> {
  const rows = await listSecrets(database);
  if (!rows.length) return "";
  const lines = rows.slice(0, 100).map((r) => {
    const desc = r.description ? `（${r.description.slice(0, 200)}）` : "";
    return r.allowedDomains?.length
      ? `- ${r.name}${desc}：已設定，可以使用；只能送往 ${r.allowedDomains.join("、")}`
      : `- ${r.name}${desc}：值已存好，但尚未設定允許網域，所以目前無法使用。請使用者到「設定 → 密鑰」編輯 ${r.name}，在「允許網域」填入要呼叫的 API 主機（例如 api.example.com）。`;
  });
  const head = [
    "使用者已在「設定 → 密鑰」設定下列密鑰（伺服器端加密保存，立即生效，不需要同步或重新整理）。",
    "使用方式：呼叫 http_request 時在 url、headers、query 或 body 中寫 {{secret:名稱}}（例如標頭 \"X-API-Key\": \"{{secret:E2B_API_KEY}}\"），伺服器會在送出前代入真值。",
    "你看不到真值（回應中出現也會被遮蔽），這是正常的，不代表密鑰讀不到；密鑰也不是環境變數，code_run 等其他工具讀不到，只能透過 http_request 使用。不要請使用者在對話中貼出密鑰值。",
  ];
  if (opts.httpUnavailable) {
    head.push(`注意：本次對話目前無法使用 http_request，原因：${opts.httpUnavailable}。在這之前無法使用任何密鑰；請把這個原因與解決方法如實告訴使用者，不要說成密鑰未同步、讀不到或權限對應問題。`);
  }
  return `${head.join("\n")}\n${lines.join("\n")}`;
}

/** Replace every occurrence of the values (raw, URL-encoded, base64, JSON-escaped) with `[已遮蔽:NAME]`. */
export function makeRedactor(list: { name: string; value: string }[]): (s: string) => string {
  const pairs: [string, string][] = [];
  for (const { name, value } of list) {
    if (!value || value.length < 4) continue;
    const tag = `[已遮蔽:${name}]`;
    const variants = new Set<string>([value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)]);
    try {
      variants.add(btoa(value));
    } catch {
      /* non-latin1 */
    }
    for (const v of variants) if (v.length >= 4) pairs.push([v, tag]);
  }
  pairs.sort((a, b) => b[0].length - a[0].length);
  return (s: string) => {
    let out = s;
    for (const [v, tag] of pairs) if (out.includes(v)) out = out.split(v).join(tag);
    return out;
  };
}
