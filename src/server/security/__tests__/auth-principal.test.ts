import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

delete process.env.DATA_SYNC_ENABLE;
delete process.env.DATA_SYNC_REPO;

const { requireAuth, authenticateToken, signInternalToken, addLocalUser, localLogin, AUTH_PROVIDER } = await import('../../auth.ts');
const { createApiKey, listApiKeys } = await import('../../api-keys.ts');
const { initSecurity, __resetSecurityForTest } = await import('../runtime.ts');
const { ownerOnly } = await import('../owner-only.ts');
import type { AuthUser } from '../../auth.ts';
import type { SecurityRuntime } from '../runtime.ts';

const OWNER = `owner-${Date.now()}@auth-principal.test`;
const prevOwners = process.env.OWNERS;
let root: string;
let rt: SecurityRuntime;

function fakeReq(headers: Record<string, string>, query: Record<string, string> = {}) {
  return { headers, query, ip: '10.0.0.9', get: (h: string) => headers[h.toLowerCase()] } as any;
}
function fakeRes() {
  const r: any = { statusCode: 200, body: undefined };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: unknown) => { r.body = b; return r; };
  return r;
}
async function auth(headers: Record<string, string>) {
  const req = fakeReq(headers), res = fakeRes();
  let nexted = false;
  await requireAuth(req, res, () => { nexted = true; });
  return { user: req.user as AuthUser | undefined, status: res.statusCode, nexted };
}

beforeAll(() => {
  process.env.OWNERS = OWNER;
  root = mkdtempSync(path.join(tmpdir(), 'auth-principal-'));
  rt = initSecurity({
    policy: { path: path.join(root, 'security', 'policy.json'), whitelistPath: path.join(root, 'w.json'), watch: false },
    audit: { dir: path.join(root, 'audit') }, notify: () => {},
  });
});
afterAll(() => {
  __resetSecurityForTest();
  rmSync(root, { recursive: true, force: true });
  if (prevOwners === undefined) delete process.env.OWNERS; else process.env.OWNERS = prevOwners;
});

describe('requireAuth sets a principal per auth kind', () => {
  test('scoped internal token → internal principal', async () => {
    const { user, nexted } = await auth({ 'x-internal-token': signInternalToken('uid-int', 'int@x.test') });
    expect(nexted).toBe(true);
    expect(user!.principal).toMatchObject({ id: 'internal:uid-int', kind: 'internal', email: 'int@x.test' });
  });

  test('legacy raw internal token keeps its identity, as an internal principal', async () => {
    const { user } = await auth({ 'x-internal-token': process.env.INTERNAL_API_TOKEN! });
    expect(user).toMatchObject({ uid: 'agent-internal', email: 'agent@internal' });
    expect(user!.principal).toMatchObject({ id: 'internal:agent-internal', kind: 'internal' });
  });

  test('api key → apikey principal keyed by the key id', async () => {
    const k = createApiKey('uid-key', 'key@x.test', 'test');
    const { user } = await auth({ authorization: `Bearer ${k.key}` });
    expect(user!.principal).toMatchObject({ id: `apikey:${k.id}`, kind: 'apikey', email: 'key@x.test', attrs: { uid: 'uid-key' } });
    expect((await authenticateToken(k.key))!.principal.id).toBe(`apikey:${k.id}`);
  });

  test('login bearer → user principal; owner flag from OWNERS', async () => {
    expect(AUTH_PROVIDER).toBe('local');
    addLocalUser(OWNER, 'pw-owner-1');
    const { user } = await auth({ authorization: `Bearer ${localLogin(OWNER, 'pw-owner-1')}` });
    expect(user).toMatchObject({ uid: OWNER, isOwner: true });
    expect(user!.principal).toMatchObject({ id: `user:${OWNER}`, kind: 'user', verified: true });
  });

  test('allow/deny are audited, deduped', async () => {
    const k = createApiKey('uid-dedupe', 'dd@x.test', 'test');
    for (let i = 0; i < 3; i++) await auth({ authorization: `Bearer ${k.key}` });
    for (let i = 0; i < 3; i++) expect((await auth({ authorization: 'Bearer uck_nope' })).status).toBe(401);
    const recs = rt.audit.query({ limit: 1000 }).items;
    expect(recs.filter(r => r.type === 'auth.allow' && r.principal === `apikey:${k.id}`)).toHaveLength(1);
    expect(recs.filter(r => r.type === 'auth.deny' && r.reason === 'invalid-api-key')).toHaveLength(1);
  });
});

describe('listApiKeys + ownerOnly', () => {
  test('non-owner sees only own keys; owner sees all', () => {
    const a = createApiKey('uid-list-a', 'a@x.test', 'a');
    const b = createApiKey('uid-list-b', 'b@x.test', 'b');
    const mine = listApiKeys({ uid: 'uid-list-a', isOwner: false });
    expect(mine.every(k => k.uid === 'uid-list-a')).toBe(true);
    expect(mine.map(k => k.id)).toContain(a.id);
    expect(listApiKeys({ uid: 'uid-list-a', isOwner: true }).map(k => k.id)).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(JSON.stringify(mine)).not.toContain(a.key);
  });

  test('ownerOnly 403s a non-owner with the given message', () => {
    const res = fakeRes();
    expect(ownerOnly({ user: { isOwner: false } } as any, res, 'nope')).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'nope' });
    expect(ownerOnly({ user: { isOwner: true } } as any, fakeRes())).toBe(true);
  });
});
