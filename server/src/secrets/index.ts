/**
 * Secrets vault (M11a): named values AES-GCM encrypted in the DB (AAD `secret:{id}`), each bound to the hostnames it
 * may be sent to. Only http_request reads values (server-side `{{secret:NAME}}` substitution); the API and the model
 * only ever see names, masked previews and allowed domains.
 */
import { asc, eq, inArray } from "drizzle-orm";
import type { SecretDTO } from "../../../shared/src/index";
import type { Database } from "../db/client";
import { secrets } from "../db/schema";
import { decryptSecret, encryptSecret, maskSecret } from "../lib/crypto";
import { BadInput } from "../lib/errors";

export type SecretRow = typeof secrets.$inferSelect;

export const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
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

/** Hostname patterns: `api.example.com`, `*.example.com` (any subdomain depth, not the apex). Lowercased, deduped. */
export function normalizeDomains(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[\s,]+/) : null;
  if (!list) throw new BadInput("allowedDomains 必須是網域陣列");
  const out = new Set<string>();
  for (const raw of list) {
    let d = String(raw ?? "").trim().toLowerCase();
    if (!d) continue;
    d = d.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, "").replace(/\.$/, "");
    const wildcard = d.startsWith("*.");
    const host = wildcard ? d.slice(2) : d;
    if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(host)) throw new BadInput(`無效的網域：${raw}`);
    if (wildcard && !host.includes(".")) throw new BadInput(`萬用字元網域太寬：${raw}（至少要像 *.example.com）`);
    out.add(wildcard ? `*.${host}` : host);
  }
  if (out.size > MAX_DOMAINS) throw new BadInput(`最多 ${MAX_DOMAINS} 個網域`);
  return [...out];
}

export function hostAllowed(host: string, patterns: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return patterns.some((p) => (p.startsWith("*.") ? h.endsWith(p.slice(1)) && h.length > p.length - 1 : h === p));
}

function validateName(v: unknown): string {
  const name = String(v ?? "").trim();
  if (!SECRET_NAME_RE.test(name)) throw new BadInput("名稱只能使用英文字母、數字與底線，且不可以數字開頭（最多 64 字元），例如 E2B_API_KEY");
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

/** System-prompt section: available secret NAMES + allowed domains (never values). */
export async function secretsSection(database: Database): Promise<string> {
  const rows = await listSecrets(database);
  if (!rows.length) return "";
  const lines = rows.slice(0, 100).map((r) => `- ${r.name}${r.allowedDomains?.length ? `（允許網域：${r.allowedDomains.join("、")}）` : "（未設定允許網域，無法使用）"}${r.description ? `：${r.description.slice(0, 200)}` : ""}`);
  return `呼叫 http_request 時可在 url、headers、query、body 中寫 {{secret:名稱}}，伺服器端會替換成密鑰值（你看不到真值，回應中出現也會被遮蔽）；只能送往該密鑰允許的網域。\n${lines.join("\n")}`;
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
