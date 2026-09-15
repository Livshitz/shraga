// streamChat under SECURITY_ENFORCE — the surface every channel calls. Probe engines stand in for the SDK.
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initSecurity, __resetSecurityForTest } from '../runtime.ts';
import { fromAuthUser, fromSlack, fromInternal, type Principal } from '../principal.ts';
import type { TurnGuard } from '../enforce.ts';
import { registerEngine } from '../../engine/index.ts';
import { streamChat, taintSession } from '../../claude.ts';
import { getSession, getSessionFloor, upsertSession } from '../../sessions.ts';

const OWNER = 'owner@stream-enforce.test';
const quiet = { info() {}, warn() {}, error() {} };
let root: string;
const prev = { OWNERS: process.env.OWNERS, SECURITY_ENFORCE: process.env.SECURITY_ENFORCE };

const seen: { engine: string; guard?: TurnGuard }[] = [];
const probe = (name: string, enforcesProfile: boolean) => ({
  name, enforcesProfile,
  async *stream(o: any) { seen.push({ engine: name, guard: o.security }); yield { type: 'text_delta', text: 'hi' }; yield { type: 'done', sessionId: o.sessionId }; },
  getModels: () => [],
});
registerEngine(probe('enf-probe-open', false) as any);
registerEngine(probe('enf-probe-enforcing', true) as any);

beforeAll(() => { root = mkdtempSync(path.join(tmpdir(), 'stream-enf-')); process.env.OWNERS = OWNER; });
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});
// Reset BEFORE each test too: an earlier test file in the same process may have left a process-wide runtime behind.
beforeEach(() => { __resetSecurityForTest(); seen.length = 0; delete process.env.SECURITY_ENFORCE; });
afterEach(() => { __resetSecurityForTest(); seen.length = 0; delete process.env.SECURITY_ENFORCE; });

function init() {
  const dir = mkdtempSync(path.join(root, 'rt-'));
  const rt = initSecurity({ policy: { path: path.join(dir, 'security', 'policy.json'), whitelistPath: path.join(dir, 'w.json'), watch: false }, audit: { dir: path.join(dir, 'audit') }, notify: () => {}, log: quiet });
  const p = rt.policy.current;
  p.bindings = [{ match: { kind: 'slack', id: 'slack:UGUEST' }, role: 'guest' }];
  rt.policy.save(p);
  return rt;
}
async function turn(principal: Principal, sessionId: string, engine: string) {
  const events: any[] = [];
  for await (const ev of streamChat({ principal, prompt: `[engine:${engine}] hello`, sessionId, uid: 'u', userEmail: OWNER })) events.push(ev);
  return events.filter(e => e.type !== 'directives');
}

describe('streamChat with SECURITY_ENFORCE', () => {
  test('flag on without a runtime fails closed', async () => {
    process.env.SECURITY_ENFORCE = 'true';
    const evs = await turn(fromAuthUser({ uid: 'o', email: OWNER }), `se-${crypto.randomUUID()}`, 'enf-probe-enforcing');
    expect(evs).toEqual([{ type: 'error', message: expect.stringContaining('not initialized') }]);
    expect(seen).toHaveLength(0);
  });

  test('owner runs with a guard; the session floor is recorded; turn.start says enforced', async () => {
    const rt = init();
    process.env.SECURITY_ENFORCE = 'true';
    const sid = `se-${crypto.randomUUID()}`;
    upsertSession(sid, 'hi', { uid: 'u', email: OWNER });
    const evs = await turn(fromAuthUser({ uid: 'o', email: OWNER }), sid, 'enf-probe-enforcing');
    expect(evs.map(e => e.type)).toEqual(['text_delta', 'done']);
    expect(seen[0].guard?.current().role).toBe('owner');
    expect(getSession(sid)?.floorRank).toBe(100);
    const start = rt.audit.query({ limit: 20, type: 'turn.start' }).items.find(r => r.sessionId === sid)!;
    expect(start.meta).toMatchObject({ enforced: true, effectiveRole: 'owner', effectiveProfile: 'full', floor: 100 });
  });

  test('a guest in the session taints it: the owner\'s next turn runs as guest, and a non-enforcing engine refuses it', async () => {
    init();
    process.env.SECURITY_ENFORCE = 'true';
    const sid = `se-${crypto.randomUUID()}`;
    await turn(fromSlack('UGUEST'), sid, 'enf-probe-enforcing');
    expect(getSessionFloor(sid)).toBe(20);
    await turn(fromAuthUser({ uid: 'o', email: OWNER }), sid, 'enf-probe-enforcing');
    expect(seen.at(-1)!.guard?.current()).toMatchObject({ role: 'guest', profileName: 'reply-only' });
    expect(getSessionFloor(sid)).toBe(20); // never rises

    const refused = await turn(fromAuthUser({ uid: 'o', email: OWNER }), sid, 'enf-probe-open');
    expect(refused).toEqual([{ type: 'error', message: expect.stringContaining('does not enforce security profiles') }]);
    expect(seen.filter(s => s.engine === 'enf-probe-open')).toHaveLength(0);
  });

  test('an unrestricted (full) turn may run on a non-enforcing engine', async () => {
    init();
    process.env.SECURITY_ENFORCE = 'true';
    const evs = await turn(fromInternal({ uid: 'o', email: OWNER, lane: 'wake' }), `se-${crypto.randomUUID()}`, 'enf-probe-open');
    expect(evs.map(e => e.type)).toEqual(['text_delta', 'done']);
  });

  test('an anonymous (outbound:false) principal is refused before the engine; turn.end records denied', async () => {
    const rt = init();
    process.env.SECURITY_ENFORCE = 'true';
    const sid = `se-${crypto.randomUUID()}`;
    const evs = await turn(fromSlack('USTRANGER'), sid, 'enf-probe-enforcing');
    expect(evs).toEqual([{ type: 'error', message: expect.stringContaining('anonymous') }]);
    expect(seen).toHaveLength(0);
    expect(rt.audit.query({ limit: 20, type: 'turn.end' }).items.find(r => r.sessionId === sid)).toMatchObject({ reason: 'denied', role: 'anonymous' });
  });

  test('flag off: no guard reaches the engine, no floor is recorded, anonymous still runs (shadow)', async () => {
    init();
    const sid = `se-${crypto.randomUUID()}`;
    const evs = await turn(fromSlack('USTRANGER'), sid, 'enf-probe-open');
    expect(evs.map(e => e.type)).toEqual(['text_delta', 'done']);
    expect(seen[0].guard).toBeUndefined();
    expect(getSessionFloor(sid)).toBeUndefined();
    expect(await taintSession(sid, fromSlack('USTRANGER'))).toBeUndefined();
    expect(getSessionFloor(sid)).toBeUndefined();
  });

  test('taintSession (flag on) lowers the floor from a lazily-resolved principal', async () => {
    init();
    process.env.SECURITY_ENFORCE = 'true';
    const sid = `se-${crypto.randomUUID()}`;
    await turn(fromAuthUser({ uid: 'o', email: OWNER }), sid, 'enf-probe-enforcing');
    expect(await taintSession(sid, async () => fromSlack('UGUEST'))).toBe(20);
    expect(getSessionFloor(sid)).toBe(20);
  });

  test('taintSession with several authors takes the LOWEST rank; an unresolved author (null) is rank 0; none is a no-op', async () => {
    init();
    process.env.SECURITY_ENFORCE = 'true';
    const owner = fromAuthUser({ uid: 'o', email: OWNER });
    const sid = `se-${crypto.randomUUID()}`;
    await turn(owner, sid, 'enf-probe-enforcing');
    expect(await taintSession(sid, [])).toBeUndefined();
    expect(await taintSession(sid, async () => [owner, fromSlack('UGUEST'), owner])).toBe(20);
    const sid2 = `se-${crypto.randomUUID()}`;
    await turn(owner, sid2, 'enf-probe-enforcing');
    expect(await taintSession(sid2, async () => [owner, null])).toBe(0);
    expect(await turn(owner, sid2, 'enf-probe-enforcing')).toEqual([{ type: 'error', message: expect.stringContaining('anonymous') }]);
  });
});
