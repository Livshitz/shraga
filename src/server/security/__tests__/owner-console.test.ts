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
    // main's resolution: internal-for-owner (a no-human lane acting for an OWNERS email) resolves as owner — see
    // resolution-agreement.test.ts. The owner ROUTES still refuse internal tokens (requireOwner), tested below.
    expect(results.map(r => r.role)).toEqual(['owner', 'member', 'anonymous', 'anonymous', 'guest', 'owner', 'owner', 'anonymous']);
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

  // A planted month entry (undeletable under chattr +a) must not blind the console: query + principals skip it,
  // verify names it. A far-future name sorts FIRST in the newest-first scan, so the query really meets it.
  test('audit + principals keep working with a planted month entry; verify reports it', () => asActive(async () => {
    const s = await sec();
    const { mkdirSync, rmdirSync } = await import('node:fs');
    const planted = `${s.audit.options.dir}/2099-01.jsonl`;
    const id = `user:planted-${T}@console.test`;
    s.record({ type: 'turn.start', principal: id, role: 'guest', sessionId: 'sp' });
    mkdirSync(planted);
    try {
      const q = await json(ownerTok, 'GET', `/api/owner/audit?principal=${encodeURIComponent(id)}&from=${Date.now() - 3_600_000}`);
      expect(q.status).toBe(200);
      expect(q.body.items.map((r: any) => r.principal)).toEqual([id]);
      const p = await json(ownerTok, 'GET', '/api/owner/principals?days=1');
      expect(p.status).toBe(200);
      expect(p.body.principals.find((r: any) => r.id === id)).toMatchObject({ turns: 1 });
      const v = await json(ownerTok, 'GET', '/api/owner/audit/verify');
      expect(v.body).toMatchObject({ ok: false, brokenAt: { file: '2099-01.jsonl', reason: 'not-regular-file' }, planted: ['2099-01.jsonl'] });
    } finally { rmdirSync(planted); }
    expect((await json(ownerTok, 'GET', '/api/owner/audit/verify')).body).toMatchObject({ ok: true });
  }));

  // The agent subprocess env carries an owner-signed internal token (engine/claude-code.ts) — it must not reach policy.
  test("owner-signed internal token → 403 on every owner/config/MCP/skills route; an uncapped owner key reads the console but can't write", () => asActive(async () => {
    const { signInternalToken } = await import('../../auth.ts');
    const internal = { 'x-internal-token': signInternalToken(OWNER, OWNER) };
    const key = (await json(ownerTok, 'POST', '/api/api-keys', { label: 'shraga term @ console' })).body.key as string;
    expect(key).toMatch(/^uck_/);
    const as = (h: Record<string, string>, method: string, url: string, body?: unknown) => fetch(`${base}${url}`, {
      method, headers: { 'content-type': 'application/json', ...h }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const keyH = { authorization: `Bearer ${key}` };
    const WRITES: [string, string, unknown?][] = [
      ['PUT', '/api/owner/policy', { policy: {}, version: 'x' }],
      ['POST', '/api/owner/blocks', { match: { id: 'user:x' } }],
      ['DELETE', '/api/owner/blocks', { source: 'auto', key: 'x' }],
      ['POST', '/api/owner/tokens/revoke', { principalId: `user:nobody-${T}@console.test` }],
      ['POST', '/api/owner/api-keys', { label: 'x' }],
      ['DELETE', '/api/owner/api-keys/nope'],
      ['DELETE', '/api/owner/sessions/nope'],
    ];
    const READS: [string, string, unknown?][] = [...ROUTES.filter(([m, u]) => !WRITES.some(([wm, wu]) => wm === m && wu === u)), ['GET', '/api/owner/api-keys']];
    const SYSTEM: [string, string, unknown?][] = [
      ['PUT', '/api/config', {}], ['PUT', '/api/mcps', {}], ['PUT', '/api/skills/zz-probe', { content: 'x' }], ['DELETE', '/api/skills/zz-probe'],
      ['POST', '/api/skills/zz-probe/duplicate', { newName: 'zz2' }], ['POST', '/api/skills/zz-probe/rename', { newName: 'zz2' }], ['PUT', '/api/skills-defaults', {}],
    ];
    for (const [method, url, body] of [...READS, ...WRITES, ...SYSTEM]) {
      expect({ via: 'internal', method, url, status: (await as(internal, method, url, body)).status }).toEqual({ via: 'internal', method, url, status: 403 });
    }
    for (const [method, url, body] of READS) {
      expect({ via: 'key', method, url, status: (await as(keyH, method, url, body)).status }).toEqual({ via: 'key', method, url, status: 200 });
    }
    for (const [method, url, body] of WRITES) {
      expect({ via: 'key', method, url, status: (await as(keyH, method, url, body)).status }).toEqual({ via: 'key', method, url, status: 403 });
    }
    // controls: the same writes pass the gate for an interactive login (reach the handler: 409/404/400/200, never 403)
    for (const [method, url, body] of WRITES) {
      expect({ via: 'login', method, url, status: (await call(ownerTok, method, url, body)).status }).not.toEqual({ via: 'login', method, url, status: 403 });
    }
    expect((await as(internal, 'GET', '/api/config')).status).toBe(200); // non-owner routes still work for the agent
  }));

  test('PUT policy: version is required; tokensValidAfter + blocklist always come from the current policy', () => asActive(async () => {
    const victim = `user:victim-${T}@console.test`;
    expect((await call(ownerTok, 'POST', '/api/owner/tokens/revoke', { principalId: victim })).status).toBe(200);
    expect((await call(ownerTok, 'POST', '/api/owner/blocks', { match: { id: victim }, until: null })).status).toBe(200);
    const doc = (await json(ownerTok, 'GET', '/api/owner/policy')).body;
    const { tokensValidAfter, blocklist, ...rest } = doc.policy;
    expect(tokensValidAfter[victim]).toBeNumber();
    expect(blocklist.some((b: any) => b.match.id === victim)).toBe(true);

    const noVersion = await json(ownerTok, 'PUT', '/api/owner/policy', { policy: rest });
    expect(noVersion.status).toBe(409);
    expect(noVersion.body.error).toMatch(/version is required/);

    const ok = await json(ownerTok, 'PUT', '/api/owner/policy', { policy: { ...rest, tokensValidAfter: {}, blocklist: [] }, version: doc.version });
    expect(ok.status).toBe(200);
    const after = (await json(ownerTok, 'GET', '/api/owner/policy')).body.policy;
    expect(after.tokensValidAfter).toEqual(tokensValidAfter);
    expect(after.blocklist).toEqual(blocklist);
  }));

  test('blocks: a manual block matching an OWNERS principal → 400; GET policy names the owner ids (UI hides Block)', () => asActive(async () => {
    expect((await json(ownerTok, 'GET', '/api/owner/policy')).body.ownerIds).toEqual([`user:${OWNER}`, `email:${OWNER}`]);
    const domain = OWNER.split('@')[1];
    for (const match of [{ id: `user:${OWNER}` }, { emailIn: [OWNER.toUpperCase()] }, { domain }, { kind: 'email', emailIn: [OWNER] }]) {
      const r = await json(ownerTok, 'POST', '/api/owner/blocks', { match, until: null });
      expect({ match, status: r.status }).toEqual({ match, status: 400 });
      expect(r.body.error).toMatch(/owner/);
    }
    const s = await sec();
    expect(s.policy.current.blocklist.some(b => canonicalId(b.match).includes(OWNER))).toBe(false);
  }));

  test('DELETE /api/owner/sessions/:id: login only, 409 while running, removes the conversation, audited without content', () => asActive(async () => {
    const sessions = await import('../../sessions.ts');
    const id = `console-del-${T}`;
    sessions.upsertSession(id, 'private prompt text', { uid: BOB, email: BOB });
    sessions.appendMessage(id, { id: 'm', role: 'user', blocks: [{ type: 'text', text: 'private message body' }] });
    const ac = new AbortController();
    sessions.acquireSessionLock(id, 'web', ac);
    expect((await call(ownerTok, 'DELETE', `/api/owner/sessions/${id}`)).status).toBe(409);
    sessions.releaseSessionLock(id, ac);
    expect((await call(ownerTok, 'DELETE', `/api/owner/sessions/${id}`)).status).toBe(200);
    expect(sessions.getSession(id)).toBeUndefined();
    expect(sessions.loadConversation(id)).toEqual([]);
    expect((await call(ownerTok, 'DELETE', `/api/owner/sessions/${id}`)).status).toBe(404);
    const rec = (await sec()).audit.query({ limit: 1, type: 'session.delete' }).items[0];
    expect(rec).toMatchObject({ principal: `user:${OWNER}`, sessionId: id, meta: { ownerUid: OWNER, sessionUid: BOB } });
    expect(JSON.stringify(rec)).not.toMatch(/private/);
  }));
});

const canonicalId = (m: object) => JSON.stringify(m);

test('DELETE /api/owner/sessions/:id on a PASSIVE standby → 409', async () => {
  expect((await call(ownerTok, 'DELETE', '/api/owner/sessions/whatever')).status).toBe(409);
});
