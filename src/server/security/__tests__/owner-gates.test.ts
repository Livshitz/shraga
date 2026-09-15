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

/** This server booted PASSIVE; run `fn` as the active instance would (key-store writes, audit). */
async function asActive<T>(fn: () => Promise<T>): Promise<T> {
  const sec = (await import('../runtime.ts')).security()!;
  const prev = sec.options.isActive;
  sec.options.isActive = () => true;
  try { return await fn(); } finally { sec.options.isActive = prev; }
}

const REDIRECT = 'https://client.test/cb';
async function consent(headers: Record<string, string>, codeChallenge = 'c'.repeat(43)) {
  const reg = await (await fetch(`${base}/oauth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: 'gate' }),
  })).json() as { client_id: string };
  const res = await fetch(`${base}/oauth/authorize/consent`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: codeChallenge, code_challenge_method: 'S256' }),
  });
  return Object.assign(res, { clientId: reg.client_id });
}
/** Consent with a real PKCE pair, then return a function that exchanges the code at /oauth/token. */
async function mintCode(tok: string) {
  const verifier = 'v'.repeat(50);
  const challenge = (await import('node:crypto')).createHash('sha256').update(verifier).digest('base64url');
  const res = await consent({ authorization: `Bearer ${tok}` }, challenge);
  const { code } = await res.json() as { code: string };
  return () => fetch(`${base}/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: res.clientId, code_verifier: verifier }),
  });
}

const GATED: [string, string, unknown?][] = [
  ['PUT', '/api/config', {}],
  ['PUT', '/api/mcps', {}],
  ['PUT', '/api/skills/gate-probe', { content: 'x' }],
  ['DELETE', '/api/skills/gate-probe'],
  ['POST', '/api/skills/gate-probe/duplicate', { newName: 'gate-probe-2' }],
  ['POST', '/api/skills/gate-probe/rename', { newName: 'gate-probe-3' }],
  ['PUT', '/api/skills-defaults', []],
  ['POST', '/api/owner/tokens/revoke', { principalId: 'user:x@y.test' }],
  ['GET', '/api/owner/api-keys'],
  ['POST', '/api/owner/api-keys', { label: 'x', role: 'member' }],
  ['DELETE', '/api/owner/api-keys/nope'],
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

  test('GET /api/config exposes derived isOwner; PUT never persists it', async () => {
    const cfg = await (await call(ownerTok, 'GET', '/api/config')).json();
    expect(cfg.isOwner).toBe(true);
    expect((await (await call(bobTok, 'GET', '/api/config')).json()).isOwner).toBe(false);
    expect((await call(ownerTok, 'PUT', '/api/config', cfg)).status).toBe(200); // client echoes it back
    const { readFileSync } = await import('node:fs');
    const { dataPath } = await import('../../paths.ts');
    const onDisk = JSON.parse(readFileSync(dataPath('agent-config.json'), 'utf8'));
    expect('isOwner' in onDisk).toBe(false);
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

  test('PASSIVE: key-store writes on both mounts → 409', async () => {
    expect((await call(bobTok, 'POST', '/api/api-keys', { label: 'x' })).status).toBe(409);
    expect((await call(bobTok, 'DELETE', '/api/api-keys/nope')).status).toBe(409);
    expect((await call(ownerTok, 'POST', '/api/owner/api-keys', { label: 'x' })).status).toBe(409);
    expect((await call(ownerTok, 'DELETE', '/api/owner/api-keys/nope')).status).toBe(409);
    expect((await call(bobTok, 'GET', '/api/api-keys')).status).toBe(200);
  });

  test('self mount ignores role/expiresAt; delete is audited with the caller principal id', () => asActive(async () => {
    const k = await (await call(bobTok, 'POST', '/api/api-keys', { label: 'self', role: 'operator', expiresAt: Date.now() + 1000 })).json();
    expect(k.role).toBeUndefined();
    expect(k.expiresAt).toBeUndefined();
    expect((await call(ownerTok, 'DELETE', `/api/api-keys/${k.id}`)).status).toBe(200);
    const sec = (await import('../runtime.ts')).security()!;
    const recs = sec.audit.query({ limit: 100, type: ['key.create', 'key.revoke'] }).items.filter(r => r.target === `apikey:${k.id}`);
    expect(recs.map(r => [r.type, r.principal]).sort()).toEqual([['key.create', `user:${BOB}`], ['key.revoke', `user:${OWNER}`]]);
  }));

  test('GET /api/api-keys: own keys only for a non-owner, all for an owner', () => asActive(async () => {
    const mk = async (tok: string) => (await (await call(tok, 'POST', '/api/api-keys', { label: 'gate' })).json()) as { id: string };
    const ok = await mk(ownerTok), bk = await mk(bobTok);
    const bobList = (await (await call(bobTok, 'GET', '/api/api-keys')).json()).keys as { id: string; uid: string }[];
    expect(bobList.map(k => k.id)).toContain(bk.id);
    expect(bobList.map(k => k.id)).not.toContain(ok.id);
    expect(bobList.every(k => k.uid === BOB)).toBe(true);
    const ownerList = (await (await call(ownerTok, 'GET', '/api/api-keys')).json()).keys as { id: string }[];
    expect(ownerList.map(k => k.id)).toEqual(expect.arrayContaining([ok.id, bk.id]));
  }));
});

describe('API keys never act as owner, and only an interactive login mints keys', () => {
  test("an owner's key (no role, or guest-capped) → 403 on owner routes, isOwner false; a scoped internal token for the owner stays owner", () => asActive(async () => {
    (await import('../runtime.ts')).security()!.activate(); // booted PASSIVE: load the policy so role "guest" exists
    const mint = async (body: Record<string, unknown>) => {
      const r = await call(ownerTok, 'POST', '/api/owner/api-keys', body);
      const j = await r.json();
      expect({ status: r.status, j }).toMatchObject({ status: 200 });
      return j.key as string;
    };
    const plain = await mint({ label: 'owner-plain' }), capped = await mint({ label: 'owner-guest', role: 'guest' });
    const mcps = await (await call(ownerTok, 'GET', '/api/mcps')).json();
    for (const key of [plain, capped]) {
      expect(key).toMatch(/^uck_/);
      expect((await (await call(key, 'GET', '/api/config')).json()).isOwner).toBe(false);
      expect((await call(key, 'PUT', '/api/mcps', mcps)).status).toBe(403);
      expect((await call(key, 'GET', '/api/owner/api-keys')).status).toBe(403);
      expect((await call(key, 'POST', '/api/owner/tokens/revoke', { principalId: `user:${BOB}` })).status).toBe(403);
      // the escalation chain: a (capped) key minting an uncapped one, on either mount
      expect((await call(key, 'POST', '/api/owner/api-keys', { label: 'escalated' })).status).toBe(403);
      const self = await call(key, 'POST', '/api/api-keys', { label: 'escalated-self' });
      expect(self.status).toBe(403);
      expect((await self.json()).error).toMatch(/interactive login/);
    }
    const { signInternalToken } = await import('../../auth.ts');
    const internal = { 'x-internal-token': signInternalToken(OWNER, OWNER) };
    const cfg = await fetch(`${base}/api/config`, { headers: internal });
    expect((await cfg.json()).isOwner).toBe(true);
    expect((await fetch(`${base}/api/api-keys`, { method: 'POST', headers: { ...internal, 'content-type': 'application/json' }, body: '{}' })).status).toBe(403);
    expect((await call(ownerTok, 'POST', '/api/api-keys', { label: 'login-control' })).status).toBe(200); // control
  }));
});

describe('MCP OAuth consent requires an interactive login', () => {
  test("owner's API key and internal token → 403 + auth.deny audited; an interactive login still gets a code", async () => {
    const sec = (await import('../runtime.ts')).security()!;
    const prevActive = sec.options.isActive;
    sec.options.isActive = () => true; // this server booted PASSIVE (no audit writes); the deny line is what we assert
    try {
      const login = await consent({ authorization: `Bearer ${ownerTok}` });
      expect(login.status).toBe(200);
      expect((await login.json()).code).toMatch(/^[0-9a-f]{64}$/);

      const apiKey = (await (await call(ownerTok, 'POST', '/api/api-keys', { label: 'oauth-probe' })).json()).key as string;
      expect(apiKey).toMatch(/^uck_/);
      const byKey = await consent({ authorization: `Bearer ${apiKey}` });
      expect(byKey.status).toBe(403);
      expect((await byKey.json()).error).toBe('access_denied');

      const { signInternalToken } = await import('../../auth.ts');
      const byInternal = await consent({ 'x-internal-token': signInternalToken(OWNER, OWNER) });
      expect(byInternal.status).toBe(403);

      const denies = sec.audit.query({ limit: 100, type: 'auth.deny' }).items.filter(r => r.target === 'oauth:consent');
      expect(denies.map(r => r.reason).sort()).toEqual(['non-interactive:apikey', 'non-interactive:internal']);
    } finally { sec.options.isActive = prevActive; }
  });
});

describe('owner routes (/api/owner/*) for an owner', () => {
  test('api keys: create (expiry) → authenticates → listed without secret → revoke → 401', () => asActive(async () => {
    const created = await (await call(ownerTok, 'POST', '/api/owner/api-keys', { label: 'owner-probe', expiresAt: Date.now() + 60_000 })).json();
    expect(created.key).toMatch(/^uck_/);
    expect((await call(created.key, 'GET', '/api/config')).status).toBe(200);
    const list = (await (await call(ownerTok, 'GET', '/api/owner/api-keys')).json()).keys as Record<string, unknown>[];
    const row = list.find(k => k.id === created.id)!;
    expect(row).toMatchObject({ label: 'owner-probe', expiresAt: created.expiresAt });
    expect(JSON.stringify(list)).not.toContain(created.key);
    expect((await call(ownerTok, 'DELETE', `/api/owner/api-keys/${created.id}`)).status).toBe(200);
    expect((await call(created.key, 'GET', '/api/config')).status).toBe(401);
    expect((await call(ownerTok, 'POST', '/api/owner/api-keys', { role: 'owner' })).status).toBe(400);
  }));

  test('token revoke: refused while PASSIVE; once active, the revoked user\'s old token 401s and a fresh login works', async () => {
    const passive = await call(ownerTok, 'POST', '/api/owner/tokens/revoke', { principalId: `user:${BOB}` });
    expect(passive.status).toBe(409);
    expect((await call(ownerTok, 'POST', '/api/owner/tokens/revoke', { principalId: 'nope' })).status).toBe(400);
    expect((await call(ownerTok, 'POST', '/api/owner/tokens/revoke', { principalId: `user:${BOB}​` })).status).toBe(400);
    const legacy = await call(ownerTok, 'POST', '/api/owner/tokens/revoke', { principalId: 'internal:agent-internal' });
    expect(legacy.status).toBe(400);
    expect((await legacy.json()).error).toMatch(/INTERNAL_API_TOKEN/);
    for (const principalId of ['apikey:abc', `email:${BOB}`, 'slack:U1']) {
      const r = await call(ownerTok, 'POST', '/api/owner/tokens/revoke', { principalId });
      expect(r.status).toBe(400);
      expect((await r.json()).error).toMatch(/api-keys/);
    }

    const sec = (await import('../runtime.ts')).security()!;
    const prevActive = sec.options.isActive;
    sec.options.isActive = () => true;
    try {
      sec.activate(); // loads/migrates the policy as the active instance would
      expect(sec.policy.valid).toBe(true);
      expect((await call(ownerTok, 'POST', '/api/owner/api-keys', { label: 'member', role: 'member' })).status).toBe(200);
      expect((await call(bobTok, 'GET', '/api/config')).status).toBe(200);
      const staleExchange = await mintCode(bobTok); // MCP auth code minted before the revocation
      await Bun.sleep(1100); // 1s granularity
      const r = await call(ownerTok, 'POST', '/api/owner/tokens/revoke', { principalId: `user:${BOB.toUpperCase()}` });
      expect(r.status).toBe(200);
      expect((await r.json()).principalId).toBe(`user:${BOB}`); // normalized to the stored (lowercase) id
      expect((await call(bobTok, 'GET', '/api/config')).status).toBe(401);
      const stale = await staleExchange();
      expect(stale.status).toBe(400);
      expect((await stale.json()).error).toBe('invalid_grant');
      const { localLogin } = await import('../../auth.ts');
      const fresh = localLogin(BOB, 'pw-bob')!;
      expect((await call(fresh, 'GET', '/api/config')).status).toBe(200);
      expect((await (await mintCode(fresh))()).status).toBe(200); // control: a code minted after the revocation exchanges
      expect((await call(ownerTok, 'GET', '/api/config')).status).toBe(200);
    } finally { sec.options.isActive = prevActive; }
  });
});
