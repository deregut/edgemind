/**
 * MCP authorization (OAuth 2.1, MCP spec 2025-06-18):
 *  1. Protected Resource Metadata (RFC 9728): `resource_metadata` from WWW-Authenticate, else
 *     /.well-known/oauth-protected-resource{path} → /.well-known/oauth-protected-resource.
 *     No PRM → the MCP server origin is treated as the authorization server (2025-03-26 behaviour).
 *  2. Authorization Server Metadata (RFC 8414 / OIDC discovery), path-aware, with /authorize /token /register fallbacks.
 *  3. Dynamic Client Registration (RFC 7591) unless the user supplied a client id; public client (PKCE, no secret).
 *  4. Authorization code + PKCE S256 + `resource` (RFC 8707); refresh_token rotation.
 */
import { b64encode, randomToken } from "../lib/crypto";
import { McpError } from "./client";

type Fetch = typeof fetch;

export interface OAuthServerMeta {
  issuer?: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  /** epoch ms */
  expiresAt?: number;
  tokenType?: string;
  scope?: string;
}

export interface OAuthState {
  /** User-supplied or dynamically registered client. */
  clientId?: string;
  clientSecret?: string;
  /** Requested scope (user-supplied, else PRM scopes_supported). */
  scope?: string;
  meta?: OAuthServerMeta;
  resource?: string;
  tokens?: OAuthTokens;
  pending?: { state: string; verifier: string; redirectUri: string; createdAt: number };
}

const b64url = (b: Uint8Array) => b64encode(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge: b64url(digest) };
}

/** Canonical resource URI of the MCP server (RFC 8707): scheme+host lowercase, no fragment, no trailing slash. */
export function canonicalResource(url: string): string {
  const u = new URL(url);
  if (u.pathname === "/" && !u.search) return u.origin;
  const s = `${u.origin}${u.pathname}${u.search}`;
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

export function parseResourceMetadataUrl(wwwAuthenticate: string | null): string | null {
  if (!wwwAuthenticate) return null;
  const m = /resource_metadata="([^"]+)"/i.exec(wwwAuthenticate) ?? /resource_metadata=([^\s,]+)/i.exec(wwwAuthenticate);
  return m ? m[1] : null;
}

async function getJson(fetchFn: Fetch, url: string): Promise<any | null> {
  try {
    const r = await fetchFn(url, { headers: { accept: "application/json", "mcp-protocol-version": "2025-06-18" }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) {
      await r.body?.cancel().catch(() => {});
      return null;
    }
    return await r.json();
  } catch {
    return null;
  }
}

const wellKnown = (base: string, name: string): string[] => {
  const u = new URL(base);
  const path = u.pathname.replace(/\/$/, "");
  const out = [];
  if (path && path !== "/") out.push(`${u.origin}/.well-known/${name}${path}`);
  out.push(`${u.origin}/.well-known/${name}`);
  return out;
};

export async function discover(fetchFn: Fetch, serverUrl: string, wwwAuthenticate: string | null): Promise<{ meta: OAuthServerMeta; resource: string; scopes?: string[] }> {
  let prm: any = null;
  const hinted = parseResourceMetadataUrl(wwwAuthenticate);
  if (hinted) prm = await getJson(fetchFn, new URL(hinted, serverUrl).toString());
  if (!prm) for (const u of wellKnown(serverUrl, "oauth-protected-resource")) if ((prm = await getJson(fetchFn, u))) break;
  const resource = typeof prm?.resource === "string" ? prm.resource : canonicalResource(serverUrl);
  const as: string = Array.isArray(prm?.authorization_servers) && prm.authorization_servers[0] ? prm.authorization_servers[0] : new URL(serverUrl).origin;

  let meta: any = null;
  const asUrl = new URL(as);
  const asPath = asUrl.pathname.replace(/\/$/, "");
  const candidates = asPath && asPath !== "/"
    ? [`${asUrl.origin}/.well-known/oauth-authorization-server${asPath}`, `${asUrl.origin}/.well-known/openid-configuration${asPath}`, `${asUrl.origin}${asPath}/.well-known/openid-configuration`]
    : [`${asUrl.origin}/.well-known/oauth-authorization-server`, `${asUrl.origin}/.well-known/openid-configuration`];
  for (const u of candidates) if ((meta = await getJson(fetchFn, u))) break;
  if (!meta?.authorization_endpoint || !meta?.token_endpoint) {
    meta = { authorization_endpoint: `${asUrl.origin}/authorize`, token_endpoint: `${asUrl.origin}/token`, registration_endpoint: `${asUrl.origin}/register` };
  }
  if (Array.isArray(meta.code_challenge_methods_supported) && !meta.code_challenge_methods_supported.includes("S256"))
    throw new McpError("授權伺服器不支援 PKCE S256，無法安全授權");
  const scopes = Array.isArray(prm?.scopes_supported) ? prm.scopes_supported.filter((s: unknown) => typeof s === "string") : undefined;
  return {
    meta: {
      issuer: meta.issuer, authorization_endpoint: meta.authorization_endpoint, token_endpoint: meta.token_endpoint,
      registration_endpoint: meta.registration_endpoint, scopes_supported: meta.scopes_supported, code_challenge_methods_supported: meta.code_challenge_methods_supported,
    },
    resource,
    scopes,
  };
}

export async function registerClient(fetchFn: Fetch, meta: OAuthServerMeta, redirectUri: string): Promise<{ clientId: string; clientSecret?: string }> {
  if (!meta.registration_endpoint) throw new McpError("授權伺服器不支援動態註冊：請在 MCP 設定填入 Client ID");
  const r = await fetchFn(meta.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: "EdgeMind", redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"], token_endpoint_auth_method: "none",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const j: any = await r.json().catch(() => null);
  if (!r.ok || !j?.client_id) throw new McpError(`動態註冊用戶端失敗（HTTP ${r.status}）${j?.error_description ? `：${j.error_description}` : ""}`);
  return { clientId: j.client_id, clientSecret: j.client_secret || undefined };
}

export async function startAuthorization(fetchFn: Fetch, st: OAuthState, serverUrl: string, redirectUri: string, wwwAuthenticate: string | null): Promise<{ state: OAuthState; authorizeUrl: string }> {
  const d = await discover(fetchFn, serverUrl, wwwAuthenticate);
  const next: OAuthState = { ...st, meta: d.meta, resource: d.resource };
  if (!next.clientId) Object.assign(next, await registerClient(fetchFn, d.meta, redirectUri));
  const { verifier, challenge } = await pkcePair();
  const state = randomToken(24);
  next.pending = { state, verifier, redirectUri, createdAt: Date.now() };
  const scope = next.scope || d.scopes?.join(" ");
  const u = new URL(d.meta.authorization_endpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", next.clientId!);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", state);
  u.searchParams.set("resource", d.resource);
  if (scope) u.searchParams.set("scope", scope);
  return { state: next, authorizeUrl: u.toString() };
}

async function tokenRequest(fetchFn: Fetch, st: OAuthState, form: Record<string, string>): Promise<OAuthTokens> {
  if (!st.meta) throw new McpError("尚未完成授權伺服器探索");
  const body = new URLSearchParams({ ...form, client_id: st.clientId ?? "", ...(st.resource ? { resource: st.resource } : {}) });
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  if (st.clientSecret) headers.authorization = `Basic ${btoa(`${encodeURIComponent(st.clientId ?? "")}:${encodeURIComponent(st.clientSecret)}`)}`;
  const r = await fetchFn(st.meta.token_endpoint, { method: "POST", headers, body: body.toString(), signal: AbortSignal.timeout(15_000) });
  const j: any = await r.json().catch(() => null);
  if (!r.ok || !j?.access_token) throw new McpError(`取得 token 失敗（HTTP ${r.status}）${j?.error ? `：${j.error}${j.error_description ? ` ${j.error_description}` : ""}` : ""}`, r.status);
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token ?? form.refresh_token,
    expiresAt: typeof j.expires_in === "number" ? Date.now() + j.expires_in * 1000 : undefined,
    tokenType: j.token_type,
    scope: j.scope,
  };
}

export async function exchangeCode(fetchFn: Fetch, st: OAuthState, code: string): Promise<OAuthState> {
  if (!st.pending) throw new McpError("沒有進行中的授權");
  if (Date.now() - st.pending.createdAt > 15 * 60_000) throw new McpError("授權逾時，請重新授權");
  const tokens = await tokenRequest(fetchFn, st, { grant_type: "authorization_code", code, redirect_uri: st.pending.redirectUri, code_verifier: st.pending.verifier });
  return { ...st, tokens, pending: undefined };
}

export async function refreshTokens(fetchFn: Fetch, st: OAuthState): Promise<OAuthState> {
  if (!st.tokens?.refreshToken) throw new McpError("沒有 refresh token，請重新授權");
  const tokens = await tokenRequest(fetchFn, st, { grant_type: "refresh_token", refresh_token: st.tokens.refreshToken });
  return { ...st, tokens };
}

export const tokenFresh = (t?: OAuthTokens) => !!t?.accessToken && (!t.expiresAt || t.expiresAt - Date.now() > 60_000);
