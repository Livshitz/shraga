import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createServer } from 'node:net';
import type { ShragaInstance } from '../../../index.ts';

// Owner gates on the REAL booted server (passive, local auth): admin mutations 403 for a non-owner,
// succeed for an owner; the api-keys list is filtered to the caller's own keys unless owner.
delete process.env.DATA_SYNC_ENABLE;
delete process.env.DATA_SYNC_REPO;

const OWNER = `owner-${Date.now()}@gates.test`;
const BOB = `bob-${Date.now()}@gates.test`;
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

const GATED: [string, string, unknown?][] = [
  ['PUT', '/api/config', {}],
  ['PUT', '/api/mcps', {}],
  ['PUT', '/api/skills/gate-probe', { content: 'x' }],
  ['DELETE', '/api/skills/gate-probe'],
  ['POST', '/api/skills/gate-probe/duplicate', { newName: 'gate-probe-2' }],
  ['POST', '/api/skills/gate-probe/rename', { newName: 'gate-probe-3' }],
  ['PUT', '/api/skills-defaults', []],
];

describe('owner-gated admin routes', () => {
  for (const [method, url, body] of GATED) {
    test(`${method} ${url} → 403 for a non-owner`, async () => {
      const res = await call(bobTok, method, url, body);
      expect(res.status).toBe(403);
      expect((await res.json()).error).toMatch(/Only an owner/);
    });
  }

  test('owner can still mutate (config round-trip, skill create + delete)', async () => {
    const cfg = await (await call(ownerTok, 'GET', '/api/config')).json();
    expect((await call(ownerTok, 'PUT', '/api/config', cfg)).status).toBe(200);
    expect((await call(ownerTok, 'PUT', '/api/skills/gate-probe', { content: '# probe' })).status).toBe(200);
    expect((await call(ownerTok, 'DELETE', '/api/skills/gate-probe')).status).toBe(200);
  });

  test('non-owner reads are unaffected', async () => {
    expect((await call(bobTok, 'GET', '/api/config')).status).toBe(200);
    expect((await call(bobTok, 'GET', '/api/skills')).status).toBe(200);
  });

  test('boot wires the security runtime; a PASSIVE instance writes no audit lines', async () => {
    const { security } = await import('../runtime.ts');
    const { dataPath } = await import('../../paths.ts');
    const sec = security();
    expect(sec).toBeDefined();
    expect(sec!.audit.options.dir).toBe(dataPath('audit'));
    const before = sec!.audit.query({ limit: 1000 }).items.length;
    await call(bobTok, 'GET', '/api/config');
    await call('sha_bogus.token', 'GET', '/api/config');
    expect(sec!.audit.query({ limit: 1000 }).items.length).toBe(before);
    expect(sec!.decide((await import('../principal.ts')).fromAuthUser({ uid: OWNER, email: OWNER })).role).toBe('owner');
  });

  test('GET /api/api-keys: own keys only for a non-owner, all for an owner', async () => {
    const mk = async (tok: string) => (await (await call(tok, 'POST', '/api/api-keys', { label: 'gate' })).json()) as { id: string };
    const ok = await mk(ownerTok), bk = await mk(bobTok);
    const bobList = (await (await call(bobTok, 'GET', '/api/api-keys')).json()).keys as { id: string; uid: string }[];
    expect(bobList.map(k => k.id)).toContain(bk.id);
    expect(bobList.map(k => k.id)).not.toContain(ok.id);
    expect(bobList.every(k => k.uid === BOB)).toBe(true);
    const ownerList = (await (await call(ownerTok, 'GET', '/api/api-keys')).json()).keys as { id: string }[];
    expect(ownerList.map(k => k.id)).toEqual(expect.arrayContaining([ok.id, bk.id]));
  });
});
