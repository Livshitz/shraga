import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SecurityRuntime, initSecurity, __resetSecurityForTest } from '../runtime.ts';
import { defaultPolicy } from '../policy.ts';
import { fromAuthUser, fromInternal, fromSlack } from '../principal.ts';
import type { AuditRecord } from '../audit.ts';

delete process.env.DATA_SYNC_ENABLE;
delete process.env.DATA_SYNC_REPO;

const OWNER = 'owner@sec-runtime.test';
let root: string;
const prevOwners = process.env.OWNERS;

function tmpRuntime(extra: Record<string, unknown> = {}) {
  const dir = mkdtempSync(path.join(root, 'rt-'));
  return new SecurityRuntime({
    policy: { path: path.join(dir, 'security', 'policy.json'), whitelistPath: path.join(dir, 'whitelist.json'), watch: false },
    audit: { dir: path.join(dir, 'audit') },
    notify: () => {},
    ...extra,
  });
}
const all = (rt: SecurityRuntime): AuditRecord[] => rt.audit.query({ limit: 1000 }).items.reverse();

beforeAll(() => { root = mkdtempSync(path.join(tmpdir(), 'sec-runtime-')); process.env.OWNERS = OWNER; });
afterAll(() => { rmSync(root, { recursive: true, force: true }); if (prevOwners === undefined) delete process.env.OWNERS; else process.env.OWNERS = prevOwners; });
afterEach(() => __resetSecurityForTest());

describe('API-key principal role = creator role capped by the key role', () => {
  test('guest key from an owner → guest; operator key from a member → member; no role → creator', async () => {
    const { apiKeyPrincipal } = await import('../../api-keys.ts');
    const { resolvePrincipal } = await import('../runtime.ts');
    const rt = tmpRuntime();
    rt.policy.save({ ...rt.policy.current, bindings: [{ match: { kind: 'user', emailIn: ['mem@sec-runtime.test'] }, role: 'member' }] });
    const key = (email: string, role?: string) => apiKeyPrincipal({ id: `k-${email}-${role}`, uid: email, email, ...(role ? { role } : {}) });
    expect(rt.decide(key(OWNER, 'guest')).role).toBe('guest');
    expect(resolvePrincipal(rt.policy, key('mem@sec-runtime.test', 'operator')).role).toBe('member');
    expect(resolvePrincipal(rt.policy, key('mem@sec-runtime.test', 'guest')).role).toBe('guest');
    expect(resolvePrincipal(rt.policy, key('mem@sec-runtime.test')).role).toBe('member');
    expect(resolvePrincipal(rt.policy, key(OWNER)).role).toBe('owner');
  });
});

describe('SecurityRuntime.decide', () => {
  test('owner resolves to owner/full (no wouldDeny); an internal principal falls to the default role (wouldDeny)', () => {
    const rt = tmpRuntime();
    expect(rt.decide(fromAuthUser({ uid: 'o', email: OWNER }))).toEqual({ role: 'owner', rank: 100, profile: 'full', wouldDeny: false });
    expect(rt.decide(fromInternal({ uid: 'o', email: OWNER, lane: 'wake' }))).toEqual({ role: 'anonymous', rank: 0, profile: 'none', wouldDeny: true });
  });

  test('role.resolve is deduped per principal+role per window, and re-audited after it', () => {
    let now = 1_000_000;
    const rt = tmpRuntime({ clock: () => now });
    const p = fromSlack('U1', { email: 'x@y.test' });
    rt.decide(p); rt.decide(p); rt.decide(p);
    expect(all(rt).filter(r => r.type === 'role.resolve')).toHaveLength(1);
    now += 60_001;
    rt.decide(p);
    const lines = all(rt).filter(r => r.type === 'role.resolve');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ principal: 'slack:U1', role: 'anonymous', meta: { kind: 'slack', profile: 'none' } });
  });

  test('inactive (PASSIVE standby) writes nothing', () => {
    const rt = tmpRuntime({ isActive: () => false });
    rt.decide(fromAuthUser({ uid: 'o', email: OWNER }));
    rt.authDeny('http', 'missing-token', '1.2.3.4');
    expect(all(rt)).toHaveLength(0);
  });

  test('PASSIVE: policy writes nothing (no migration/marker), save refuses; activate() migrates and resolves', () => {
    let active = false;
    const notices: string[] = [];
    const rt = tmpRuntime({ isActive: () => active, notify: (t: string) => notices.push(t), log: { info() {}, warn() {}, error() {} } });
    const secDir = path.dirname(rt.policy.options.path);
    expect(existsSync(secDir)).toBe(false);
    expect(rt.policy.valid).toBe(false);
    expect(rt.decide(fromAuthUser({ uid: 'o', email: OWNER })).role).toBe('owner');
    expect(() => rt.policy.save(defaultPolicy())).toThrow(/PASSIVE/);
    expect(existsSync(secDir)).toBe(false);
    active = true; rt.activate();
    expect(existsSync(rt.policy.options.path)).toBe(true);
    expect(existsSync(path.join(secDir, '.migrated'))).toBe(true);
    expect(rt.policy.valid).toBe(true);
    expect(notices).toHaveLength(0);
  });

  test('policy tamper → policy.tamper audit + owner notice', () => {
    const notices: string[] = [];
    const rt = tmpRuntime({ notify: (t: string) => notices.push(t) });
    writeFileSync(rt.policy.options.path, '{"roles":{}}');
    expect(rt.policy.reload()).toBe(false);
    const tamper = all(rt).filter(r => r.type === 'policy.tamper');
    expect(tamper).toHaveLength(1);
    expect(tamper[0].reason).toBe('hash-mismatch');
    expect(notices).toHaveLength(1);
    expect(rt.audit.verify().ok).toBe(true);
  });
});

describe('streamChat shadow audit (real consumer surface)', () => {
  const { registerEngine } = require('../../engine/index.ts') as typeof import('../../engine/index.ts');
  let engineRuns = 0;
  registerEngine({
    name: 'sec-probe-engine',
    async *stream() { engineRuns++; yield { type: 'text_delta', text: 'hi' }; yield { type: 'done', sessionId: 's' }; },
    getModels: () => [],
  } as unknown as Parameters<typeof registerEngine>[0]);

  async function turn(principal: ReturnType<typeof fromAuthUser>, sessionId: string) {
    const { streamChat } = await import('../../claude.ts');
    const events: unknown[] = [];
    for await (const ev of streamChat({ principal, prompt: '[engine:sec-probe-engine] hello', sessionId, uid: 'u', userEmail: OWNER })) events.push(ev);
    return events;
  }

  test('turn.start/turn.end carry the resolved role; the turn itself is unchanged', async () => {
    const baseline = await turn(fromInternal({ uid: 'u' }), `sec-a-${Date.now()}`); // no runtime initialized
    const dir = mkdtempSync(path.join(root, 'sc-'));
    const rt = initSecurity({
      policy: { path: path.join(dir, 'security', 'policy.json'), whitelistPath: path.join(dir, 'w.json'), watch: false },
      audit: { dir: path.join(dir, 'audit') }, notify: () => {},
    });
    const runsBefore = engineRuns;
    const sidOwner = `sec-owner-${Date.now()}`, sidSched = `sec-sched-${Date.now()}`;
    const ownerEvents = await turn(fromAuthUser({ uid: 'u', email: OWNER }), sidOwner);
    const schedEvents = await turn(fromInternal({ uid: 'u', email: OWNER, lane: 'scheduler' }), sidSched);

    const strip = (evs: unknown[]) => JSON.stringify(evs.filter((e: any) => e.type !== 'directives'));
    expect(strip(ownerEvents)).toBe(strip(baseline));
    expect(strip(schedEvents)).toBe(strip(baseline));
    expect(engineRuns - runsBefore).toBe(2); // both ran — shadow mode denies nothing

    const recs = all(rt);
    const start = (sid: string) => recs.find(r => r.type === 'turn.start' && r.sessionId === sid)!;
    const end = (sid: string) => recs.find(r => r.type === 'turn.end' && r.sessionId === sid)!;
    expect(start(sidOwner)).toMatchObject({ principal: `user:${OWNER}`, role: 'owner', meta: { profile: 'full', wouldDeny: false } });
    expect(end(sidOwner)).toMatchObject({ role: 'owner', reason: 'done' });
    expect(start(sidSched)).toMatchObject({ principal: 'internal:u', role: 'anonymous', meta: { lane: 'scheduler', profile: 'none', wouldDeny: true } });
    expect(end(sidSched)).toMatchObject({ role: 'anonymous', reason: 'done' });
    expect(rt.audit.verify().ok).toBe(true);
  });
});
