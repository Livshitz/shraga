import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createServer } from 'node:net';
import type { ShragaInstance } from '../../index.ts';

// A real end-to-end test of the public library surface: createShraga → register a feature + a
// verified webhook + an event subscriber → start() (boots HTTP) → assert the registered surfaces
// are live → stop() (server closes). Booted in passive mode with signal handlers off so it doesn't
// spin up schedulers/consumers or hijack the test process's SIGINT.

// Neutralize any ambient data-sync config (a dev shell may export it) so start() never reaches out
// to a remote data repo — this test is hermetic, using the preload's temp DATA_DIR.
delete process.env.DATA_SYNC_ENABLE;
delete process.env.DATA_SYNC_REPO;

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

describe('createShraga — public library surface', () => {
  let app: ShragaInstance;
  let port: number;
  let events: unknown[] = [];

  beforeAll(async () => {
    // Hermetic: the extensions router + event bus are process-globals shared across test files. Reset
    // them so a prior file's booted server can't capture this server's pre-start webhook (→ 404). See
    // __resetExtensionsForTest / __resetEventBusForTest. bun's cross-file order differs macOS vs CI.
    const { __resetExtensionsForTest } = await import('../extensions.ts');
    const { __resetEventBusForTest } = await import('../events/bus.ts');
    __resetExtensionsForTest();
    __resetEventBusForTest();
    const { createShraga } = await import('../../index.ts');
    port = await freePort();
    app = createShraga({ port, authProvider: 'local', passive: true, installSignalHandlers: false });

    app.registerFeature({
      name: 'test-lib-feature',
      register(ctx) {
        ctx.app.get('/api/test-lib/ping', (_req, res) => res.json({ pong: true }));
      },
    });
    app.registerWebhook({
      source: 'test-lib-hook',
      verify: (_req, raw) => raw.length > 0,
    });
    app.on('test-lib-hook', (payload) => { events.push(payload); });

    await app.start();
  });

  afterAll(async () => {
    await app?.stop();
  });

  test('a registered feature route is served', async () => {
    const res = await fetch(`http://localhost:${port}/api/test-lib/ping`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pong: true });
  });

  test('a registered webhook verifies + emits a typed event to on() subscribers', async () => {
    const res = await fetch(`http://localhost:${port}/api/webhooks/test-lib-hook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'e1', hello: 'world' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    expect(events).toEqual([{ id: 'e1', hello: 'world' }]);
  });

  test('an empty webhook body is rejected (verify returned falsy)', async () => {
    const res = await fetch(`http://localhost:${port}/api/webhooks/test-lib-hook`, { method: 'POST' });
    expect(res.status).toBe(400);
  });

  test('the handle exposes app + emitEvent after start()', () => {
    expect(app.app).toBeDefined();
    expect(typeof app.emitEvent).toBe('function');
  });

  test('registering after start() throws (registrations must precede boot)', () => {
    expect(() => app.registerFeature({ name: 'too-late', register: () => {} })).toThrow(/before start/);
  });

  test('stop() closes the listener', async () => {
    await app.stop();
    await expect(fetch(`http://localhost:${port}/api/test-lib/ping`)).rejects.toBeDefined();
    // Re-open for afterAll idempotency check (stop is safe to call again).
    await app.stop();
  });
});
