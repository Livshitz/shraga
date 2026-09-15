import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

delete process.env.DATA_SYNC_ENABLE;
delete process.env.DATA_SYNC_REPO;

const auth = await import('../../auth.ts');
const { authenticateToken, requireAuth, signMcpToken, verifyMcpToken, signInternalToken, addLocalUser, localLogin, verifyToken, MCP_TOKEN_TTL, LOCAL_TOKEN_TTL } = auth;
const { initSecurity, __resetSecurityForTest } = await import('../runtime.ts');
const { revokeTokens, tokenRevoked, firebaseIssuedAt } = await import('../revocation.ts');
const { fromAuthUser } = await import('../principal.ts');
const { dataPath } = await import('../../paths.ts');
const { JwtHelper } = await import('edge.libx.js/build/helpers/jwt.js');
import type { SecurityRuntime } from '../runtime.ts';

const quiet = { info() {}, warn() {}, error() {} };
const tag = Date.now();
const nowSec = () => Math.floor(Date.now() / 1000);
const hmac = (secret: string, s: string) => createHmac('sha256', secret).update(s).digest('hex');
const b64 = (s: string) => Buffer.from(s).toString('base64url');
let root: string, policyPath: string;
let rt: SecurityRuntime;

// Pre-iat token formats, signed with the live secrets — what a client minted before this change holds.
const legacyLocal = (email: string, exp: number) => {
  const payload = `${email}:${exp}`;
  return `sha_${hmac(readFileSync(dataPath('.local-auth-secret'), 'utf8').trim(), payload)}.${b64(payload)}`;
};
const legacyMcp = (uid: string, email: string, kind: 'access' | 'refresh', exp: number) => {
  const payload = `mcp:${kind}:${uid}:${email}:${exp}`;
  return `mcp_${hmac(readFileSync(dataPath('.mcp-oauth-secret'), 'utf8').trim(), payload)}.${b64(payload)}`;
};
const legacyInternal = (uid: string, email: string) => `${hmac(process.env.INTERNAL_API_TOKEN!, `${uid}:${email}`)}:${uid}:${email}`;

async function httpStatus(token: string) {
  const req = { headers: { authorization: `Bearer ${token}` }, query: {}, ip: '10.0.0.1', get: () => undefined } as any;
  const res: any = { statusCode: 200, status(c: number) { res.statusCode = c; return res; }, json() { return res; } };
  let nexted = false;
  await requireAuth(req, res, () => { nexted = true; });
  return nexted ? 200 : res.statusCode;
}

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'revocation-'));
  policyPath = path.join(root, 'security', 'policy.json');
  rt = initSecurity({
    policy: { path: policyPath, whitelistPath: path.join(root, 'w.json'), watch: false },
    audit: { dir: path.join(root, 'audit') }, notify: () => {}, log: quiet,
  });
  expect(rt.policy.valid).toBe(true);
});
afterAll(() => { __resetSecurityForTest(); rmSync(root, { recursive: true, force: true }); });

describe('role is resolved per request', () => {
  test('removing a binding takes effect on the next resolve (no token/cached role)', () => {
    const email = `bound-${tag}@x.test`;
    const p = fromAuthUser({ uid: email, email });
    const base = rt.policy.current;
    rt.policy.save({ ...base, bindings: [{ match: { kind: 'user', emailIn: [email] }, role: 'operator' }] });
    expect(rt.policy.resolve(p).role).toBe('operator');
    rt.policy.save({ ...base, bindings: [] });
    expect(rt.policy.resolve(p).role).toBe('anonymous');
  });
});

describe('tokensValidAfter', () => {
  test('revoked principal: old local/mcp(access+refresh)/internal tokens rejected, tokens issued after work, others untouched', async () => {
    const E = `rev-${tag}@x.test`, OTHER = `keep-${tag}@x.test`;
    addLocalUser(E, 'pw'); addLocalUser(OTHER, 'pw');
    const old = {
      local: localLogin(E, 'pw')!, access: signMcpToken(E, E, 'access'), refresh: signMcpToken(E, E, 'refresh'), internal: signInternalToken(E, E),
    };
    const otherLocal = localLogin(OTHER, 'pw')!;
    expect((await authenticateToken(old.local))?.principal.id).toBe(`user:${E}`);
    expect(verifyMcpToken(old.access)).toEqual({ kind: 'access', uid: E, email: E });
    expect(verifyMcpToken(old.refresh)).toEqual({ kind: 'refresh', uid: E, email: E });
    expect((await authenticateToken(old.internal))?.principal.id).toBe(`internal:${E}`);

    await Bun.sleep(1100); // tokensValidAfter has 1s granularity
    const at = revokeTokens(`user:${E}`, 'user:owner@x.test');

    expect(await authenticateToken(old.local)).toBeNull();
    expect(await httpStatus(old.local)).toBe(401);
    expect(verifyMcpToken(old.access)).toBeNull();
    expect(verifyMcpToken(old.refresh)).toBeNull();
    expect(await authenticateToken(old.internal)).toBeNull(); // internal token acting for the revoked user

    expect((await authenticateToken(localLogin(E, 'pw')!))?.email).toBe(E);
    expect(await httpStatus(localLogin(E, 'pw')!)).toBe(200);
    expect(verifyMcpToken(signMcpToken(E, E, 'access'))?.uid).toBe(E);
    expect(verifyMcpToken(signMcpToken(E, E, 'refresh'))?.kind).toBe('refresh');
    expect((await authenticateToken(signInternalToken(E, E)))?.uid).toBe(E);
    expect((await authenticateToken(otherLocal))?.email).toBe(OTHER);

    expect(JSON.parse(readFileSync(policyPath, 'utf8')).tokensValidAfter[`user:${E}`]).toBe(at);
    const rec = rt.audit.query({ limit: 100, type: 'token.revoke' }).items.find(r => r.target === `user:${E}`);
    expect(rec).toMatchObject({ principal: 'user:owner@x.test', meta: { validAfter: at } });
    expect(rt.audit.query({ limit: 100, type: 'auth.deny' }).items.some(r => r.reason === 'token-revoked')).toBe(true);
  });

  test('revoking internal:<uid> kills that uid\'s scoped internal tokens', async () => {
    const U = `int-${tag}`;
    const tok = signInternalToken(U, 'unknown');
    expect((await authenticateToken(tok))?.uid).toBe(U);
    await Bun.sleep(1100);
    revokeTokens(`internal:${U}`);
    expect(await authenticateToken(tok)).toBeNull();
    expect((await authenticateToken(signInternalToken(U, 'unknown')))?.uid).toBe(U);
  });

  test('old-format tokens (no iat): local/mcp use exp - TTL, scoped internal uses 0', async () => {
    const L = `legacy-${tag}@x.test`, KEEP = `legacy-keep-${tag}@x.test`;
    signMcpToken(L, L); localLogin(`nobody-${tag}@x.test`, 'x'); // ensure both persisted secrets exist
    addLocalUser(`seed-${tag}@x.test`, 'pw'); localLogin(`seed-${tag}@x.test`, 'pw');
    const t0 = nowSec();
    const before = {
      local: legacyLocal(L, t0 + LOCAL_TOKEN_TTL - 5), access: legacyMcp(L, L, 'access', t0 + MCP_TOKEN_TTL.access - 5),
      refresh: legacyMcp(L, L, 'refresh', t0 + MCP_TOKEN_TTL.refresh - 5), internal: legacyInternal(L, L),
    };
    // Parse + accepted while no revocation exists.
    expect((await authenticateToken(before.local))?.email).toBe(L);
    expect(verifyMcpToken(before.access)).toEqual({ kind: 'access', uid: L, email: L });
    expect(verifyMcpToken(before.refresh)?.kind).toBe('refresh');
    expect((await authenticateToken(before.internal))?.principal.id).toBe(`internal:${L}`);

    const at = revokeTokens(`user:${L}`);
    // implied iat = exp - TTL < validAfter → rejected
    expect(await authenticateToken(before.local)).toBeNull();
    expect(verifyMcpToken(before.access)).toBeNull();
    expect(verifyMcpToken(before.refresh)).toBeNull();
    expect(await authenticateToken(before.internal)).toBeNull(); // iat 0
    // implied iat = validAfter → not before it → accepted
    expect((await authenticateToken(legacyLocal(L, at + LOCAL_TOKEN_TTL)))?.email).toBe(L);
    expect(verifyMcpToken(legacyMcp(L, L, 'access', at + MCP_TOKEN_TTL.access))?.uid).toBe(L);
    // unrevoked principal's legacy internal token still fine
    expect((await authenticateToken(legacyInternal(KEEP, KEEP)))?.uid).toBe(KEEP);
  });

  test('Firebase: auth_time (not the refreshed iat) is checked against tokensValidAfter', async () => {
    const F = `fb-${tag}@x.test`;
    const at = revokeTokens(`user:${F}`);
    expect(tokenRevoked(`user:${F}`, firebaseIssuedAt({ auth_time: at - 100, iat: at + 100 }))).toBe(true);
    expect(tokenRevoked(`user:${F}`, firebaseIssuedAt({ auth_time: at, iat: at + 100 }))).toBe(false);
    expect(firebaseIssuedAt({ iat: 42 })).toBe(42);
    expect(firebaseIssuedAt({})).toBe(0);

    // Through verifyToken itself, with the JWT signature check stubbed (no network).
    const J = JwtHelper as any, orig = J.verifyFirebaseToken, prevCfg = process.env.FIREBASE_CONFIG_PROD;
    process.env.FIREBASE_CONFIG_PROD = JSON.stringify({ projectId: 'p' });
    try {
      J.verifyFirebaseToken = async () => ({ email: F, user_id: 'fb-uid', auth_time: at - 100, iat: at + 100 });
      await expect(verifyToken('jwt')).rejects.toThrow(/revoked/);
      J.verifyFirebaseToken = async () => ({ email: F, user_id: 'fb-uid', auth_time: at + 1, iat: at + 100 });
      expect((await verifyToken('jwt')).email).toBe(F);
    } finally {
      J.verifyFirebaseToken = orig;
      if (prevCfg === undefined) delete process.env.FIREBASE_CONFIG_PROD; else process.env.FIREBASE_CONFIG_PROD = prevCfg;
    }
  });

  test('revoke refuses when the policy is fail-closed (would overwrite the broken file)', () => {
    const bad = initSecurity({
      policy: { path: path.join(root, 'bad', 'policy.json'), whitelistPath: path.join(root, 'w.json'), watch: false, isActive: () => false },
      audit: { dir: path.join(root, 'audit-bad') }, notify: () => {}, log: quiet,
    });
    try {
      expect(bad.policy.valid).toBe(false);
      expect(() => revokeTokens('user:x@x.test')).toThrow(/fail-closed/);
    } finally {
      rt = initSecurity({
        policy: { path: policyPath, whitelistPath: path.join(root, 'w.json'), watch: false },
        audit: { dir: path.join(root, 'audit') }, notify: () => {}, log: quiet,
      });
    }
  });
});
