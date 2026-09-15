// ONE resolution path: decide(), guard admitTurn rank, the enforce TurnGuard rank (engine surface), the Slack
// ingestion/taint rank and escalate's role all agree — step 4's no-human rules composed with step 6's API-key caps.
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initSecurity, admitTurn, __resetSecurityForTest } from '../runtime.ts';
import { fromAuthUser, fromInternal, fromSlack, fromEmailSender, SYSTEM_UID, type Principal } from '../principal.ts';
import type { TurnGuard } from '../enforce.ts';
import type { GuardInput } from '../guard.ts';
import { apiKeyPrincipal } from '../../api-keys.ts';
import { registerEngine } from '../../engine/index.ts';
import { streamChat, enforcedRank, taintSession } from '../../claude.ts';
import { getSessionFloor } from '../../sessions.ts';

const OWNER = 'owner@agree.test';
const OPS = 'ops@agree.test';
const GUEST = 'guest@agree.test';
const quiet = { info() {}, warn() {}, error() {} };
const prev = { OWNERS: process.env.OWNERS, SECURITY_ENFORCE: process.env.SECURITY_ENFORCE };
let root: string;

const guards: TurnGuard[] = [];
registerEngine({
  name: 'agree-probe', enforcesProfile: true,
  async *stream(o: any) { guards.push(o.security); yield { type: 'done', sessionId: o.sessionId }; },
  getModels: () => [],
} as any);

beforeAll(() => { root = mkdtempSync(path.join(tmpdir(), 'sec-agree-')); process.env.OWNERS = OWNER; });
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});
beforeEach(() => { __resetSecurityForTest(); guards.length = 0; });
afterEach(() => { __resetSecurityForTest(); delete process.env.SECURITY_ENFORCE; });

const cases: [name: string, principal: () => Principal, rank: number][] = [
  ['owner login', () => fromAuthUser({ uid: 'o', email: OWNER }), 100],
  ['owner uncapped api key', () => apiKeyPrincipal({ id: 'k-open', uid: OWNER, email: OWNER }), 100],
  ['owner guest-capped api key', () => apiKeyPrincipal({ id: 'k-guest', uid: OWNER, email: OWNER, role: 'guest' }), 20],
  ['internal-for-owner (wake)', () => fromInternal({ uid: 'o', email: OWNER, lane: 'wake' }), 100],
  ['system lane', () => fromInternal({ uid: SYSTEM_UID, email: 'system@shraga.local', lane: 'scheduler' }), 80],
  ['slack sender with operator binding', () => fromSlack('UOPS', { email: OPS }), 80],
  ['unbound slack sender', () => fromSlack('USTRANGER'), 0],
  ['email guest', () => fromEmailSender(GUEST, true), 20],
];

test('flag OFF: guard and turn deny nothing, and no rank-based filtering applies', async () => {
  const dir = mkdtempSync(path.join(root, 'off-'));
  initSecurity({ policy: { path: path.join(dir, 'p.json'), whitelistPath: path.join(dir, 'w.json'), watch: false }, audit: { dir: path.join(dir, 'a') }, guard: { blocksPath: path.join(dir, 'b.json') }, notify: () => {}, log: quiet });
  const anon = fromSlack('USTRANGER'); // profile `none`: rate "0", outbound false
  for (let i = 0; i < 3; i++) { const a = admitTurn(anon); expect(a.ok).toBe(true); if (a.ok) a.release(); }
  const evs: any[] = [];
  for await (const ev of streamChat({ principal: anon, prompt: '[engine:agree-probe] hi', sessionId: `ag-${crypto.randomUUID()}`, uid: 'u', userEmail: OWNER })) evs.push(ev);
  expect(evs.filter(e => e.type !== 'directives').map(e => e.type)).toEqual(['done']);
  expect(guards[0]).toBeUndefined();
  expect(enforcedRank(anon)).toBeUndefined();
});

describe('flag ON: every consumer resolves the same rank', () => {
  test.each(cases)('%s', async (_name, mk, rank) => {
    process.env.SECURITY_ENFORCE = '1'; // the non-"true" spelling: the guard and the engine must read the flag identically
    const dir = mkdtempSync(path.join(root, 'on-'));
    const rt = initSecurity({ policy: { path: path.join(dir, 'p.json'), whitelistPath: path.join(dir, 'w.json'), watch: false }, audit: { dir: path.join(dir, 'a') }, guard: { blocksPath: path.join(dir, 'b.json') }, notify: () => {}, log: quiet });
    const pol = rt.policy.current;
    pol.bindings = [
      { match: { kind: 'user', emailIn: [OPS] }, role: 'operator' },
      { match: { kind: 'email', emailIn: [GUEST], verified: true }, role: 'guest' },
    ];
    rt.policy.save(pol);
    expect(rt.guard.options.enforce()).toBe(true);

    const p = mk();
    const decided = rt.decide(p).rank;

    const admitted: number[] = [];
    const admit = rt.guard.admit.bind(rt.guard);
    rt.guard.admit = (i: GuardInput) => { admitted.push(i.rank); return admit(i); };
    const a = admitTurn(p, { channel: 'test' });
    if (a.ok) a.release();

    const sid = `ag-${crypto.randomUUID()}`;
    const evs: any[] = [];
    for await (const ev of streamChat({ principal: p, prompt: '[engine:agree-probe] hi', sessionId: sid, uid: 'u', userEmail: OWNER })) evs.push(ev);
    const start = rt.audit.query({ limit: 50, type: 'turn.start' }).items.find(r => r.sessionId === sid)!;

    expect(decided).toBe(rank);
    expect(admitted).toEqual([rank]);
    expect(getSessionFloor(sid)).toBe(rank); // the TurnGuard's per-call floor
    expect(start.meta).toMatchObject({ rank, floor: rank });
    if (rank > 0) {
      expect(guards).toHaveLength(1);
      expect(guards[0].current().rank).toBe(rank); // what the engine gates every tool call with (and escalate's role)
    } else {
      expect(guards).toHaveLength(0); // outbound:false — refused before the engine
      expect(evs.at(-1)).toMatchObject({ type: 'error' });
    }
    expect(enforcedRank(p)).toBe(rank); // Slack ingestion floor
    const fresh = `ag-${crypto.randomUUID()}`;
    expect(await taintSession(fresh, p)).toBe(rank); // taint from input outside a turn
  });
});
