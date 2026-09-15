import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

delete process.env.DATA_SYNC_ENABLE;
delete process.env.DATA_SYNC_REPO;

const { ApiKeyStore, apiKeyPrincipal } = await import('../../api-keys.ts');
const { initSecurity, __resetSecurityForTest } = await import('../runtime.ts');
import type { SecurityRuntime } from '../runtime.ts';

const quiet = { info() {}, warn() {}, error() {} };
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const mode = (p: string) => statSync(p).mode & 0o777;

// Exactly the pre-hashing on-disk shape of data/api-keys.json (checked against a live deployment's file).
const K1 = `uck_${'a1'.repeat(32)}`, K2 = `uck_${'b2'.repeat(32)}`;
const LEGACY = [
  { id: 'k1', key: K1, label: 'shraga term @ host', uid: 'u1', email: 'u1@x.test', createdAt: 1700000000000 },
  { id: 'k2', key: K2, label: 'webhook', uid: 'u2', email: 'u2@x.test', createdAt: 1700000000001 },
];

let root: string;
let rt: SecurityRuntime;
let n = 0;
function fixture() {
  const dir = path.join(root, `fx-${n++}`);
  mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'api-keys.json');
  const raw = JSON.stringify(LEGACY, null, 2);
  writeFileSync(p, raw, { mode: 0o644 });
  return { p, raw };
}

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'api-keys-'));
  rt = initSecurity({
    policy: { path: path.join(root, 'security', 'policy.json'), whitelistPath: path.join(root, 'w.json'), watch: false },
    audit: { dir: path.join(root, 'audit') }, notify: () => {}, log: quiet,
  });
});
afterAll(() => { __resetSecurityForTest(); rmSync(root, { recursive: true, force: true }); });

describe('plaintext → hashed migration', () => {
  test('hashes in place, keeps old keys valid, writes a 600 .bak of the original once', () => {
    const { p, raw } = fixture();
    const store = new ApiKeyStore({ path: p, log: quiet });
    expect(store.validate(K1)).toEqual({ id: 'k1', uid: 'u1', email: 'u1@x.test' });
    expect(store.validate(K2)).toEqual({ id: 'k2', uid: 'u2', email: 'u2@x.test' });
    expect(store.validate(`uck_${'00'.repeat(32)}`)).toBeNull();

    const disk = readFileSync(p, 'utf8');
    expect(disk).not.toContain(K1);
    expect(disk).not.toContain(K2);
    const entries = JSON.parse(disk);
    expect(entries).toEqual([
      { id: 'k1', label: 'shraga term @ host', uid: 'u1', email: 'u1@x.test', createdAt: 1700000000000, hash: sha256(K1), keyPreview: 'uck_a1a1…' },
      { id: 'k2', label: 'webhook', uid: 'u2', email: 'u2@x.test', createdAt: 1700000000001, hash: sha256(K2), keyPreview: 'uck_b2b2…' },
    ]);
    expect(mode(p)).toBe(0o600);
    expect(readFileSync(`${p}.bak`, 'utf8')).toBe(raw);
    expect(mode(`${p}.bak`)).toBe(0o600);
  });

  test('idempotent: a re-run (new process/store) rewrites nothing and keys still validate', () => {
    const { p } = fixture();
    new ApiKeyStore({ path: p, log: quiet }).validate(K1); // migrate
    const disk = readFileSync(p, 'utf8'), mtime = statSync(p).mtimeMs;
    const bak = readFileSync(`${p}.bak`, 'utf8'), bakMtime = statSync(`${p}.bak`).mtimeMs;

    const again = new ApiKeyStore({ path: p, log: quiet });
    expect(again.validate(K1)?.id).toBe('k1');
    expect(again.validate(K2)?.id).toBe('k2');
    expect(readFileSync(p, 'utf8')).toBe(disk);
    expect(statSync(p).mtimeMs).toBe(mtime);
    expect(readFileSync(`${p}.bak`, 'utf8')).toBe(bak);
    expect(statSync(`${p}.bak`).mtimeMs).toBe(bakMtime);
  });

  test('PASSIVE instance serves legacy keys without writing; migrates once it turns active', () => {
    const { p, raw } = fixture();
    let active = false;
    const store = new ApiKeyStore({ path: p, log: quiet, isActive: () => active });
    expect(store.validate(K1)?.id).toBe('k1');
    expect(readFileSync(p, 'utf8')).toBe(raw);
    expect(existsSync(`${p}.bak`)).toBe(false);
    active = true;
    expect(store.validate(K2)?.id).toBe('k2');
    expect(readFileSync(p, 'utf8')).not.toContain(K2);
    expect(readFileSync(`${p}.bak`, 'utf8')).toBe(raw);
  });
});

describe('create / expiry / role', () => {
  test('plaintext returned once; list and disk never hold it; audited key.create + key.revoke', () => {
    const { p } = fixture();
    const store = new ApiKeyStore({ path: p, log: quiet });
    const created = store.create('u9', 'u9@x.test', 'probe', { actor: 'user:owner@x.test' });
    expect(created.key).toMatch(/^uck_[0-9a-f]{64}$/);
    const listed = store.list({ uid: 'u9', isOwner: false });
    expect(listed.map(k => k.id)).toEqual([created.id]);
    expect(Object.keys(listed[0])).not.toContain('hash');
    expect(Object.keys(listed[0])).not.toContain('key');
    expect(readFileSync(p, 'utf8')).not.toContain(created.key);
    expect(store.validate(created.key)?.id).toBe(created.id);

    expect(store.delete(created.id, 'someone-else', false)).toBe('forbidden');
    expect(store.delete(created.id, 'u9', false, 'user:u9@x.test')).toBe('ok');
    expect(store.validate(created.key)).toBeNull();
    const recs = rt.audit.query({ limit: 100, type: ['key.create', 'key.revoke'] }).items.filter(r => r.target === `apikey:${created.id}`);
    expect(recs.map(r => [r.type, r.principal]).sort()).toEqual([['key.create', 'user:owner@x.test'], ['key.revoke', 'user:u9@x.test']]);
  });

  test('expired key is rejected; past expiry refused at create', () => {
    const { p } = fixture();
    let now = 1_800_000_000_000;
    const store = new ApiKeyStore({ path: p, log: quiet, clock: () => now });
    const k = store.create('u', 'u@x.test', 'short', { expiresAt: now + 60_000 });
    expect(store.validate(k.key)?.id).toBe(k.id);
    now += 59_999;
    expect(store.validate(k.key)?.id).toBe(k.id);
    now += 1;
    expect(store.validate(k.key)).toBeNull();
    expect(() => store.create('u', 'u@x.test', 'past', { expiresAt: now - 1 })).toThrow(/future/);
  });

  test('role: policy roles only, never owner; carried into validate() and the principal attrs', () => {
    const { p } = fixture();
    const store = new ApiKeyStore({ path: p, log: quiet });
    expect(() => store.create('u', 'u@x.test', 'x', { role: 'owner' })).toThrow(/owner/);
    expect(() => store.create('u', 'u@x.test', 'x', { role: 'no-such-role' })).toThrow(/not defined/);
    const k = store.create('u', 'u@x.test', 'member key', { role: 'member' });
    const id = store.validate(k.key)!;
    expect(id).toEqual({ id: k.id, uid: 'u', email: 'u@x.test', role: 'member' });
    expect(apiKeyPrincipal(id)).toMatchObject({ id: `apikey:${k.id}`, kind: 'apikey', attrs: { uid: 'u', role: 'member' } });
  });
});
