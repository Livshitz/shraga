import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createServer } from 'node:net';
import type { ShragaInstance } from '../../../index.ts';

// Guard on the REAL booted server: POST /api/chat is denied before any engine run when SECURITY_ENFORCE=true,
// and admitted (audited only) in shadow mode. A probe engine stands in for the LLM, so nothing is spent.
delete process.env.DATA_SYNC_ENABLE;
delete process.env.DATA_SYNC_REPO;

const OWNER = `owner-${Date.now()}@guard-http.test`;
const BOB = `bob-${Date.now()}@guard-http.test`;
const prev = { owners: process.env.OWNERS, enforce: process.env.SECURITY_ENFORCE };

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
let engineRuns = 0;

beforeAll(async () => {
  process.env.OWNERS = OWNER;
  const { __resetExtensionsForTest } = await import('../../extensions.ts');
  const { __resetEventBusForTest } = await import('../../events/bus.ts');
  __resetExtensionsForTest();
  __resetEventBusForTest();
  const { registerEngine } = await import('../../engine/index.ts');
  registerEngine({
    name: 'guard-probe-engine',
    async *stream() { engineRuns++; yield { type: 'text_delta', text: 'hi' }; yield { type: 'done', sessionId: 's' }; },
    getModels: () => [],
  } as unknown as Parameters<typeof registerEngine>[0]);
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
  for (const [k, v] of [['OWNERS', prev.owners], ['SECURITY_ENFORCE', prev.enforce]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

const chat = (tok: string) => fetch(`${base}/api/chat`, {
  method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
  body: JSON.stringify({ prompt: '[engine:guard-probe-engine] hello', sync: true }),
});

describe('POST /api/chat guard', () => {
  test('enforce: a non-owner resolving to rate "0" gets 403 and the engine never runs; the owner is admitted', async () => {
    process.env.SECURITY_ENFORCE = 'true';
    const before = engineRuns;
    const denied = await chat(bobTok);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ reason: 'rate-zero' });
    expect(engineRuns).toBe(before);

    const ok = await chat(ownerTok);
    expect(ok.status).toBe(200);
    expect((await ok.json()).text).toBe('hi');
    expect(engineRuns).toBe(before + 1);
  });

  test('shadow: the same non-owner is admitted and the turn runs', async () => {
    delete process.env.SECURITY_ENFORCE;
    const before = engineRuns;
    const res = await chat(bobTok);
    expect(res.status).toBe(200);
    expect((await res.json()).text).toBe('hi');
    expect(engineRuns).toBe(before + 1);
  });
});
