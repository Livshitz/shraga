/**
 * ParaStreamer wire contract. Not "does it call fetch" — the three properties para-li's receiver
 * actually depends on, each asserted against a real HTTP receiver rather than a mock:
 *   1. the signature it produces is the one para-li verifies (`connId.ts.rawBody`),
 *   2. every delivery carries a UNIQUE id, or para-li's replay guard eats every delta after the first,
 *   3. it ACCUMULATES and serializes, so the row never rewinds mid-stream.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createHmac } from 'node:crypto';
import { ParaStreamer, postProactive, postPara, signPara, type ParaCallback } from '../para/streamer.ts';

type Received = { body: any; headers: Record<string, string> };
let received: Received[] = [];
let server: ReturnType<typeof Bun.serve>;
let cb: ParaCallback;
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
  test('is exactly what para-li verifies: HMAC-SHA256 over `connId.deliveryId.ts.rawBody`', async () => {
    reset();
    await postPara(cb, { type: 'post', convId: 'c1', text: 'hi' });
    const r = received[0] as any;
    const ts = Number(r.headers['x-agent-timestamp']);
    const delivery = r.headers['x-agent-delivery'];
    // Recomputed here from the contract, NOT by calling signPara — otherwise this would only prove
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
    expect(signPara(cb.secret, cb.connId, r.headers['x-agent-delivery'], ts, r.raw))
      .toBe(r.headers['x-agent-signature']);
  });

  test('signPara matches that same contract', () => {
    expect(signPara('s', 'cid', 'dlv', 5, 'body')).toBe(
      'v1=' + createHmac('sha256', 's').update('cid.dlv.5.body').digest('hex'),
    );
  });

  test('a different connection id produces a different signature (cross-binding)', () => {
    expect(signPara('s', 'a', 'd', 5, 'b')).not.toBe(signPara('s', 'z', 'd', 5, 'b'));
  });

  test('a different DELIVERY id produces a different signature (replay bind)', () => {
    expect(signPara('s', 'a', 'd1', 5, 'b')).not.toBe(signPara('s', 'a', 'd2', 5, 'b'));
  });
});

describe('deliveries', () => {
  test('each carries a UNIQUE x-agent-delivery — a shared id would be replay-dropped', async () => {
    reset();
    const s = new ParaStreamer({ callback: cb, convId: 'c1', msgId: 'm1', flushInterval: 5, flushThreshold: 1 });
    for (const t of ['a', 'b', 'c']) s.feed({ type: 'text_delta', text: t });
    await s.finish();
    const ids = received.map(r => r.headers['x-agent-delivery']);
    expect(ids.length).toBeGreaterThan(1);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('text ACCUMULATES and never rewinds — each payload extends the previous', async () => {
    reset();
    const s = new ParaStreamer({ callback: cb, convId: 'c1', msgId: 'm1', flushInterval: 5, flushThreshold: 1 });
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
    const s = new ParaStreamer({ callback: cb, convId: 'c1', msgId: 'm1' });
    expect(await s.finish()).toBe('(no output)');
    expect(received[0].body).toMatchObject({ type: 'final', convId: 'c1', msgId: 'm1' });
  });

  test('fail() settles the row visibly instead of leaving a permanent "typing…"', async () => {
    reset();
    const s = new ParaStreamer({ callback: cb, convId: 'c1', msgId: 'm1' });
    s.feed({ type: 'text_delta', text: 'partial' });
    await s.fail('the engine died');
    expect(received[received.length - 1].body).toMatchObject({ type: 'error', message: 'the engine died' });
  });

  test('a tool call becomes an in-band marker, not a separate structured event', async () => {
    reset();
    const s = new ParaStreamer({ callback: cb, convId: 'c1', msgId: 'm1', flushInterval: 5, flushThreshold: 1 });
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
    expect(await postProactive(cb, 'c1', 'nope')).toBe(false);
  });

  test('an unreachable endpoint returns false rather than throwing', async () => {
    reset();
    const dead: ParaCallback = { ...cb, url: 'http://127.0.0.1:1/hook' };
    expect(await postPara(dead, { type: 'post', convId: 'c1', text: 'x' })).toBe(false);
  });

  test('a proactive post carries no msgId — para-li mints the row', async () => {
    reset();
    await postProactive(cb, 'c1', 'deploy done');
    expect(received[0].body).toEqual({ type: 'post', convId: 'c1', text: 'deploy done' });
  });
});

// ── CROSS-REPO CONTRACT VECTOR ───────────────────────────────────────────────────────────────────
//
// This block is DUPLICATED VERBATIM in the other half of the lane. Keep the two byte-identical:
//   para-li  lib/agent-conn.test.ts          (verifier side — `signPayload`)
//   shraga   src/server/__tests__/para-streamer.test.ts   (sender side — `signPara`)
//
// WHY A KNOWN-ANSWER VECTOR AND NOT A CROSS-REPO TEST. Only a checkout that has BOTH repos side by
// side can import across the seam (that is what `.tmp/probe-agent-stream.ts` does, and it is
// gitignored — it cannot run in either repo's CI). Each suite otherwise recomputes the contract
// inside its own repo, so an edit to the material on ONE side leaves both suites green and every
// delta 401s in production. A frozen expected digest is checkout-independent and fails LOUDLY on
// exactly that edit: whichever side is changed, its own suite goes red on the next run.
//
// The vector deliberately exercises what a re-serialization would break: a non-ASCII char, an
// escaped quote, and a solidus.
//
// If you are here because this test failed: the signature material changed. Do not update the
// digest to make it pass — change the OTHER repo to match, then update the digest in both.
const CONTRACT = {
  material: '{connId}.{deliveryId}.{ts}.{rawBody}',
  secret: 'para-li↔shraga contract vector',
  connId: '0123456789abcdef01234567',
  deliveryId: '11111111-2222-3333-4444-555555555555',
  ts: 1700000000000,
  rawBody: '{"type":"final","convId":"conv_agent_uidX_abc","msgId":"msg_1","text":"héllo \\"quoted\\" / slash"}',
  signature: 'v1=34f91d8282a7e39829ec703011e60c4c26ae02ea3009aa88662ea0cf6fe1d6de',
  /** Transport seam, pinned for the same reason: a rename here is a silent 404, not a 401. */
  deliveryHeader: 'x-agent-delivery',
  connHeader: 'x-agent-conn',
  tsHeader: 'x-agent-timestamp',
  sigHeader: 'x-agent-signature',
  turnPath: '/api/para/turn',
  /** No `?conn=`: the connection id travels in the header only. */
  webhookPath: '/functions/agents/stream',
};

describe('cross-repo signature contract', () => {
  test('signPara reproduces the frozen vector exactly', () => {
    expect(signPara(CONTRACT.secret, CONTRACT.connId, CONTRACT.deliveryId, CONTRACT.ts, CONTRACT.rawBody))
      .toBe(CONTRACT.signature);
  });

  test('the headers this sender actually puts on the wire match the vector', async () => {
    const seen: Record<string, string> = {};
    const srv = Bun.serve({
      port: 0,
      async fetch(req) { req.headers.forEach((v, k) => { seen[k.toLowerCase()] = v; }); return new Response('{}'); },
    });
    const url = `http://127.0.0.1:${srv.port}${CONTRACT.webhookPath}`;
    await postPara({ url, secret: CONTRACT.secret, connId: CONTRACT.connId }, { type: 'post', convId: 'c', text: 'x' });
    srv.stop(true);
    expect(new URL(url).pathname).toBe(CONTRACT.webhookPath);
    expect(new URL(url).search).toBe('');            // no `?conn=`
    for (const h of [CONTRACT.connHeader, CONTRACT.tsHeader, CONTRACT.sigHeader, CONTRACT.deliveryHeader]) {
      expect(seen[h]).toBeTruthy();
    }
    expect(seen[CONTRACT.connHeader]).toBe(CONTRACT.connId);
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
  let hangCb: ParaCallback;

  beforeAll(() => {
    hangServer = Bun.serve({
      port: 0,
      async fetch() { await held; return new Response('late', { status: 200 }); },
    });
    hangCb = { url: `http://127.0.0.1:${hangServer.port}/hook`, secret: 's', connId: 'cd'.repeat(12) };
  });
  afterAll(() => { releaseHang(); hangServer.stop(true); });

  test('postPara gives up on the clock instead of waiting forever', async () => {
    const t0 = Date.now();
    expect(await postPara(hangCb, { type: 'post', convId: 'c', text: 'hi' }, 250)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(3_000);

    // NEGATIVE CONTROL — the pre-fix behaviour. With an effectively unbounded timeout the same
    // call has still not resolved after 1s; `false` here would mean the receiver isn't hanging and
    // the test above proves nothing.
    const unbounded = postPara(hangCb, { type: 'post', convId: 'c', text: 'hi' }, 3_600_000);
    const marker = Symbol('pending');
    expect(await Promise.race([unbounded, new Promise((r) => setTimeout(() => r(marker), 1_000))])).toBe(marker);
  }, 15_000);

  test('finish() still settles after a delta hangs — the turn does not freeze mid-sentence', async () => {
    const s = new ParaStreamer({ callback: hangCb, convId: 'c1', msgId: 'm1', postTimeout: 250, flushThreshold: 1 });
    s.feed({ type: 'text_delta', text: 'the first half' });
    const t0 = Date.now();
    // `finish()` awaits the serialized chain, so this only returns if the hung delta was bounded.
    expect(await s.finish()).toBe('the first half');
    expect(Date.now() - t0).toBeLessThan(5_000);

    // NEGATIVE CONTROL — an unbounded streamer's `finish()` never settles. This is the observed
    // symptom: the transcript says the turn completed, the row is stuck on the partial text.
    const stuck = new ParaStreamer({ callback: hangCb, convId: 'c1', msgId: 'm1', postTimeout: 3_600_000, flushThreshold: 1 });
    stuck.feed({ type: 'text_delta', text: 'the first half' });
    const marker = Symbol('pending');
    expect(await Promise.race([stuck.finish(), new Promise((r) => setTimeout(() => r(marker), 1_000))])).toBe(marker);
  }, 20_000);
});
