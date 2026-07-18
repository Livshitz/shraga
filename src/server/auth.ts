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
import { validateApiKey } from './api-keys.ts';

/** Server secret for signing scoped internal tokens — stable per startup. */
const INTERNAL_SECRET = process.env.INTERNAL_API_TOKEN || randomBytes(32).toString('hex');
process.env.INTERNAL_API_TOKEN = INTERNAL_SECRET;
const tmpDir = join(dataPath('..'), '.tmp');
try { mkdirSync(tmpDir, { recursive: true }); writeFileSync(join(tmpDir, '.internal-token'), INTERNAL_SECRET); } catch (e: any) { console.error('[auth] failed to write .internal-token:', e.message); }

/** Sign a scoped internal token embedding user identity. Agent subprocess uses this as INTERNAL_API_TOKEN — single env var carries both auth + identity. */
export function signInternalToken(uid: string, email: string): string {
  const payload = `${uid}:${email}`;
  const sig = createHmac('sha256', INTERNAL_SECRET).update(payload).digest('hex');
  return `${sig}:${payload}`;
}

/** Verify and extract user identity from a scoped internal token. Falls back to legacy global token check. */
function verifyInternalToken(token: string): { uid: string; email: string } | null {
  const firstColon = token.indexOf(':');
  if (firstColon === 64) {
    const sig = token.slice(0, 64);
    const payload = token.slice(65);
    const expected = createHmac('sha256', INTERNAL_SECRET).update(payload).digest('hex');
    if (sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      const sepIdx = payload.indexOf(':');
      if (sepIdx > 0) return { uid: payload.slice(0, sepIdx), email: payload.slice(sepIdx + 1) };
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
export function signMcpToken(uid: string, email: string, kind: 'access' | 'refresh' = 'access', ttlSec = 3600): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const payload = `mcp:${kind}:${uid}:${email}:${exp}`;
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
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const parts = payload.split(':'); // mcp:kind:uid:email:exp  (uid/email never contain ':')
  if (parts[0] !== 'mcp' || parts.length < 5) return null;
  const exp = Number(parts[parts.length - 1]);
  if (!exp || Math.floor(Date.now() / 1000) > exp) return null;
  return { kind: parts[1] as 'access' | 'refresh', uid: parts[2], email: parts.slice(3, parts.length - 1).join(':') };
}

const WHITELIST_PATH = dataPath('whitelist.json');

function loadWhitelist(): string[] {
  if (!existsSync(WHITELIST_PATH)) return [];
  try {
    return JSON.parse(readFileSync(WHITELIST_PATH, 'utf-8'));
  } catch {
    return [];
  }
}

export interface AuthUser {
  uid: string;
  email: string;
  /** Owners can see all sessions/schedules across users (view-only bypass — mutations still restricted to owner of record). */
  isOwner: boolean;
}

/** Owners from env: OWNERS="email1,email2" (case-insensitive). */
function loadOwners(): string[] {
  return (process.env.OWNERS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function isOwnerEmail(email?: string): boolean {
  // Emailless tokens (e.g. anonymous Firebase users) are never owners — guard the .toLowerCase() crash.
  return !!email && loadOwners().includes(email.toLowerCase());
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
  const whitelist = loadWhitelist();
  if (whitelist.length > 0 && !whitelist.includes(payload.email)) {
    throw new Error('User not in whitelist');
  }
  return { uid: payload.user_id || payload.sub, email: payload.email, isOwner: isOwnerEmail(payload.email) };
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
/** Issue a signed local session token: sha_<sig>.<base64url(email:exp)>. */
export function localLogin(email: string, password: string): string | null {
  const rec = loadLocalUsers().find((u) => u.email === email);
  if (!rec) return null;
  const { hash } = hashPw(password, rec.salt);
  if (hash.length !== rec.hash.length || !timingSafeEqual(Buffer.from(hash), Buffer.from(rec.hash))) return null;
  const exp = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
  const payload = `${email}:${exp}`;
  const sig = createHmac('sha256', localSecret()).update(payload).digest('hex');
  return `sha_${sig}.${Buffer.from(payload).toString('base64url')}`;
}
function verifyLocalToken(token: string): AuthUser {
  if (!token.startsWith('sha_')) throw new Error('Invalid session token');
  const body = token.slice(4);
  const dot = body.indexOf('.');
  if (dot < 0) throw new Error('Malformed token');
  const sig = body.slice(0, dot);
  const payload = Buffer.from(body.slice(dot + 1), 'base64url').toString();
  const expected = createHmac('sha256', localSecret()).update(payload).digest('hex');
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) throw new Error('Bad token signature');
  const sep = payload.lastIndexOf(':');
  const email = payload.slice(0, sep);
  if (Math.floor(Date.now() / 1000) > Number(payload.slice(sep + 1))) throw new Error('Token expired — sign in again');
  return { uid: email, email, isOwner: isOwnerEmail(email) };
}

/** Dispatch bearer verification to the active provider. */
export async function verifyBearer(token: string): Promise<AuthUser> {
  return AUTH_PROVIDER === 'firebase' ? verifyToken(token) : verifyLocalToken(token);
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const internalToken = req.headers['x-internal-token'] as string | undefined;
  if (internalToken) {
    const identity = verifyInternalToken(internalToken);
    if (identity) {
      (req as any).user = { uid: identity.uid, email: identity.email, isOwner: isOwnerEmail(identity.email) } as AuthUser;
      return next();
    }
  }

  const token = req.headers.authorization?.replace('Bearer ', '') || (req.query.token as string);
  if (!token) return void res.status(401).json({ error: 'Missing token' });

  // API key auth (uck_…)
  if (token.startsWith('uck_')) {
    const identity = validateApiKey(token);
    if (!identity) return void res.status(401).json({ error: 'Invalid API key' });
    (req as any).user = { uid: identity.uid, email: identity.email, isOwner: isOwnerEmail(identity.email) } as AuthUser;
    return next();
  }

  try {
    (req as any).user = await verifyBearer(token);
    next();
  } catch (err: any) {
    return void res.status(err?.message?.includes('whitelist') ? 403 : 401).json({ error: err.message });
  }
}
