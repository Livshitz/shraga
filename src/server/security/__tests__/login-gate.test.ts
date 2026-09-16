import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initSecurity, loginAllowed, __resetSecurityForTest } from '../runtime.ts';
import { defaultPolicy } from '../policy.ts';
import { fromAuthUser } from '../principal.ts';

const OWNER = 'owner@login-gate.test';
const quiet = { info() {}, warn() {}, error() {} };
let root: string;
const prevOwners = process.env.OWNERS;
const user = (email: string) => fromAuthUser({ uid: email, email });

function boot(policyContent?: string) {
  const dir = mkdtempSync(path.join(root, 'g-'));
  const p = path.join(dir, 'security', 'policy.json');
  if (policyContent !== undefined) { mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, policyContent); }
  return initSecurity({ policy: { path: p, whitelistPath: path.join(dir, 'whitelist.json'), watch: false, log: quiet }, audit: { dir: path.join(dir, 'audit') }, notify: () => {}, log: quiet });
}

beforeAll(() => { root = mkdtempSync(path.join(tmpdir(), 'login-gate-')); process.env.OWNERS = OWNER; });
afterAll(() => { rmSync(root, { recursive: true, force: true }); if (prevOwners === undefined) delete process.env.OWNERS; else process.env.OWNERS = prevOwners; });
afterEach(() => __resetSecurityForTest());

describe('loginAllowed — policy bindings replace whitelist.json', () => {
  const bound = { ...defaultPolicy(), bindings: [
    { match: { kind: 'user' as const, emailIn: ['op@x.test'] }, role: 'operator' },
    { match: { kind: 'user' as const, emailIn: ['mem@x.test'] }, role: 'member' },
    { match: { kind: 'user' as const, emailIn: ['guest@x.test'] }, role: 'guest' },
  ] };

  test('bound operator/member allowed; guest and unbound denied', () => {
    boot(JSON.stringify(bound));
    expect(loginAllowed(user('op@x.test'))).toBe(true);
    expect(loginAllowed(user('MEM@x.test'))).toBe(true);
    expect(loginAllowed(user('guest@x.test'))).toBe(false);
    expect(loginAllowed(user('stranger@x.test'))).toBe(false);
  });

  test('owner allowed with a valid policy and no binding', () => {
    boot(JSON.stringify(bound));
    expect(loginAllowed(user(OWNER))).toBe(true);
  });

  test('invalid policy fails closed: owner still allowed, bound non-owner denied', () => {
    const rt = boot('{ not json');
    expect(rt.policy.valid).toBe(false);
    expect(loginAllowed(user(OWNER))).toBe(true);
    expect(loginAllowed(user('op@x.test'))).toBe(false);
  });

  test('no runtime yet (before initSecurity): owner allowed, everyone else denied', () => {
    expect(loginAllowed(user(OWNER))).toBe(true);
    expect(loginAllowed(user('op@x.test'))).toBe(false);
  });

  test('fresh install with no whitelist migrates to zero bindings ⇒ non-owners locked out (breaking, intended)', () => {
    const rt = boot();
    expect(rt.policy.valid).toBe(true);
    expect(rt.policy.current.bindings).toEqual([]);
    expect(loginAllowed(user('anyone@x.test'))).toBe(false);
    expect(loginAllowed(user(OWNER))).toBe(true);
  });

  test('a legacy whitelist migrates into operator bindings and keeps those users in', () => {
    const dir = mkdtempSync(path.join(root, 'wl-'));
    writeFileSync(path.join(dir, 'whitelist.json'), JSON.stringify(['legacy@x.test']));
    initSecurity({ policy: { path: path.join(dir, 'security', 'policy.json'), whitelistPath: path.join(dir, 'whitelist.json'), watch: false, log: quiet }, audit: { dir: path.join(dir, 'audit') }, notify: () => {}, log: quiet });
    expect(loginAllowed(user('legacy@x.test'))).toBe(true);
    expect(loginAllowed(user('other@x.test'))).toBe(false);
  });
});

describe('verifyToken (Firebase) is wired to the gate', () => {
  test('bound → AuthUser; unbound → the "whitelist" error the client keys on', async () => {
    const { spyOn } = await import('bun:test');
    const { JwtHelper } = await import('edge.libx.js/build/helpers/jwt.js');
    const { verifyToken } = await import('../../auth.ts');
    const prevCfg = process.env.FIREBASE_CONFIG_PROD;
    process.env.FIREBASE_CONFIG_PROD = JSON.stringify({ projectId: 'p' });
    const spy = spyOn(JwtHelper as any, 'verifyFirebaseToken').mockImplementation(async (t: string) => ({ user_id: t, email: t, auth_time: Math.floor(Date.now() / 1000) }));
    try {
      boot(JSON.stringify({ ...defaultPolicy(), bindings: [{ match: { kind: 'user', emailIn: ['op@x.test'] }, role: 'operator' }] }));
      expect((await verifyToken('op@x.test')).email).toBe('op@x.test');
      expect((await verifyToken(OWNER)).isOwner).toBe(true);
      await expect(verifyToken('stranger@x.test')).rejects.toThrow('whitelist');
    } finally {
      spy.mockRestore();
      if (prevCfg === undefined) delete process.env.FIREBASE_CONFIG_PROD; else process.env.FIREBASE_CONFIG_PROD = prevCfg;
    }
  });
});
