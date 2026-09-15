import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createServer } from 'node:net';
import type { ShragaInstance } from '../../../index.ts';
import type { Principal } from '../principal.ts';

// Owner Console API (/api/owner/*) on the REAL booted server (passive, local auth): owner gate, PASSIVE 409, policy
// PUT validation + provenance + audit, test-a-principal parity with decide(), principals, blocklist ↔ guard, audit.
delete process.env.DATA_SYNC_ENABLE;
delete process.env.DATA_SYNC_REPO;

const T = Date.now();
const OWNER = `owner-${T}@console.test`;
const BOB = `bob-${T}@console.test`;
const prevOwners = process.env.OWNERS;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, () => { const port = (s.address() as { port: number }).port; s.close(() => resolve(port)); });
  });
}

let app: ShragaInstance;
let base: string;
let ownerTok: string, bobTok: string;

beforeAll(async () => {
  process.env.OWNERS = OWNER;
  const { __resetExtensionsForTest } = await import('../../extensions.ts');
  const { __resetEventBusForTest } = await import('../../events/bus.ts');
  __resetExtensionsForTest();
  __resetEventBusForTest();
  const { createShraga } = await import('../../../index.ts');
  const port = await freePort();
  app = createShraga({ port, authProvider: 'local', passive: true, installSignalHandlers: false });
  await app.start();
  base = `http://localhost:${port}`;
  const { addLocalUser, localLogin } = await import('../../auth.ts');
  addLocalUser(OWNER, 'pw-owner'); addLocalUser(BOB, 'pw-bob');
  ownerTok = localLogin(OWNER, 'pw-owner')!; bobTok = localLogin(BOB, 'pw-bob')!;
});
afterAll(async () => {
  await app?.stop();
  (await import('../runtime.ts')).__resetSecurityForTest();
  if (prevOwners === undefined) delete process.env.OWNERS; else process.env.OWNERS = prevOwners;
});

const call = (tok: string, method: string, url: string, body?: unknown) => fetch(`${base}${url}`, {
  method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});
const json = async (tok: string, method: string, url: string, body?: unknown) => {
  const r = await call(tok, method, url, body);
  return { status: r.status, body: await r.json() as any };
};
const sec = async () => (await import('../runtime.ts')).security()!;

/** This server booted PASSIVE; run `fn` as the active instance would. */
async function asActive<T>(fn: () => Promise<T>): Promise<T> {
  const s = await sec();
  const prev = s.options.isActive;
  s.options.isActive = () => true;
  try { return await fn(); } finally { s.options.isActive = prev; }
}

const ROUTES: [string, string, unknown?][] = [
  ['GET', '/api/owner/policy'],
  ['PUT', '/api/owner/policy', { policy: {} }],
  ['POST', '/api/owner/policy/test', { kind: 'user', email: 'x@y.test' }],
  ['GET', '/api/owner/principals'],
  ['GET', '/api/owner/blocks'],
  ['POST', '/api/owner/blocks', { match: { id: 'user:x' } }],
  ['DELETE', '/api/owner/blocks', { source: 'auto', key: 'x' }],
  ['GET', '/api/owner/audit'],
  ['GET', '/api/owner/audit/verify'],
];

describe('owner gate', () => {
  for (const [method, url, body] of ROUTES) {
    test(`${method} ${url} → 403 for a non-owner`, async () => {
      const r = await json(bobTok, method, url, body);
      expect(r.status).toBe(403);
      expect(r.body.error).toMatch(/Only an owner/);
    });
  }
});

describe('PASSIVE standby', () => {
  test('writes → 409, reads still work', async () => {
    expect((await call(ownerTok, 'PUT', '/api/owner/policy', { policy: {} })).status).toBe(409);
    expect((await call(ownerTok, 'POST', '/api/owner/blocks', { match: { id: 'user:x' } })).status).toBe(409);
    expect((await call(ownerTok, 'DELETE', '/api/owner/blocks', { source: 'auto', key: 'x' })).status).toBe(409);
    expect((await call(ownerTok, 'GET', '/api/owner/policy')).status).toBe(200);
    expect((await call(ownerTok, 'GET', '/api/owner/audit?limit=1')).status).toBe(200);
  });
});

describe('as the active instance', () => {
  beforeAll(() => asActive(async () => { (await sec()).activate(); }));

  test("an owner's role-capped API key → 403 on every console route", () => asActive(async () => {
    const r = await json(ownerTok, 'POST', '/api/owner/api-keys', { label: 'console-guest', role: 'guest' });
    expect(r.status).toBe(200);
    for (const [method, url, body] of ROUTES) expect({ url, status: (await call(r.body.key, method, url, body)).status }).toEqual({ url, status: 403 });
  }));

  test('PUT policy: validation errors (400), stale version (409), a valid save applies + is audited with a diff', () => asActive(async () => {
    const s = await sec();
    const got = await json(ownerTok, 'GET', '/api/owner/policy');
    expect(got.status).toBe(200);
    expect(got.body.valid).toBe(true);
    const { policy, version } = got.body;

    const bad = structuredClone(policy);
    bad.bindings = [{ match: { kind: 'user', emailIn: [BOB] }, role: 'owner' }, { match: {}, role: 'nope' }];
    bad.default = 'owner';
    const r400 = await json(ownerTok, 'PUT', '/api/owner/policy', { policy: bad, version });
    expect(r400.status).toBe(400);
    expect(r400.body.errors).toEqual(expect.arrayContaining([
      'bindings[0] cannot grant owner (OWNERS env only)', 'bindings[1].match is empty (would match everyone)',
      'bindings[1].role "nope" not defined', 'default cannot be owner',
    ]));
    expect(r400.body.error).toMatch(/^Invalid policy: /);
    expect(s.policy.current).toEqual(policy); // nothing applied

    expect((await call(ownerTok, 'PUT', '/api/owner/policy', { policy, version: 'stale' })).status).toBe(409);

    const next = structuredClone(policy);
    next.bindings = [{ match: { kind: 'user', emailIn: [BOB] }, role: 'member' }, ...policy.bindings];
    next.profiles.standard.rate = '99/h';
    const ok = await json(ownerTok, 'PUT', '/api/owner/policy', { policy: next, version });
    expect(ok.status).toBe(200);
    expect(ok.body.version).not.toBe(version);
    expect(s.policy.reload()).toBe(true); // provenance: the file on disk is what save() wrote
    const { fromAuthUser } = await import('../principal.ts');
    expect(s.policy.resolve(fromAuthUser({ uid: BOB, email: BOB })).role).toBe('member');

    const rec = s.audit.query({ limit: 1, type: 'policy.change', principal: `user:${OWNER}` }).items[0];
    expect(rec).toMatchObject({ target: 'policy' });
    expect(rec.meta?.changed).toEqual(expect.arrayContaining(['bindings.0', 'profiles.standard']));
    expect(JSON.stringify(rec.meta)).not.toContain('99/h'); // names only, never values
  }));

  test('policy/test matches the real turn resolution (decide) and audits no role.resolve', () => asActive(async () => {
    const s = await sec();
    const { principalFromDescriptor } = await import('../owner-routes.ts');
    const descriptors = [
      { kind: 'user', email: OWNER },
      { kind: 'user', email: BOB },
      { kind: 'user', email: `stranger-${T}@x.test` },
      { kind: 'email', email: BOB, verified: true }, // an email channel carrying a user-bound address is not that user
      { kind: 'apikey', id: 'k1', email: OWNER, role: 'guest' },
      { kind: 'apikey', id: 'k2', email: OWNER },
      { kind: 'internal', id: OWNER, email: OWNER, lane: 'scheduler' },
      { kind: 'anonymous' },
    ];
    const before = s.audit.query({ limit: 1000, type: 'role.resolve' }).items.length;
    const results: any[] = [];
    for (const d of descriptors) {
      const r = await json(ownerTok, 'POST', '/api/owner/policy/test', d);
      expect(r.status).toBe(200);
      results.push(r.body);
    }
    expect(s.audit.query({ limit: 1000, type: 'role.resolve' }).items.length).toBe(before);
    descriptors.forEach((d, i) => {
      const p: Principal = principalFromDescriptor(d);
      const real = s.decide(p);
      expect({ d, role: results[i].role, rank: results[i].rank, profile: results[i].profile })
        .toEqual({ d, role: real.role, rank: real.rank, profile: real.profile });
      expect(results[i].principal).toBe(p.id);
    });
    // internal lane for an owner email is NOT owner via resolve (owner = interactive `user` login only)
    expect(results.map(r => r.role)).toEqual(['owner', 'member', 'anonymous', 'anonymous', 'guest', 'owner', 'anonymous', 'anonymous']);
    expect((await call(ownerTok, 'POST', '/api/owner/policy/test', { kind: 'martian', email: 'x@y' })).status).toBe(400);
  }));

  test('principals: aggregated from the audit (last role, last seen, turns, denies)', () => asActive(async () => {
    const s = await sec();
    const id = `user:carol-${T}@console.test`;
    s.record({ type: 'turn.start', principal: id, role: 'guest', sessionId: 's1' });
    s.record({ type: 'turn.end', principal: id, role: 'guest', sessionId: 's1' });
    s.record({ type: 'turn.start', principal: id, role: 'member', sessionId: 's2' });
    s.record({ type: 'tool.deny', principal: id, target: 'Bash' });
    s.record({ type: 'guard.block', principal: id, reason: 'blocked' });
    s.record({ type: 'key.create', principal: id, role: 'operator', target: 'apikey:k-carol' }); // the KEY's role, not carol's
    const r = await json(ownerTok, 'GET', '/api/owner/principals?days=1');
    expect(r.status).toBe(200);
    const row = r.body.principals.find((p: any) => p.id === id);
    expect(row).toMatchObject({ id, kind: 'user', lastRole: 'member', turns: 2, denies: 2 });
    expect(Date.now() - Date.parse(row.lastSeen)).toBeLessThan(60_000);
    const ids = r.body.principals.map((p: any) => p.id);
    expect(ids.indexOf(`user:${OWNER}`)).toBeGreaterThan(-1);
  }));

  test('blocklist: a manual block makes guard.check deny; removal lifts it; auto-blocks list + clear; all audited', () => asActive(async () => {
    const s = await sec();
    const { fromAuthUser } = await import('../principal.ts');
    const dave = fromAuthUser({ uid: `dave-${T}@console.test`, email: `dave-${T}@console.test` });
    const blocked = () => {
      const v = s.guard.check({ principal: dave, rank: 50, rate: '1000/h' });
      return (v.ok ? v.wouldDeny?.reason : v.reason) === 'blocked';
    };
    expect(blocked()).toBe(false);

    expect((await call(ownerTok, 'POST', '/api/owner/blocks', { match: { id: dave.id }, until: Date.now() + 60_000 })).status).toBe(400); // ms, not s
    expect((await call(ownerTok, 'POST', '/api/owner/blocks', { match: {} })).status).toBe(400);
    const add = await json(ownerTok, 'POST', '/api/owner/blocks', { match: { id: dave.id }, until: null, reason: 'console test' });
    expect(add.status).toBe(200);
    expect(blocked()).toBe(true);

    const list = await json(ownerTok, 'GET', '/api/owner/blocks');
    const entry = list.body.manual.find((b: any) => b.match.id === dave.id);
    expect(entry).toMatchObject({ until: null, reason: 'console test' });
    expect((await call(ownerTok, 'DELETE', '/api/owner/blocks', { source: 'manual', index: entry.index, match: { id: 'someone-else' } })).status).toBe(409);
    expect((await call(ownerTok, 'DELETE', '/api/owner/blocks', { source: 'manual', index: entry.index, match: entry.match })).status).toBe(200);
    expect(blocked()).toBe(false);

    // auto-block: exhaust a 1/h bucket past blockAfter
    const eve = fromAuthUser({ uid: `eve-${T}@console.test`, email: `eve-${T}@console.test` });
    for (let i = 0; i <= s.guard.limits.blockAfter + 1; i++) s.guard.check({ principal: eve, rank: 0, rate: '1/h' });
    const key = `principal:${eve.id}`;
    const auto = (await json(ownerTok, 'GET', '/api/owner/blocks')).body.auto;
    expect(auto.map((b: any) => b.key)).toContain(key);
    expect((await call(ownerTok, 'DELETE', '/api/owner/blocks', { source: 'auto', key })).status).toBe(200);
    expect((await json(ownerTok, 'GET', '/api/owner/blocks')).body.auto.map((b: any) => b.key)).not.toContain(key);
    expect((await call(ownerTok, 'DELETE', '/api/owner/blocks', { source: 'auto', key })).status).toBe(404);

    const targets = s.audit.query({ limit: 20, type: 'policy.change', principal: `user:${OWNER}` }).items.map(r => r.target);
    expect(targets).toEqual(expect.arrayContaining(['blocklist.add', 'blocklist.remove', `auto-block:${key}`]));
  }));

  test('audit: filtered query, cursor pagination, bad input 400, chain verify', () => asActive(async () => {
    const q = `/api/owner/audit?type=policy.change&principal=${encodeURIComponent(`user:${OWNER}`)}`;
    const all = await json(ownerTok, 'GET', `${q}&limit=500`);
    expect(all.status).toBe(200);
    expect(all.body.items.length).toBeGreaterThanOrEqual(3);
    expect(all.body.items.every((r: any) => r.type === 'policy.change' && r.principal === `user:${OWNER}`)).toBe(true);

    const p1 = await json(ownerTok, 'GET', `${q}&limit=1`);
    expect(p1.body.items).toHaveLength(1);
    expect(p1.body.nextCursor).toBeString();
    const p2 = await json(ownerTok, 'GET', `${q}&limit=1&cursor=${p1.body.nextCursor}`);
    expect(p2.body.items[0].hash).toBe(all.body.items[1].hash);

    const future = await json(ownerTok, 'GET', `/api/owner/audit?from=${Date.now() + 3_600_000}`);
    expect(future.body.items).toEqual([]);
    expect((await call(ownerTok, 'GET', '/api/owner/audit?from=not-a-date')).status).toBe(400);
    expect((await call(ownerTok, 'GET', '/api/owner/audit?cursor=garbage')).status).toBe(400);

    const v = await json(ownerTok, 'GET', '/api/owner/audit/verify');
    expect(v.status).toBe(200);
    expect(v.body).toMatchObject({ ok: true });
    expect(v.body.lines).toBeGreaterThan(0);
  }));
});
