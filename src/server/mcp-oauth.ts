/**
 * Embedded OAuth 2.1 Authorization Server for the MCP endpoint (`/mcp`).
 *
 * Lets claude.ai (and any MCP client following the MCP Authorization spec) connect to the
 * remote MCP server via the standard discovery → DCR → authorize → token handshake, instead
 * of a static `uck_` API key.
 *
 * Provider-agnostic by design: the only place a user proves identity is `/oauth/authorize/consent`,
 * which is guarded by `requireAuth` — the same seam that handles Firebase today and email-password
 * later. Access/refresh tokens are stateless HMAC tokens (see auth.ts:signMcpToken). No DB:
 * clients live in a flat JSON file, auth codes in a short-TTL in-memory map.
 */
import type { Express, Request, Response, NextFunction } from 'express';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { requireAuth, signMcpToken, verifyMcpToken, type AuthUser } from './auth.ts';
import { dataPath } from './paths.ts';

const ACCESS_TTL = 3600; // 1h
const REFRESH_TTL = 60 * 60 * 24 * 30; // 30d
const CODE_TTL_MS = 60_000; // 1min

const CLIENTS_PATH = () => dataPath('oauth-clients.json');

interface OAuthClient {
  client_id: string;
  redirect_uris: string[];
  client_name?: string;
  created_at: number;
}

function loadClients(): Record<string, OAuthClient> {
  const p = CLIENTS_PATH();
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, 'utf8')); }
  catch (e) { console.warn('[mcp-oauth] failed to parse oauth-clients.json:', e); return {}; }
}

function saveClients(clients: Record<string, OAuthClient>) {
  writeFileSync(CLIENTS_PATH(), JSON.stringify(clients, null, 2));
}

interface AuthCode {
  uid: string;
  email: string;
  clientId: string;
  redirectUri: string;
  challenge: string;       // PKCE code_challenge (S256)
  resource?: string;
  expiresAt: number;
}
const codes = new Map<string, AuthCode>();

function pruneCodes() {
  const now = Date.now();
  for (const [k, v] of codes) if (v.expiresAt < now) codes.delete(k);
}

function baseUrl(req: Request): string {
  const proto = (req.get('x-forwarded-proto') || req.protocol).split(',')[0];
  return `${proto}://${req.get('host')}`;
}

function oauthCors(req: Request, res: Response, next: NextFunction) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return void res.sendStatus(204);
  next();
}

function pkceVerify(verifier: string, challenge: string): boolean {
  const computed = createHash('sha256').update(verifier).digest('base64url');
  return computed === challenge;
}

export function registerMcpOAuthRoutes(app: Express) {
  // ── Discovery: Protected Resource Metadata (RFC 9728) ───────────────────────
  const prm = (req: Request, res: Response) => {
    const base = baseUrl(req);
    res.json({
      resource: `${base}/mcp`,
      authorization_servers: [base],
      bearer_methods_supported: ['header'],
    });
  };
  app.get('/.well-known/oauth-protected-resource', oauthCors, prm);
  app.get('/.well-known/oauth-protected-resource/mcp', oauthCors, prm); // path-suffixed probe

  // ── Discovery: Authorization Server Metadata (RFC 8414) ─────────────────────
  app.get('/.well-known/oauth-authorization-server', oauthCors, (req: Request, res: Response) => {
    const base = baseUrl(req);
    res.json({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mcp'],
    });
  });

  // ── Dynamic Client Registration (RFC 7591) ──────────────────────────────────
  app.post('/oauth/register', oauthCors, (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { redirect_uris?: string[]; client_name?: string };
    const redirect_uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u) => typeof u === 'string') : [];
    if (redirect_uris.length === 0) {
      return void res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris required' });
    }
    const clients = loadClients();
    const client_id = `mcpc_${randomBytes(16).toString('hex')}`;
    const client: OAuthClient = { client_id, redirect_uris, client_name: body.client_name, created_at: Date.now() };
    clients[client_id] = client;
    saveClients(clients);
    console.log(`[mcp-oauth] registered client ${client_id} (${body.client_name ?? 'unnamed'})`);
    res.status(201).json({
      client_id,
      redirect_uris,
      client_name: body.client_name,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_id_issued_at: Math.floor(Date.now() / 1000),
    });
  });

  // NOTE: GET /oauth/authorize is intentionally NOT handled here — it falls through to the SPA
  // (index.html), which renders the consent screen and POSTs to /oauth/authorize/consent below.

  // ── Consent → issue authorization code (identity via requireAuth seam) ───────
  app.post('/oauth/authorize/consent', oauthCors, requireAuth, (req: Request, res: Response) => {
    const user = (req as any).user as AuthUser;
    const { client_id, redirect_uri, code_challenge, code_challenge_method, resource } = (req.body ?? {}) as Record<string, string>;
    if (!client_id || !redirect_uri || !code_challenge) {
      return void res.status(400).json({ error: 'invalid_request', error_description: 'client_id, redirect_uri, code_challenge required' });
    }
    if (code_challenge_method && code_challenge_method !== 'S256') {
      return void res.status(400).json({ error: 'invalid_request', error_description: 'only S256 PKCE supported' });
    }
    const client = loadClients()[client_id];
    if (!client) return void res.status(400).json({ error: 'invalid_client' });
    if (!client.redirect_uris.includes(redirect_uri)) {
      return void res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'redirect_uri not registered for client' });
    }
    pruneCodes();
    const code = randomBytes(32).toString('hex');
    codes.set(code, {
      uid: user.uid, email: user.email, clientId: client_id, redirectUri: redirect_uri,
      challenge: code_challenge, resource, expiresAt: Date.now() + CODE_TTL_MS,
    });
    console.log(`[mcp-oauth] issued auth code for ${user.email} → client ${client_id}`);
    res.json({ code });
  });

  // ── Token endpoint ──────────────────────────────────────────────────────────
  app.post('/oauth/token', oauthCors, (req: Request, res: Response) => {
    const b = (req.body ?? {}) as Record<string, string>;
    const grant = b.grant_type;

    if (grant === 'authorization_code') {
      pruneCodes();
      const entry = b.code ? codes.get(b.code) : undefined;
      if (!entry) return void res.status(400).json({ error: 'invalid_grant', error_description: 'unknown or expired code' });
      codes.delete(b.code); // single-use
      if (entry.redirectUri !== b.redirect_uri) return void res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
      if (entry.clientId !== b.client_id) return void res.status(400).json({ error: 'invalid_grant', error_description: 'client_id mismatch' });
      if (!b.code_verifier || !pkceVerify(b.code_verifier, entry.challenge)) {
        return void res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
      }
      return void res.json({
        access_token: signMcpToken(entry.uid, entry.email, 'access', ACCESS_TTL),
        token_type: 'Bearer',
        expires_in: ACCESS_TTL,
        refresh_token: signMcpToken(entry.uid, entry.email, 'refresh', REFRESH_TTL),
        scope: 'mcp',
      });
    }

    if (grant === 'refresh_token') {
      const id = b.refresh_token ? verifyMcpToken(b.refresh_token) : null;
      if (!id || id.kind !== 'refresh') return void res.status(400).json({ error: 'invalid_grant', error_description: 'invalid refresh_token' });
      return void res.json({
        access_token: signMcpToken(id.uid, id.email, 'access', ACCESS_TTL),
        token_type: 'Bearer',
        expires_in: ACCESS_TTL,
        refresh_token: signMcpToken(id.uid, id.email, 'refresh', REFRESH_TTL),
        scope: 'mcp',
      });
    }

    res.status(400).json({ error: 'unsupported_grant_type' });
  });

  console.log('[mcp-oauth] OAuth routes mounted (.well-known, /oauth/register, /oauth/authorize/consent, /oauth/token)');
}
