/**
 * WebhookStreamer wire contract. Not "does it call fetch" — the three properties an external
 * receiver actually depends on, each asserted against a real HTTP receiver rather than a mock:
 *   1. the signature it produces is the one the receiver verifies (`connId.deliveryId.ts.rawBody`),
 *   2. every delivery carries a UNIQUE id, or a receiver's replay guard eats every delta after the first,
 *   3. it ACCUMULATES and serializes, so the row never rewinds mid-stream.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createHmac } from 'node:crypto';
import { WebhookStreamer, postNotice, postDelivery, signDelivery, clampText, clampArgs, MAX_TOOL_ARGS_CHARS, MAX_TOOL_RESULT_CHARS, MAX_TOOL_SEGMENTS, type WebhookTarget } from '../webhook-lane/streamer.ts';

type Received = { body: any; headers: Record<string, string> };
let received: Received[] = [];
let server: ReturnType<typeof Bun.serve>;
let cb: WebhookTarget;
let nextStatus = 200;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const raw = await req.text();
      received.push({
        body: JSON.parse(raw),
        headers: Object.fromEntries([...req.headers].map(([k, v]) => [k.toLowerCase(), v])),
      });
      // Stash the raw bytes the signature was computed over — re-serializing would diverge.
      (received[received.length - 1] as any).raw = raw;
      return new Response(JSON.stringify({ ok: nextStatus === 200 }), { status: nextStatus });
    },
  });
  cb = { url: `http://127.0.0.1:${server.port}/hook`, secret: 'shared-secret', connId: 'ab'.repeat(12) };
});
afterAll(() => server.stop(true));

const reset = () => { received = []; nextStatus = 200; };

describe('signature', () => {
  test('is exactly what a receiver verifies: HMAC-SHA256 over `connId.deliveryId.ts.rawBody`', async () => {
    reset();
    await postDelivery(cb, { type: 'post', convId: 'c1', text: 'hi' });
    const r = received[0] as any;
    const ts = Number(r.headers['x-agent-timestamp']);
    const delivery = r.headers['x-agent-delivery'];
    // Recomputed here from the contract, NOT by calling signDelivery — otherwise this would only prove
    // the function equals itself.
    const expected = 'v1=' + createHmac('sha256', cb.secret).update(`${cb.connId}.${delivery}.${ts}.${r.raw}`).digest('hex');
    expect(r.headers['x-agent-signature']).toBe(expected);
    expect(r.headers['x-agent-conn']).toBe(cb.connId);
    expect(Math.abs(Date.now() - ts)).toBeLessThan(30_000);
  });

  test('the delivery id in the header is the one that was SIGNED — they must not diverge', () => {
    // The header and the signed material are minted from one `delivery` const. If the header were
    // ever re-generated separately, every delivery would 401 on arrival; if the signature were,
    // the replay bind would be silently worthless. Recomputed from the contract, as above.
    const r = received[0] as any;
    const ts = Number(r.headers['x-agent-timestamp']);
    expect(signDelivery(cb.secret, cb.connId, r.headers['x-agent-delivery'], ts, r.raw))
      .toBe(r.headers['x-agent-signature']);
  });

  test('signDelivery matches that same contract', () => {
    expect(signDelivery('s', 'cid', 'dlv', 5, 'body')).toBe(
      'v1=' + createHmac('sha256', 's').update('cid.dlv.5.body').digest('hex'),
    );
  });

  test('a different connection id produces a different signature (cross-binding)', () => {
    expect(signDelivery('s', 'a', 'd', 5, 'b')).not.toBe(signDelivery('s', 'z', 'd', 5, 'b'));
  });

  test('a different DELIVERY id produces a different signature (replay bind)', () => {
    expect(signDelivery('s', 'a', 'd1', 5, 'b')).not.toBe(signDelivery('s', 'a', 'd2', 5, 'b'));
  });
});

describe('deliveries', () => {
  test('each carries a UNIQUE x-agent-delivery — a shared id would be replay-dropped', async () => {
    reset();
    const s = new WebhookStreamer({ callback: cb, convId: 'c1', msgId: 'm1', flushInterval: 5, flushThreshold: 1 });
    for (const t of ['a', 'b', 'c']) s.feed({ type: 'text_delta', text: t });
    await s.finish();
    const ids = received.map(r => r.headers['x-agent-delivery']);
    expect(ids.length).toBeGreaterThan(1);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('text ACCUMULATES and never rewinds — each payload extends the previous', async () => {
    reset();
    const s = new WebhookStreamer({ callback: cb, convId: 'c1', msgId: 'm1', flushInterval: 5, flushThreshold: 1 });
    for (const t of ['Hello', ' there', ' world']) {
      s.feed({ type: 'text_delta', text: t });
      await new Promise(r => setTimeout(r, 30));
    }
    const final = await s.finish();
    const texts = received.map(r => r.body.text);
    for (let i = 1; i < texts.length; i++) expect(texts[i].startsWith(texts[i - 1])).toBe(true);
    expect(final).toBe('Hello there world');
    expect(received[received.length - 1].body.type).toBe('final');
  });

  test('finish() settles the row even when nothing was streamed', async () => {
    reset();
    const s = new WebhookStreamer({ callback: cb, convId: 'c1', msgId: 'm1' });
    expect(await s.finish()).toBe('(no output)');
    expect(received[0].body).toMatchObject({ type: 'final', convId: 'c1', msgId: 'm1' });
  });

  test('fail() settles the row visibly instead of leaving a permanent "typing…"', async () => {
    reset();
    const s = new WebhookStreamer({ callback: cb, convId: 'c1', msgId: 'm1' });
    s.feed({ type: 'text_delta', text: 'partial' });
    await s.fail('the engine died');
    expect(received[received.length - 1].body).toMatchObject({ type: 'error', message: 'the engine died' });
  });

  test('a tool call becomes an in-band marker, not a separate structured event', async () => {
    reset();
    const s = new WebhookStreamer({ callback: cb, convId: 'c1', msgId: 'm1', flushInterval: 5, flushThreshold: 1 });
    s.feed({ type: 'tool_use', tool: 'Bash' });
    await new Promise(r => setTimeout(r, 40));
    await s.finish();
    expect(received.every(r => r.body.type === 'delta' || r.body.type === 'final')).toBe(true);
    expect(received[received.length - 1].body.text).toContain('Bash');
  });
});

describe('failure handling', () => {
  test('a rejected delivery returns false and does not throw — one 403 must not kill the turn', async () => {
    reset();
    nextStatus = 403;
    expect(await postNotice(cb, 'c1', 'nope')).toBe(false);
  });

  test('an unreachable endpoint returns false rather than throwing', async () => {
    reset();
    const dead: WebhookTarget = { ...cb, url: 'http://127.0.0.1:1/hook' };
    expect(await postDelivery(dead, { type: 'post', convId: 'c1', text: 'x' })).toBe(false);
  });

  test('a proactive post carries no msgId — the receiver mints the row', async () => {
    reset();
    await postNotice(cb, 'c1', 'deploy done');
    expect(received[0].body).toEqual({ type: 'post', convId: 'c1', text: 'deploy done' });
  });
});

// ── FROZEN SIGNATURE VECTOR ──────────────────────────────────────────────────────────────────────
//
// A known-answer vector for `signDelivery`, name-neutral and checkout-independent.
//
// WHY A FROZEN DIGEST AND NOT A RECOMPUTATION. Every other signature test in this file recomputes
// the material inside this repo, so an edit to the material passes both the code and the test —
// green here, 401 on every delta at the receiver, which reimplements this in ITS codebase. A frozen
// digest is the only assertion that fails on exactly that edit.
//
// The vector deliberately exercises what a re-serialization would break: a non-ASCII char, an
// escaped quote, and a solidus.
//
// If you are here because this test failed: the signature material changed. That is a BREAKING WIRE
// CHANGE for every receiver built on this seam. Do not update the digest to make it pass — decide
// whether you meant it, then version the change on both sides.
//
// An add-on wiring a specific product should freeze ITS OWN vector too, in its own repo, using the
// real secret/ids/paths of that contract. This one only pins the core's algorithm.
const VECTOR = {
  material: '{connId}.{deliveryId}.{ts}.{rawBody}',
  secret: 'webhook-lane contract vector',
  connId: '0123456789abcdef01234567',
  deliveryId: '11111111-2222-3333-4444-555555555555',
  ts: 1700000000000,
  rawBody: '{"type":"final","convId":"conv_1","msgId":"msg_1","text":"héllo \\"quoted\\" / slash"}',
  signature: 'v1=b70156a09f89b26e9d994444261a0248b494b32a719de1c5d8b9323904431c1a',
  /** Transport seam, pinned for the same reason: a header rename is a silent 401. */
  deliveryHeader: 'x-agent-delivery',
  connHeader: 'x-agent-conn',
  tsHeader: 'x-agent-timestamp',
  sigHeader: 'x-agent-signature',
};

describe('frozen signature contract', () => {
  test('signDelivery reproduces the frozen vector exactly', () => {
    expect(signDelivery(VECTOR.secret, VECTOR.connId, VECTOR.deliveryId, VECTOR.ts, VECTOR.rawBody))
      .toBe(VECTOR.signature);
  });

  test('the headers this sender actually puts on the wire match the vector', async () => {
    const seen: Record<string, string> = {};
    const srv = Bun.serve({
      port: 0,
      async fetch(req) { req.headers.forEach((v, k) => { seen[k.toLowerCase()] = v; }); return new Response('{}'); },
    });
    const url = `http://127.0.0.1:${srv.port}/hook`;
    await postDelivery({ url, secret: VECTOR.secret, connId: VECTOR.connId }, { type: 'post', convId: 'c', text: 'x' });
    srv.stop(true);
    expect(new URL(url).search).toBe('');            // the connection id travels in the header only
    for (const h of [VECTOR.connHeader, VECTOR.tsHeader, VECTOR.sigHeader, VECTOR.deliveryHeader]) {
      expect(seen[h]).toBeTruthy();
    }
    expect(seen[VECTOR.connHeader]).toBe(VECTOR.connId);
  });
});

// ── The wedge ────────────────────────────────────────────────────────────────
//
// `fetch` has no default timeout, and flushes are serialized through `flushChain` which `finish()`
// awaits. So a receiver that ACCEPTS the connection and then never answers does not fail a delta —
// it stops the turn, permanently and silently: no `final`, no log line, the row frozen mid-sentence.
// These tests are written against a receiver that does exactly that, and each one carries its own
// in-process NEGATIVE CONTROL (the same assertion with the bound removed, which must NOT hold).
describe('a hung receiver', () => {
  let hangServer: ReturnType<typeof Bun.serve>;
  let releaseHang: () => void;
  const held = new Promise<void>((r) => { releaseHang = r; });
  let hangCb: WebhookTarget;

  beforeAll(() => {
    hangServer = Bun.serve({
      port: 0,
      async fetch() { await held; return new Response('late', { status: 200 }); },
    });
    hangCb = { url: `http://127.0.0.1:${hangServer.port}/hook`, secret: 's', connId: 'cd'.repeat(12) };
  });
  afterAll(() => { releaseHang(); hangServer.stop(true); });

  test('postDelivery gives up on the clock instead of waiting forever', async () => {
    const t0 = Date.now();
    expect(await postDelivery(hangCb, { type: 'post', convId: 'c', text: 'hi' }, 250)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(3_000);

    // NEGATIVE CONTROL — the pre-fix behaviour. With an effectively unbounded timeout the same
    // call has still not resolved after 1s; `false` here would mean the receiver isn't hanging and
    // the test above proves nothing.
    const unbounded = postDelivery(hangCb, { type: 'post', convId: 'c', text: 'hi' }, 3_600_000);
    const marker = Symbol('pending');
    expect(await Promise.race([unbounded, new Promise((r) => setTimeout(() => r(marker), 1_000))])).toBe(marker);
  }, 15_000);

  test('finish() still settles after a delta hangs — the turn does not freeze mid-sentence', async () => {
    const s = new WebhookStreamer({ callback: hangCb, convId: 'c1', msgId: 'm1', postTimeout: 250, flushThreshold: 1 });
    s.feed({ type: 'text_delta', text: 'the first half' });
    const t0 = Date.now();
    // `finish()` awaits the serialized chain, so this only returns if the hung delta was bounded.
    expect(await s.finish()).toBe('the first half');
    expect(Date.now() - t0).toBeLessThan(5_000);

    // NEGATIVE CONTROL — an unbounded streamer's `finish()` never settles. This is the observed
    // symptom: the transcript says the turn completed, the row is stuck on the partial text.
    const stuck = new WebhookStreamer({ callback: hangCb, convId: 'c1', msgId: 'm1', postTimeout: 3_600_000, flushThreshold: 1 });
    stuck.feed({ type: 'text_delta', text: 'the first half' });
    const marker = Symbol('pending');
    expect(await Promise.race([stuck.finish(), new Promise((r) => setTimeout(() => r(marker), 1_000))])).toBe(marker);
  }, 20_000);
});

// ── Structured tool segments ────────────────────────────────────────────────
//
// The property under test is the one the FEATURE rests on: an external agent's turn arrives at
// the receiver as `{type,tool}` segments with real status transitions, and — crucially — arrives
// PROGRESSIVELY, not only at `final`. Asserted on the bodies a real receiver saw.
describe('tool segments', () => {
  const drain = () => new Promise((r) => setTimeout(r, 50));

  test('OFF by default: the flattened marker, no segments — a receiver that predates segments is unaffected', async () => {
    reset();
    const s = new WebhookStreamer({ callback: cb, convId: 'c1', msgId: 'm1', flushThreshold: 1 });
    s.feed({ type: 'tool_use', tool: 'Bash', toolUseId: 't1', input: { command: 'ls' } });
    s.feed({ type: 'tool_result', toolUseId: 't1', output: 'a\nb' });
    const text = await s.finish();
    expect(text).toContain('_🔧 Bash_');
    for (const r of received) expect(r.body.segments).toBeUndefined();
  });

  test('ON: a running tool is delivered as `running` BEFORE its result exists', async () => {
    reset();
    const s = new WebhookStreamer({ callback: cb, convId: 'c1', msgId: 'm1', sendSegments: true, flushThreshold: 1 });
    s.feed({ type: 'text_delta', text: 'Checking.' });
    s.feed({ type: 'tool_use', tool: 'Bash', toolUseId: 't1', input: { command: 'ls -la' } });
    await drain();
    // Streaming, not batched-at-the-end: this delta was on the wire while the tool was still going.
    const live = received[received.length - 1].body;
    expect(live.type).toBe('delta');
    const running = live.segments.find((x: any) => x.type === 'tool');
    expect(running.tool).toEqual({ id: 't1', tool: 'Bash', status: 'running', args: { command: 'ls -la' } });

    s.feed({ type: 'tool_result', toolUseId: 't1', output: 'total 0' });
    s.feed({ type: 'text_delta', text: 'Empty.' });
    await s.finish();
    const fin = received[received.length - 1].body;
    expect(fin.type).toBe('final');
    expect(fin.segments).toEqual([
      { type: 'text', content: 'Checking.' },
      { type: 'tool', tool: { id: 't1', tool: 'Bash', status: 'completed', args: { command: 'ls -la' }, result: 'total 0' } },
      { type: 'text', content: 'Empty.' },
    ]);
    // The text stays CLEAN — no markers — so a receiver's preview is the reply, not decoration.
    expect(fin.text).toBe('Checking.Empty.');
  });

  test('a failing tool reads as `error`, and results are matched by toolUseId not by order', async () => {
    reset();
    const s = new WebhookStreamer({ callback: cb, convId: 'c1', msgId: 'm1', sendSegments: true, flushThreshold: 1 });
    s.feed({ type: 'tool_use', tool: 'Read', toolUseId: 'a' });
    s.feed({ type: 'tool_use', tool: 'Bash', toolUseId: 'b' });
    // Results arrive out of order — the SECOND call settles first.
    s.feed({ type: 'tool_result', toolUseId: 'b', output: 'boom', isError: true });
    s.feed({ type: 'tool_result', toolUseId: 'a', output: 'file body' });
    await s.finish();
    const segs = received[received.length - 1].body.segments;
    expect(segs.map((x: any) => [x.tool.tool, x.tool.status, x.tool.result]))
      .toEqual([['Read', 'completed', 'file body'], ['Bash', 'error', 'boom']]);
  });

  test('a tool call with no text yet still flushes — the pill appears, and the stall watchdog is fed', async () => {
    reset();
    const s = new WebhookStreamer({ callback: cb, convId: 'c1', msgId: 'm1', sendSegments: true, flushThreshold: 1 });
    s.feed({ type: 'tool_use', tool: 'Bash', toolUseId: 't1' });
    await drain();
    // Pre-fix, `enqueueFlush` returned early on empty `fullText`: no delta at all, so the receiver's
    // `lastActivityAt` was never bumped for a tool-only stretch and the turn could be reaped.
    expect(received.length).toBe(1);
    expect(received[0].body.type).toBe('delta');
    await s.finish();
  });

  test('an in-flight delta is not mutated by a later result — the row cannot rewind', async () => {
    reset();
    const s = new WebhookStreamer({ callback: cb, convId: 'c1', msgId: 'm1', sendSegments: true, flushThreshold: 1 });
    s.feed({ type: 'tool_use', tool: 'Bash', toolUseId: 't1' });
    s.feed({ type: 'tool_result', toolUseId: 't1', output: 'done' });
    await s.finish();
    // The FIRST delta must still say `running`. Sharing the object with `toolById` would have let
    // the result mutate a payload already queued behind it.
    expect(received[0].body.segments[0].tool.status).toBe('running');
    expect(received[received.length - 1].body.segments[0].tool.status).toBe('completed');
  });

  test('args and results are clamped with an honest marker naming the true length', async () => {
    reset();
    const big = 'x'.repeat(50_000);
    const s = new WebhookStreamer({ callback: cb, convId: 'c1', msgId: 'm1', sendSegments: true, flushThreshold: 1 });
    s.feed({ type: 'tool_use', tool: 'Bash', toolUseId: 't1', input: { command: big } });
    s.feed({ type: 'tool_result', toolUseId: 't1', output: big });
    await s.finish();
    const t = received[received.length - 1].body.segments[0].tool;
    expect(t.args.command.length).toBeLessThanOrEqual(MAX_TOOL_ARGS_CHARS + 40);
    expect(t.args.command).toContain('truncated, 50000 chars total');
    expect(t.result.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS + 40);
    expect(t.result).toContain('truncated, 50000 chars total');
    expect(clampText('short', 100)).toBe('short');
    // A whole payload of small args is preserved verbatim — the cap is a budget, not a rewrite.
    expect(clampArgs({ a: 1, b: 'two' })).toEqual({ a: 1, b: 'two' });
  });

  test('a runaway turn stops growing the row at MAX_TOOL_SEGMENTS, and stray results are dropped', async () => {
    reset();
    const s = new WebhookStreamer({ callback: cb, convId: 'c1', msgId: 'm1', sendSegments: true, flushThreshold: 1 });
    for (let i = 0; i < MAX_TOOL_SEGMENTS + 25; i++) s.feed({ type: 'tool_use', tool: 'Bash', toolUseId: `t${i}` });
    // A result for a call past the cap has no segment to settle; it must not invent one.
    s.feed({ type: 'tool_result', toolUseId: `t${MAX_TOOL_SEGMENTS + 5}`, output: 'ignored' });
    await s.finish();
    expect(received[received.length - 1].body.segments.length).toBe(MAX_TOOL_SEGMENTS);
  }, 20_000);

  test('tool events are COALESCED — a 100-tool turn is a handful of POSTs, not ~200', async () => {
    reset();
    // Every flush re-sends the WHOLE accumulated snapshot and costs a whole-row `set` plus a live
    // re-render on the receiver, so an unthrottled POST per `tool_use` AND per `tool_result` is
    // quadratic in the tool count — ~200 POSTs and tens of MB for one capped turn.
    const s = new WebhookStreamer({ callback: cb, convId: 'c1', msgId: 'm1', sendSegments: true, flushThreshold: 1 });
    for (let i = 0; i < 100; i++) {
      s.feed({ type: 'tool_use', tool: 'Bash', toolUseId: `t${i}`, input: { command: 'ls' } });
      s.feed({ type: 'tool_result', toolUseId: `t${i}`, output: 'ok' });
    }
    await s.finish();
    expect(received.length).toBeLessThan(10);
    // Coalescing must cost only POSTs, never state: every call is still there, still settled.
    const segs = received[received.length - 1].body.segments;
    expect(segs.length).toBe(100);
    expect(segs.every((x: any) => x.tool.status === 'completed')).toBe(true);
  }, 20_000);

  test('a tool still running is STILL delivered as `running`, within one flushInterval', async () => {
    reset();
    const s = new WebhookStreamer({ callback: cb, convId: 'c1', msgId: 'm1', sendSegments: true, flushThreshold: 1, flushInterval: 20 });
    // The FIRST tool goes immediately and burns the budget, so the second takes the COALESCED path.
    s.feed({ type: 'tool_use', tool: 'Read', toolUseId: 't0' });
    s.feed({ type: 'tool_result', toolUseId: 't0', output: 'done' });
    const before = received.length;
    s.feed({ type: 'tool_use', tool: 'Bash', toolUseId: 't1' });
    await drain();
    // The timer is the guarantee: throttling delays the pill, it never strands it. Nothing has
    // settled this call, so the reader must be looking at `running` — the point of the feature.
    expect(received.length).toBeGreaterThan(before);
    const last = received[received.length - 1].body;
    expect(last.type).toBe('delta');
    expect(last.segments[last.segments.length - 1].tool).toMatchObject({ tool: 'Bash', status: 'running' });
    await s.finish();
  });
});
