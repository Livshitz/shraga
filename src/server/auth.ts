import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { randomBytes, timingSafeEqual, createHmac, scryptSync } from 'node:crypto';
import { join } from 'node:path';
import type { Request, Response, NextFunction } from 'express';

// JwtHelper is not exported from the main edge.libx.js entry, import from build directly
import { JwtHelper } from 'edge.libx.js/build/helpers/jwt.js';

// Cache Google JWKS keys — avoids ~300ms fetch per token verification
const _jwksCache = { keys: new Map<string, any>(), expiresAt: 0 };
const _jwksInflight = new Map<string, Promise<any>>();
const JWKS_TTL = 3600_000;
// getGooglePublicKey is declared private on JwtHelper; we monkey-patch it (JS allows this
// at runtime). Bracket access asserts the type without altering behavior.
const _origGetKey = (JwtHelper as any)['getGooglePublicKey'].bind(JwtHelper);
(JwtHelper as any)['getGooglePublicKey'] = async function (kid: string) {
  if (_jwksCache.keys.has(kid) && Date.now() < _jwksCache.expiresAt) return _jwksCache.keys.get(kid);
  if (_jwksInflight.has(kid)) return _jwksInflight.get(kid);
  const p = _origGetKey(kid).then((key: any) => {
    if (key) { _jwksCache.keys.set(kid, key); _jwksCache.expiresAt = Date.now() + JWKS_TTL; }
    _jwksInflight.delete(kid);
    return key;
  }, (err: any) => {
    _jwksInflight.delete(kid);
    throw err;
  });
  _jwksInflight.set(kid, p);
  return p;
};
import { dataPath } from './paths.ts';
import { apiKeyPrincipal, validateApiKey } from './api-keys.ts';
import { isOwnerEmail } from './owners.ts';
import { fromAuthUser, fromInternal, type Principal } from './security/principal.ts';
import { loginAllowed, security } from './security/runtime.ts';
import { firebaseIssuedAt, tokenRevoked } from './security/revocation.ts';

// Issued-at (`iat`) + revocation: every token format below carries `iat` for NEW tokens, in a shape the pre-iat
// verifier REJECTS (never mis-parses into a different identity) — so for these tokens a rollback only forces re-auth.
// API keys are NOT covered: pre-hashing code breaks on hashed entries, so a rollback invalidates every key (see the
// Rollback note in api-keys.ts). Old tokens
// without iat still verify here, with an implied iat (see security/revocation.ts). Checked against
// policy.tokensValidAfter for the token's principal: an in-memory lookup, no I/O.
const nowSec = () => Math.floor(Date.now() / 1000);
const hmacEq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const userPrincipalId = (uid: string, email: string) => fromAuthUser({ uid, email }).id;

/** Fixed TTLs (seconds). Legacy tokens without iat are treated as issued at `exp - TTL`. */
export const MCP_TOKEN_TTL = { access: 3600, refresh: 60 * 60 * 24 * 30 } as const;
export const LOCAL_TOKEN_TTL = 30 * 24 * 3600;

/** Server secret for signing scoped internal tokens — stable per startup. */
const INTERNAL_SECRET = process.env.INTERNAL_API_TOKEN || randomBytes(32).toString('hex');
process.env.INTERNAL_API_TOKEN = INTERNAL_SECRET;
/** Publish this process's secret to `<app>/.tmp/.internal-token`. SERVER ONLY — called from boot.
 *  It used to run at import time, so any process importing auth.ts (e.g. the `shraga para post` CLI) overwrote
 *  the live server's token with its own throwaway secret, and every token signed from the file then 401'd
 *  (feedox 2026-09-23). */
export function publishInternalToken(): void {
  const tmpDir = join(dataPath('..'), '.tmp');
  try { mkdirSync(tmpDir, { recursive: true }); writeFileSync(join(tmpDir, '.internal-token'), INTERNAL_SECRET); } catch (e: any) { console.error('[auth] failed to write .internal-token:', e.message); }
}

/** Sign a scoped internal token embedding user identity. Agent subprocess uses this as INTERNAL_API_TOKEN — single env var carries both auth + identity.
 *  Format `<sig64>.<iat>:<uid>:<email>`, sig = HMAC("v2:<iat>:<uid>:<email>"). (Legacy: `<sig64>:<uid>:<email>`, no iat.) */
export function signInternalToken(uid: string, email: string): string {
  const rest = `${nowSec()}:${uid}:${email}`;
  const sig = createHmac('sha256', INTERNAL_SECRET).update(`v2:${rest}`).digest('hex');
  return `${sig}.${rest}`;
}

/** Verify and extract user identity from a scoped internal token. Falls back to legacy global token check.
 *  Revocation: rejected if issued before tokensValidAfter of `internal:<uid>` or of the user it acts for. */
function verifyInternalToken(token: string): { uid: string; email: string } | null {
  const scoped = (uid: string, email: string, iat: number) =>
    tokenRevoked([fromInternal({ uid }).id, userPrincipalId(uid, email)], iat) ? null : { uid, email };
  if (token[64] === '.') {
    const rest = token.slice(65);
    if (!hmacEq(token.slice(0, 64), createHmac('sha256', INTERNAL_SECRET).update(`v2:${rest}`).digest('hex'))) return null;
    const [iatStr, uid, ...emailParts] = rest.split(':');
    const iat = Number(iatStr);
    if (!Number.isInteger(iat) || !uid || !emailParts.length) return null;
    return scoped(uid, emailParts.join(':'), iat);
  }
  const firstColon = token.indexOf(':');
  if (firstColon === 64) {
    const sig = token.slice(0, 64);
    const payload = token.slice(65);
    const expected = createHmac('sha256', INTERNAL_SECRET).update(payload).digest('hex');
    if (hmacEq(sig, expected)) {
      const sepIdx = payload.indexOf(':');
      // Legacy scoped token: no exp, no iat ⇒ issued at 0, so any revocation of the principal kills it.
      if (sepIdx > 0) return scoped(payload.slice(0, sepIdx), payload.slice(sepIdx + 1), 0);
    }
    return null;
  }
  // Legacy: plain global token (backwards compat for old agents / direct curl)
  if (token.length === INTERNAL_SECRET.length && timingSafeEqual(Buffer.from(token), Buffer.from(INTERNAL_SECRET))) {
    return { uid: 'agent-internal', email: 'agent@internal' };
  }
  return null;
}

/**
 * Persisted secret for signing MCP OAuth tokens. Unlike INTERNAL_SECRET (random per boot
 * unless INTERNAL_API_TOKEN is set), this is stored in data/ so issued access/refresh tokens
 * survive restarts/deploys — otherwise every restart would force claude.ai users to re-auth.
 */
let mcpSecret: string | null = null;
function getMcpSecret(): string {
  if (mcpSecret) return mcpSecret;
  const p = dataPath('.mcp-oauth-secret');
  try {
    if (existsSync(p)) {
      const s = readFileSync(p, 'utf8').trim();
      if (s) return (mcpSecret = s);
    }
    mcpSecret = randomBytes(32).toString('hex');
    writeFileSync(p, mcpSecret, { mode: 0o600 });
  } catch (e: any) {
    console.error('[auth] mcp-oauth secret persist failed, falling back to INTERNAL_SECRET:', e.message);
    mcpSecret = INTERNAL_SECRET;
  }
  return mcpSecret;
}

/**
 * Stateless OAuth access/refresh tokens for the MCP endpoint, signed with a persisted secret.
 * Provider-agnostic: identity is established upstream by requireAuth (Firebase today,
 * email-password later) — this only carries the resulting {uid, email}. No storage needed.
 */
/** Payload `mcp2:kind:uid:email:iat:exp`. (Legacy `mcp:kind:uid:email:exp` — the pre-iat verifier rejects `mcp2`.) */
export function signMcpToken(uid: string, email: string, kind: 'access' | 'refresh' = 'access', ttlSec: number = MCP_TOKEN_TTL[kind]): string {
  const iat = nowSec();
  const payload = `mcp2:${kind}:${uid}:${email}:${iat}:${iat + ttlSec}`;
  const sig = createHmac('sha256', getMcpSecret()).update(payload).digest('hex');
  return `mcp_${sig}.${Buffer.from(payload).toString('base64url')}`;
}

export function verifyMcpToken(token: string): { uid: string; email: string; kind: 'access' | 'refresh' } | null {
  if (!token.startsWith('mcp_')) return null;
  const body = token.slice(4);
  const dot = body.indexOf('.');
  if (dot < 0) return null;
  const sig = body.slice(0, dot);
  let payload: string;
  try { payload = Buffer.from(body.slice(dot + 1), 'base64url').toString(); } catch { return null; }
  const expected = createHmac('sha256', getMcpSecret()).update(payload).digest('hex');
  if (!hmacEq(sig, expected)) return null;
  const parts = payload.split(':'); // tag:kind:uid:email[:iat]:exp  (uid never contains ':')
  const v2 = parts[0] === 'mcp2';
  if (!(v2 || parts[0] === 'mcp') || parts.length < (v2 ? 6 : 5)) return null;
  const kind = parts[1];
  if (kind !== 'access' && kind !== 'refresh') return null;
  const exp = Number(parts[parts.length - 1]);
  if (!exp || nowSec() > exp) return null;
  const iat = v2 ? Number(parts[parts.length - 2]) : exp - MCP_TOKEN_TTL[kind];
  if (!Number.isInteger(iat)) return null;
  const uid = parts[2], email = parts.slice(3, parts.length - (v2 ? 2 : 1)).join(':');
  if (tokenRevoked(userPrincipalId(uid, email), iat)) return null;
  return { kind, uid, email };
}

export interface AuthUser {
  uid: string;
  email: string;
  /** Owners can see all sessions/schedules across users (view-only bypass — mutations still restricted to owner of record). */
  isOwner: boolean;
  /** Who is calling, per auth branch (login → user, api key → apikey, internal token → internal). */
  principal: Principal;
}

// Owner comes from an interactive login, a server-minted scoped internal token acting for one, or an UNCAPPED API key
// (a delegated login credential — only an interactive login can mint a key, e.g. `shraga term`'s /cli-auth consent).
// A role-capped key is never owner. OWNERS is read per call, so removing the creator takes effect on the next request.
const ownerCapable = (p: Principal) => p.kind === 'user' || p.kind === 'internal' || (p.kind === 'apikey' && typeof p.attrs.role !== 'string');
const authUser = (uid: string, email: string, principal: Principal): AuthUser => ({
  uid, email, principal, isOwner: ownerCapable(principal) && isOwnerEmail(email),
});
const internalUser = (t: { uid: string; email: string }) => authUser(t.uid, t.email, fromInternal(t));
const apiKeyUser = (k: { id: string; uid: string; email: string; role?: string }) => authUser(k.uid, k.email, apiKeyPrincipal(k));

// ── Attributing a rejection ──────────────────────────────────────────────────
// A token can be CRYPTOGRAPHICALLY valid and still be refused (not in the policy bindings, revoked). The identity is
// known at that moment but was thrown away with the error, so `auth.deny` landed in the audit with no principal and
// Owner Console → Principals never showed the person who was turned away. Carry it on the error instead.
const DENIED = Symbol.for('shraga.deniedPrincipal');
/** Tag an auth error with the identity it rejected. */
export function deniedPrincipal<E extends Error>(err: E, principal: Principal): E {
  (err as any)[DENIED] = principal;
  return err;
}
/** The identity an auth error rejected, if it carries one. */
export function deniedPrincipalOf(err: unknown): Principal | undefined {
  const p = (err as any)?.[DENIED];
  return p && typeof p === 'object' && typeof p.id === 'string' ? (p as Principal) : undefined;
}

export async function verifyToken(token: string): Promise<AuthUser> {
  const projectId = JSON.parse(process.env.FIREBASE_CONFIG_PROD ?? process.env.VITE_FIREBASE_CONFIG_PROD ?? '{}').projectId;
  if (!projectId) throw new Error('FIREBASE_CONFIG_PROD not set or missing projectId');
  let payload: any;
  try {
    payload = await JwtHelper.verifyFirebaseToken(token, projectId);
  } catch (err: any) {
    const msg = typeof err === 'string' ? err : err?.message ?? String(err);
    if (msg.includes('aud')) throw new Error(`Token audience mismatch (expected ${projectId}). Please sign out and sign in again.`);
    throw new Error(msg);
  }
  const uid = payload.user_id || payload.sub;
  const principal = fromAuthUser({ uid, email: payload.email });
  // Login gate = policy bindings (member rank+) or OWNERS; fails closed. The message keeps the word 'whitelist':
  // the client (App.tsx, useAgentSocket, lib/ws) keys its permanent "not allowed" handling on it.
  // The rejected identity rides on the error so the caller can audit WHO was denied (auth.deny is otherwise anonymous).
  if (!loginAllowed(principal)) throw deniedPrincipal(new Error('User not in whitelist — ask an owner to add a binding (Owner Console → Bindings)'), principal);
  // auth_time = sign-in time; the hourly-refreshed iat would outlive a revocation.
  if (tokenRevoked(principal.id, firebaseIssuedAt(payload))) throw deniedPrincipal(new Error('Token revoked — sign in again'), principal);
  return authUser(uid, payload.email, principal);
}

// ── Pluggable auth provider ──────────────────────────────────────────────────
// Default = 'local' (username/password, zero external deps — a dev can install and run
// with no Firebase). Set AUTH_PROVIDER=firebase (an optional add-on) to verify Firebase
// ID tokens instead. The provider only turns a bearer token into an AuthUser; api-key and
// internal-token auth are provider-agnostic.
export const AUTH_PROVIDER = (process.env.AUTH_PROVIDER || 'local').toLowerCase();

interface LocalUser { email: string; salt: string; hash: string }
const USERS_PATH = () => dataPath('users.json');
function loadLocalUsers(): LocalUser[] {
  try { return existsSync(USERS_PATH()) ? JSON.parse(readFileSync(USERS_PATH(), 'utf-8')) : []; }
  catch (e: any) { console.error('[auth] users.json unreadable:', e.message); return []; }
}
function hashPw(password: string, salt = randomBytes(16).toString('hex')) {
  return { salt, hash: scryptSync(password, salt, 64).toString('hex') };
}
/** Create a local user (used by `shraga user add` and first-run /api/auth/register). */
export function addLocalUser(email: string, password: string): void {
  const users = loadLocalUsers();
  if (users.some((u) => u.email === email)) throw new Error(`user ${email} already exists`);
  users.push({ email, ...hashPw(password) });
  writeFileSync(USERS_PATH(), JSON.stringify(users, null, 2));
}
export function localUserCount(): number { return loadLocalUsers().length; }

// Persisted secret so local session tokens survive restarts.
let _localSecret: string | null = null;
function localSecret(): string {
  if (_localSecret) return _localSecret;
  const p = dataPath('.local-auth-secret');
  try {
    if (existsSync(p)) return (_localSecret = readFileSync(p, 'utf8').trim());
    _localSecret = randomBytes(32).toString('hex');
    writeFileSync(p, _localSecret, { mode: 0o600 });
  } catch { _localSecret = INTERNAL_SECRET; }
  return _localSecret;
}
/** Issue a signed local session token: sha_<sig>.<base64url(email:iat:exp)>, sig = HMAC("v2:" + payload).
 *  (Legacy: payload `email:exp`, sig over the payload alone — the "v2:" domain separation makes the pre-iat verifier
 *  reject new tokens instead of reading `email:iat` as the email.) */
export function localLogin(email: string, password: string): string | null {
  const rec = loadLocalUsers().find((u) => u.email === email);
  if (!rec) return null;
  const { hash } = hashPw(password, rec.salt);
  if (hash.length !== rec.hash.length || !timingSafeEqual(Buffer.from(hash), Buffer.from(rec.hash))) return null;
  const iat = nowSec();
  const payload = `${email}:${iat}:${iat + LOCAL_TOKEN_TTL}`;
  const sig = createHmac('sha256', localSecret()).update(`v2:${payload}`).digest('hex');
  return `sha_${sig}.${Buffer.from(payload).toString('base64url')}`;
}
function verifyLocalToken(token: string): AuthUser {
  if (!token.startsWith('sha_')) throw new Error('Invalid session token');
  const body = token.slice(4);
  const dot = body.indexOf('.');
  if (dot < 0) throw new Error('Malformed token');
  const sig = body.slice(0, dot);
  const payload = Buffer.from(body.slice(dot + 1), 'base64url').toString();
  const v2 = hmacEq(sig, createHmac('sha256', localSecret()).update(`v2:${payload}`).digest('hex'));
  if (!v2 && !hmacEq(sig, createHmac('sha256', localSecret()).update(payload).digest('hex'))) throw new Error('Bad token signature');
  const sep = payload.lastIndexOf(':');
  const exp = Number(payload.slice(sep + 1));
  let head = payload.slice(0, sep), iat = exp - LOCAL_TOKEN_TTL;
  if (v2) { const s = head.lastIndexOf(':'); iat = Number(head.slice(s + 1)); head = head.slice(0, s); }
  const email = head;
  if (!Number.isFinite(exp) || nowSec() > exp) throw new Error('Token expired — sign in again');
  const principal = fromAuthUser({ uid: email, email });
  if (!Number.isInteger(iat)) throw new Error('Malformed token');
  if (tokenRevoked(principal.id, iat)) throw deniedPrincipal(new Error('Token revoked — sign in again'), principal);
  return authUser(email, email, principal);
}

/** Dispatch bearer verification to the active provider. */
export async function verifyBearer(token: string): Promise<AuthUser> {
  return AUTH_PROVIDER === 'firebase' ? verifyToken(token) : verifyLocalToken(token);
}

/** Verify a raw token (api-key `uck_…`, scoped internal token, or provider bearer) → AuthUser, or null.
 * The token-only half of `requireAuth`, for callers with no Express req/res — notably the WebSocket
 * upgrade path, where the token arrives in the handshake instead of an Authorization header. */
export async function authenticateToken(token: string | undefined | null): Promise<AuthUser | null> {
  if (!token) return null;
  if (token.startsWith('uck_')) {
    const identity = validateApiKey(token);
    return identity ? apiKeyUser(identity) : null;
  }
  const internal = verifyInternalToken(token);
  if (internal) return internalUser(internal);
  try { return await verifyBearer(token); } catch { return null; }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const internalToken = req.headers['x-internal-token'] as string | undefined;
  if (internalToken) {
    const identity = verifyInternalToken(internalToken);
    if (identity) {
      const user = internalUser(identity);
      (req as any).user = user;
      security()?.authAllow(user.principal, 'http:internal');
      return next();
    }
  }

  const token = req.headers.authorization?.replace('Bearer ', '') || (req.query.token as string);
  if (!token) {
    security()?.authDeny('http', 'missing-token', req.ip);
    return void res.status(401).json({ error: 'Missing token' });
  }

  // API key auth (uck_…)
  if (token.startsWith('uck_')) {
    const identity = validateApiKey(token);
    if (!identity) {
      security()?.authDeny('http:apikey', 'invalid-api-key', req.ip);
      return void res.status(401).json({ error: 'Invalid API key' });
    }
    const user = apiKeyUser(identity);
    (req as any).user = user;
    security()?.authAllow(user.principal, 'http:apikey');
    return next();
  }

  let user: AuthUser;
  try {
    user = await verifyBearer(token);
  } catch (err: any) {
    const whitelisted = err?.message?.includes('whitelist');
    const reason = whitelisted ? 'not-whitelisted' : err?.message?.includes('revoked') ? 'token-revoked' : 'invalid-bearer';
    security()?.authDeny('http:bearer', reason, req.ip, deniedPrincipalOf(err));
    return void res.status(whitelisted ? 403 : 401).json({ error: err.message });
  }
  (req as any).user = user;
  security()?.authAllow(user.principal, 'http:bearer');
  next();
}
