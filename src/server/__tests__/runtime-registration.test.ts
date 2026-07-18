import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createServer } from 'node:net';
import type { ShragaInstance, ServerHandle } from '../../index.ts';

// End-to-end test of OPT-IN runtime plug-and-play: createShraga({ runtimeRegistration: true }) →
// start() → register an extension + webhook AND subscribe to an event AFTER boot → assert each is
// live on the real running server. Plus the guard: with the flag off, the same handle methods throw.
// Passive + no signal handlers so it doesn't spin schedulers or hijack the test process's SIGINT.

// Neutralize ambient data-sync config (a dev shell may export it) so start() stays hermetic.
delete process.env.DATA_SYNC_ENABLE;
delete process.env.DATA_SYNC_REPO;
// Ambient flag must not leak into the guard test below.
delete process.env.SHRAGA_RUNTIME_REGISTRATION;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

describe('runtime registration — enabled (opt-in)', () => {
  let app: ShragaInstance;
  let handle: ServerHandle;
  let port: number;
  const events: unknown[] = [];

  beforeAll(async () => {
    // Hermetic reset of the process-global extensions router + event bus (shared across test files):
    // isolates this boot from a prior file's server and keeps this file from leaking into later ones.
    const { __resetExtensionsForTest } = await import('../extensions.ts');
    const { __resetEventBusForTest } = await import('../events/bus.ts');
    __resetExtensionsForTest();
    __resetEventBusForTest();
    const { createShraga } = await import('../../index.ts');
    port = await freePort();
    app = createShraga({ port, authProvider: 'local', passive: true, installSignalHandlers: false, runtimeRegistration: true });
    handle = await app.start();

    // AFTER start(): register an extension (plain route), a webhook, and an event subscriber.
    await handle.registerExtension((router) => {
      router.get('/api/rt/hello', (_req, res) => res.json({ from: 'runtime-extension' }));
    });
    await handle.registerWebhook({ source: 'rt-hook', verify: (_req, raw) => raw.length > 0 });
    handle.on('rt-hook', (payload) => { events.push(payload); });
  });

  afterAll(async () => { await app?.stop(); });

  test('a runtime-registered extension route is served (non-SPA)', async () => {
    const res = await fetch(`http://localhost:${port}/api/rt/hello`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ from: 'runtime-extension' });
  });

  test('a runtime-registered webhook verifies + emits to a runtime on() subscriber', async () => {
    const res = await fetch(`http://localhost:${port}/api/webhooks/rt-hook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'e1', hi: 'there' }),
    });
    expect(res.status).toBe(200);
    expect(events).toEqual([{ id: 'e1', hi: 'there' }]);
  });

  test('a runtime on() subscriber fires on a direct emit', async () => {
    const got: unknown[] = [];
    const off = handle.on('rt-direct', (p) => got.push(p));
    handle.emitEvent('rt-direct', { n: 7 });
    off();
    handle.emitEvent('rt-direct', { n: 8 }); // after unsubscribe — must NOT be seen
    expect(got).toEqual([{ n: 7 }]);
  });
});

describe('runtime registration — disabled (guard)', () => {
  let app: ShragaInstance;
  let handle: ServerHandle;

  beforeAll(async () => {
    const { __resetExtensionsForTest } = await import('../extensions.ts');
    const { __resetEventBusForTest } = await import('../events/bus.ts');
    __resetExtensionsForTest();
    __resetEventBusForTest();
    const { createShraga } = await import('../../index.ts');
    const port = await freePort();
    // Default: runtimeRegistration omitted → off.
    app = createShraga({ port, authProvider: 'local', passive: true, installSignalHandlers: false });
    handle = await app.start();
  });

  afterAll(async () => { await app?.stop(); });

  test('registerExtension after start() throws a clear opt-in error', () => {
    expect(() => handle.registerExtension(() => {})).toThrow(/runtimeRegistration/);
  });

  test('registerWebhook after start() throws', () => {
    expect(() => handle.registerWebhook({ source: 'nope', verify: () => true })).toThrow(/runtimeRegistration/);
  });

  test('on() after start() throws', () => {
    expect(() => handle.on('nope', () => {})).toThrow(/runtimeRegistration/);
  });
});
