/** WebCrypto-only helpers (Node 20+, Netlify, Cloudflare Workers). */

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function randomToken(n = 32): string {
  return b64encode(randomBytes(n)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function timingSafeEqual(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

// ---------- password hashing: PBKDF2-SHA256 ----------
// Cloudflare Workers' WebCrypto rejects PBKDF2 with more than 100,000 iterations, so that is our cap.
export const PBKDF2_ITERATIONS = 100_000;

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

/** Format: pbkdf2$sha256$<iterations>$<salt b64>$<hash b64> */
export async function hashPassword(password: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const salt = randomBytes(16);
  const hash = await pbkdf2(password, salt, iterations);
  return `pbkdf2$sha256$${iterations}$${b64encode(salt)}$${b64encode(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 5 || parts[0] !== "pbkdf2" || parts[1] !== "sha256") return false;
  const iterations = Number(parts[2]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > PBKDF2_ITERATIONS) return false;
  const hash = await pbkdf2(password, b64decode(parts[3]), iterations);
  return timingSafeEqual(b64encode(hash), parts[4]);
}

// ---------- secrets: AES-256-GCM ----------

const keyCache = new Map<string, Promise<CryptoKey>>();

function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  const id = b64encode(raw);
  let k = keyCache.get(id);
  if (!k) {
    k = crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
    keyCache.set(id, k);
  }
  return k;
}

/** Format: v1.<iv b64>.<ciphertext+tag b64>. `aad` binds the ciphertext to its context. */
export async function encryptSecret(plaintext: string, key: Uint8Array, aad = ""): Promise<string> {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource, additionalData: enc.encode(aad) },
    await importAesKey(key),
    enc.encode(plaintext),
  );
  return `v1.${b64encode(iv)}.${b64encode(new Uint8Array(ct))}`;
}

export async function decryptSecret(payload: string, key: Uint8Array, aad = ""): Promise<string> {
  const [v, iv, ct] = payload.split(".");
  if (v !== "v1" || !iv || !ct) throw new Error("unsupported secret format");
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64decode(iv) as BufferSource, additionalData: enc.encode(aad) },
    await importAesKey(key),
    b64decode(ct) as BufferSource,
  );
  return dec.decode(pt);
}

/** "sk-abcdef123456" -> "sk-a…3456" */
export function maskSecret(s: string): string {
  if (s.length <= 8) return "•".repeat(Math.max(4, s.length));
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}
