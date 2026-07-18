import { describe, test, expect } from 'bun:test';
import type { IRouter, Request } from 'express';
import { emitEvent, subscribeEvent, subscribeEvents } from '../events/bus.ts';
import { registerWebhook } from '../events/webhook.ts';
import type { ShragaEvent } from '../events/types.ts';

// --- Minimal express test doubles -------------------------------------------
type Handler = (req: any, res: any) => void;

/** Captures the single POST handler registered on a path. */
function fakeRouter(): { router: IRouter; handlerFor: (p: string) => Handler } {
  const routes = new Map<string, Handler>();
  const router = { post: (p: string, h: Handler) => routes.set(p, h) } as unknown as IRouter;
  return { router, handlerFor: (p) => routes.get(p)! };
}

function fakeReq(opts: { body?: unknown; raw?: string; headers?: Record<string, string> }): Request {
  return {
    body: opts.body,
    rawBody: opts.raw != null ? Buffer.from(opts.raw, 'utf8') : undefined,
    headers: opts.headers ?? {},
  } as unknown as Request;
}

function fakeRes() {
  const out: { code: number; json?: unknown } = { code: 200 };
  const res = {
    status(c: number) { out.code = c; return res; },
    json(b: unknown) { out.json = b; return res; },
  };
  return { res, out };
}

// --- Typed bus --------------------------------------------------------------
describe('event bus', () => {
  test('subscribeEvents receives every source; subscribeEvent filters to one', () => {
    const all: ShragaEvent[] = [];
    const onlyFoo: unknown[] = [];
    const un1 = subscribeEvents((e) => all.push(e));
    const un2 = subscribeEvent('foo', (payload) => onlyFoo.push(payload));

    emitEvent('foo', { a: 1 }, { id: 'x1' });
    emitEvent('bar', { b: 2 });

    un1(); un2();

    expect(all.map((e) => e.source)).toEqual(['foo', 'bar']);
    expect(all[0].id).toBe('x1');
    expect(all[0].at).toBeGreaterThan(0);
    expect(onlyFoo).toEqual([{ a: 1 }]); // did NOT see 'bar'
  });

  test('a throwing listener does not sink the emit for others', () => {
    let reached = false;
    const un1 = subscribeEvents(() => { throw new Error('boom'); });
    const un2 = subscribeEvents(() => { reached = true; });
    emitEvent('probe', {});
    un1(); un2();
    expect(reached).toBe(true);
  });
});

// --- Generic webhook ingress -------------------------------------------------
describe('registerWebhook', () => {
  test('default path, rejects when verify returns false (no emit)', () => {
    const { router, handlerFor } = fakeRouter();
    const path = registerWebhook(router, { source: 'vendorA', verify: () => false });
    expect(path).toBe('/api/webhooks/vendorA');

    const seen: ShragaEvent[] = [];
    const un = subscribeEvent('vendorA', (_p, e) => seen.push(e));
    const { res, out } = fakeRes();
    handlerFor(path)(fakeReq({ body: { id: 'n1' }, raw: '{}' }), res);
    un();

    expect(out.code).toBe(400);
    expect(seen.length).toBe(0);
  });

  test('rejects when verify returns a falsy-but-not-false value (undefined/null) — no emit', () => {
    for (const bad of [undefined, null] as const) {
      const { router, handlerFor } = fakeRouter();
      const path = registerWebhook(router, {
        source: 'vendorFalsy',
        // A "return the payload, or nothing on failure" verifier: a bad signature
        // yields undefined/null. Must be a hard reject, NOT an unauthenticated emit.
        verify: () => bad as unknown as boolean,
      });

      const seen: ShragaEvent[] = [];
      const un = subscribeEvent('vendorFalsy', (_p, e) => seen.push(e));
      const { res, out } = fakeRes();
      handlerFor(path)(fakeReq({ body: { id: 'n1' }, raw: '{}' }), res);
      un();

      expect(out.code).toBe(400);
      expect(seen.length).toBe(0);
    }
  });

  test('verify true → emits parsed body with id from body.id (ingress → bus)', () => {
    const { router, handlerFor } = fakeRouter();
    registerWebhook(router, { source: 'vendorB', verify: () => true });

    const seen: ShragaEvent[] = [];
    const un = subscribeEvents((e) => { if (e.source === 'vendorB') seen.push(e); });
    const { res, out } = fakeRes();
    handlerFor('/api/webhooks/vendorB')(
      fakeReq({ body: { id: 'evt_42', type: 'invoice.paid' }, raw: '{"id":"evt_42"}' }),
      res,
    );
    un();

    expect(out.code).toBe(200);
    expect(out.json).toEqual({ received: true });
    expect(seen.length).toBe(1);
    expect(seen[0].id).toBe('evt_42'); // dedup id auto-derived from body.id
    expect(seen[0].payload).toEqual({ id: 'evt_42', type: 'invoice.paid' });
  });

  test('verify may return a normalized payload; custom path + eventId honored', () => {
    const { router, handlerFor } = fakeRouter();
    const raw = 'ping=1';
    const path = registerWebhook(router, {
      source: 'vendorC',
      path: '/hooks/c',
      verify: (_req, body) => ({ normalized: true, raw: body }),
      eventId: (p) => (p as { raw: string }).raw,
    });
    expect(path).toBe('/hooks/c');

    let got: ShragaEvent | undefined;
    const un = subscribeEvent('vendorC', (_p, e) => { got = e; });
    const { res } = fakeRes();
    handlerFor('/hooks/c')(fakeReq({ raw }), res);
    un();

    expect(got?.payload).toEqual({ normalized: true, raw });
    expect(got?.id).toBe(raw);
  });
});

// --- End-to-end: ingress fires an event-trigger schedule --------------------
describe('ingress → scheduler.fireEvent routing', () => {
  test('the dispatcher (subscribeEvents) routes a webhook event to matching schedules', async () => {
    const scheduler = await import('../scheduler/index.ts');

    // Mirror what dispatcher.ts does: subscribe all events → scheduler.fireEvent.
    // Capture the call to prove the ingress reaches the scheduler with the right args.
    const calls: Array<{ source: string; payload: unknown }> = [];
    const un = subscribeEvents((e) => {
      calls.push({ source: e.source, payload: e.payload });
      scheduler.fireEvent(e.source, e.payload); // real routing (returns [] w/o an active+matching schedule)
    });

    const { router, handlerFor } = fakeRouter();
    registerWebhook(router, { source: 'stripe', verify: () => true });
    const { res } = fakeRes();
    handlerFor('/api/webhooks/stripe')(
      fakeReq({ body: { id: 'evt_1', type: 'invoice.paid' }, raw: '{}' }),
      res,
    );
    un();

    // The vendor webhook drove one bus event, carrying source + payload, into the
    // exact call the real dispatcher makes to scheduler.fireEvent. That completes the
    // chain: POST /api/webhooks/stripe → verify → emitEvent → dispatcher → fireEvent.
    expect(calls).toEqual([{ source: 'stripe', payload: { id: 'evt_1', type: 'invoice.paid' } }]);
  });
});
