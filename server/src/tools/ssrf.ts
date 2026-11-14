/**
 * SSRF guard for model-driven HTTP (web_fetch, later http_request): only http(s), default ports or any
 * port on public hosts, and every resolved address must be public. Hostnames are resolved with
 * DNS-over-HTTPS (edge runtimes have no DNS API); if resolution fails the request is refused (fail closed).
 */
export type Fetch = typeof fetch;

export class BlockedUrlError extends Error {}

function ipv4ToInt(ip: string): number | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const n = m.slice(1).map(Number);
  if (n.some((x) => x > 255)) return null;
  return ((n[0] << 24) | (n[1] << 16) | (n[2] << 8) | n[3]) >>> 0;
}

const V4_BLOCKS: [string, number][] = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];

export function isPrivateIPv4(ip: string): boolean {
  const v = ipv4ToInt(ip);
  if (v === null) return false;
  return V4_BLOCKS.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (v & mask) === (ipv4ToInt(base)! & mask);
  });
}

/** Expand an IPv6 literal to 8 hextets (handles ::, embedded IPv4). Null if not IPv6. */
function expandIPv6(ip: string): number[] | null {
  let s = ip.replace(/^\[|\]$/g, "").toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  if (!s.includes(":")) return null;
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const n = ipv4ToInt(v4[1]);
    if (n === null) return null;
    s = s.slice(0, -v4[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = s.split("::");
  if (s.split("::").length > 2) return null;
  const h = head ? head.split(":") : [];
  const t = tail !== undefined ? (tail ? tail.split(":") : []) : [];
  const fill = tail !== undefined ? 8 - h.length - t.length : 0;
  if (fill < 0) return null;
  const all = [...h, ...Array(fill).fill("0"), ...t];
  if (all.length !== 8 || all.some((x) => !/^[0-9a-f]{1,4}$/.test(x))) return null;
  return all.map((x) => parseInt(x, 16));
}

export function isPrivateIPv6(ip: string): boolean {
  const h = expandIPv6(ip);
  if (!h) return false;
  if (h.every((x) => x === 0)) return true; // ::
  if (h.slice(0, 7).every((x) => x === 0) && h[7] === 1) return true; // ::1
  // IPv4-mapped / compatible / NAT64 → check the embedded IPv4
  const embedded = `${h[6] >> 8}.${h[6] & 255}.${h[7] >> 8}.${h[7] & 255}`;
  if (h.slice(0, 5).every((x) => x === 0) && (h[5] === 0xffff || h[5] === 0)) return isPrivateIPv4(embedded);
  if (h[0] === 0x64 && h[1] === 0xff9b) return isPrivateIPv4(embedded);
  if ((h[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((h[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  if ((h[0] & 0xffc0) === 0xfec0) return true; // site local (deprecated)
  if ((h[0] & 0xff00) === 0xff00) return true; // multicast
  if (h[0] === 0x2001 && h[1] === 0x0db8) return true; // documentation
  return false;
}

export const isIpLiteral = (host: string) => ipv4ToInt(host) !== null || expandIPv6(host) !== null;
export const isPrivateIp = (ip: string) => isPrivateIPv4(ip) || isPrivateIPv6(ip);

const BLOCKED_HOST = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain|home\.arpa)$/i;

/** Synchronous checks on the URL itself (scheme, credentials, literal IPs, obviously internal names). */
export function checkUrlShape(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new BlockedUrlError("網址格式錯誤");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new BlockedUrlError(`不允許的通訊協定：${u.protocol}`);
  if (u.username || u.password) throw new BlockedUrlError("網址不可包含帳號密碼");
  const host = u.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!host) throw new BlockedUrlError("缺少主機名稱");
  if (isIpLiteral(host)) {
    if (isPrivateIp(host)) throw new BlockedUrlError(`禁止連線到內部或保留位址：${host}`);
  } else {
    if (BLOCKED_HOST.test(host) || !host.includes(".")) throw new BlockedUrlError(`禁止連線到內部主機：${host}`);
    // decimal / hex / octal integer hosts ("2130706433", "0x7f000001") are normalized by URL to IPv4 already
  }
  return u;
}

const DOH = ["https://cloudflare-dns.com/dns-query", "https://dns.google/resolve"];

/** Resolve A + AAAA through DNS-over-HTTPS. */
export async function resolveHost(f: Fetch, host: string, signal?: AbortSignal): Promise<string[]> {
  let lastErr: unknown;
  for (const ep of DOH) {
    try {
      const out: string[] = [];
      for (const type of ["A", "AAAA"]) {
        const res = await f(`${ep}?name=${encodeURIComponent(host)}&type=${type}`, { headers: { accept: "application/dns-json" }, signal });
        if (!res.ok) throw new Error(`DoH HTTP ${res.status}`);
        const d = (await res.json()) as { Status?: number; Answer?: { type: number; data: string }[] };
        for (const a of d.Answer ?? []) if (a.type === 1 || a.type === 28) out.push(a.data);
      }
      return out;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new BlockedUrlError(`無法解析主機 ${host}：${(lastErr as Error)?.message ?? "DNS 失敗"}`);
}

/** Full check: URL shape + every resolved address public. */
export async function assertPublicUrl(f: Fetch, raw: string, signal?: AbortSignal): Promise<URL> {
  const u = checkUrlShape(raw);
  const host = u.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (isIpLiteral(host)) return u;
  const ips = await resolveHost(f, host, signal);
  if (!ips.length) throw new BlockedUrlError(`主機 ${host} 沒有 DNS 紀錄`);
  const bad = ips.find(isPrivateIp);
  if (bad) throw new BlockedUrlError(`主機 ${host} 解析到內部位址 ${bad}，已封鎖`);
  return u;
}

/** fetch with manual redirects, re-checking every hop. */
export async function safeFetch(f: Fetch, raw: string, init: RequestInit & { maxRedirects?: number } = {}): Promise<{ res: Response; url: string }> {
  let url = raw;
  for (let hop = 0; hop <= (init.maxRedirects ?? 5); hop++) {
    await assertPublicUrl(f, url, init.signal ?? undefined);
    const res = await f(url, { ...init, redirect: "manual" });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = new URL(res.headers.get("location")!, url).toString();
      await res.body?.cancel().catch(() => {});
      continue;
    }
    return { res, url };
  }
  throw new BlockedUrlError("重新導向次數過多");
}
