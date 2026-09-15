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

describe('planted audit month entry → owner alert via notify', () => {
  test('active runtime notifies once; a standby does not, and alerts after promotion', async () => {
    const { mkdirSync, symlinkSync } = await import('node:fs');
    const { __resetAuditHeadsForTest } = await import('../audit.ts');
    const quiet = { info() {}, warn() {}, error() {} };
    for (const standby of [false, true]) {
      __resetAuditHeadsForTest();
      const dir = mkdtempSync(path.join(root, 'plant-'));
      const auditDir = path.join(dir, 'audit');
      mkdirSync(auditDir);
      const month = `${new Date().toISOString().slice(0, 7)}.jsonl`;
      if (standby) mkdirSync(path.join(auditDir, month)); else symlinkSync(path.join(dir, 'outside'), path.join(auditDir, month));
      const notes: string[] = [];
      let active = !standby;
      const rt = new SecurityRuntime({
        policy: { path: path.join(dir, 'security', 'policy.json'), whitelistPath: path.join(dir, 'w.json'), watch: false },
        audit: { dir: auditDir }, notify: (t) => notes.push(t), isActive: () => active, log: quiet,
      });
      expect(rt.audit.append({ type: 'turn.start' })).toBeNull();
      if (standby) { expect(notes).toEqual([]); active = true; rt.audit.verify(); }
      rt.audit.append({ type: 'turn.end' }); rt.audit.verify();
      expect([standby, notes.length]).toEqual([standby, 1]);
      expect(notes[0]).toContain(month);
      expect(notes[0]).toContain(standby ? 'directory' : 'symlink');
      expect(rt.audit.verify()).toMatchObject({ ok: false, brokenAt: { file: month, reason: 'not-regular-file' } });
    }
  });
});

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
    expect(resolvePrincipal(rt.policy, key(OWNER)).role).toBe('owner'); // uncapped = delegated login: creator's role, owner included
    expect(resolvePrincipal(rt.policy, key(OWNER, 'operator')).role).toBe('operator'); // capped: never owner
    expect(resolvePrincipal(rt.policy, key(OWNER, 'ghost')).role).toBe(rt.policy.current.default);
    process.env.OWNERS = 'someone-else@sec-runtime.test'; // creator removed from OWNERS → the same key is not owner on the next resolve
    try { expect(resolvePrincipal(rt.policy, key(OWNER)).role).not.toBe('owner'); } finally { process.env.OWNERS = OWNER; }
  });

  test('guard rank uses the same capped resolution: an owner\'s guest-capped key is NOT exempt from IP limits', async () => {
    const { apiKeyPrincipal } = await import('../../api-keys.ts');
    const dir = mkdtempSync(path.join(root, 'guard-'));
    const rt = tmpRuntime({ guard: { blocksPath: path.join(dir, 'blocks.json'), enforce: () => true, limits: { ip: '1/h', blockAfter: 100 } } });
    const IP = '203.0.113.9';
    const guestKey = apiKeyPrincipal({ id: 'k-guest', uid: OWNER, email: OWNER, role: 'guest' });
    expect(rt.admitTurn(guestKey, { ip: IP })).toMatchObject({ ok: true }); // guest profile rate 10/h admits
    expect(rt.admitTurn(guestKey, { ip: IP })).toMatchObject({ ok: false, status: 429, reason: 'rate' }); // IP bucket (1/h) applies: not exempt
    const plainKey = apiKeyPrincipal({ id: 'k-plain', uid: OWNER, email: OWNER }); // uncapped → owner (rank 100) → IP-exempt
    for (let i = 0; i < 3; i++) expect(rt.admitTurn(plainKey, { ip: IP })).toMatchObject({ ok: true });
    rt.close();
  });
});

describe('SecurityRuntime.decide', () => {
  test('owner resolves to owner/full (no wouldDeny); an internal run for the owner re-resolves as the owner; a no-email internal falls to default', () => {
    const rt = tmpRuntime();
    expect(rt.decide(fromAuthUser({ uid: 'o', email: OWNER }))).toEqual({ role: 'owner', rank: 100, profile: 'full', wouldDeny: false });
    expect(rt.decide(fromInternal({ uid: 'o', email: OWNER, lane: 'wake' }))).toEqual({ role: 'owner', rank: 100, profile: 'full', wouldDeny: false });
    expect(rt.decide(fromInternal({ uid: 'slack-bot', lane: 'slack' }))).toEqual({ role: 'anonymous', rank: 0, profile: 'none', wouldDeny: true });
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
    expect(start(sidSched)).toMatchObject({ principal: 'internal:u', role: 'owner', meta: { lane: 'scheduler', profile: 'full', wouldDeny: false } });
    expect(start(sidSched).meta).not.toHaveProperty('enforced'); // shadow: nothing enforcement-specific
    expect(end(sidSched)).toMatchObject({ role: 'owner', reason: 'done' });
    expect(rt.audit.verify().ok).toBe(true);
  });
});

describe('consumer migrate seam (ShragaOptions.security.migrate → initSecurity → Policy)', () => {
  const quiet = { info() {}, warn() {}, error() {} };
  const boot = (dir: string, migrate: (d: any) => any, isActive = () => true) => initSecurity({
    isActive, notify: () => {},
    policy: { path: path.join(dir, 'security', 'policy.json'), whitelistPath: path.join(dir, 'whitelist.json'), watch: false, log: quiet, migrate },
    audit: { dir: path.join(dir, 'audit'), log: quiet }, log: quiet,
  });
  const slackOp = { match: { kind: 'slack' as const, id: 'slack:UOPS' }, role: 'operator' };

  test('first boot: the hook sees the whitelist-migrated draft and its binding is saved + resolves', () => {
    const dir = mkdtempSync(path.join(root, 'seam-'));
    writeFileSync(path.join(dir, 'whitelist.json'), JSON.stringify(['wl@x.com']));
    let seen: any;
    const rt = boot(dir, (d) => { seen = structuredClone(d); d.bindings.push(slackOp); return d; });
    expect(seen.bindings).toEqual([{ match: { kind: 'user', emailIn: ['wl@x.com'] }, role: 'operator' }]);
    expect(rt.policy.valid).toBe(true);
    expect(rt.policy.resolve(fromSlack('UOPS')).role).toBe('operator');
    const disk = JSON.parse(require('node:fs').readFileSync(path.join(dir, 'security', 'policy.json'), 'utf8'));
    expect(disk.bindings).toContainEqual(slackOp);
    expect(existsSync(path.join(dir, 'security', '.migrated'))).toBe(true);
  });

  test('marker present ⇒ the hook never runs again (policy.json kept, or deleted ⇒ fail closed)', () => {
    const dir = mkdtempSync(path.join(root, 'seam-'));
    boot(dir, (d) => { d.bindings.push(slackOp); return d; });
    let calls = 0;
    const again = (d: any) => { calls++; d.bindings.push({ match: { kind: 'slack', id: 'slack:ULATE' }, role: 'operator' }); return d; };
    const rt2 = boot(dir, again);
    expect(rt2.policy.resolve(fromSlack('ULATE')).role).toBe('anonymous');
    require('node:fs').unlinkSync(path.join(dir, 'security', 'policy.json'));
    const rt3 = boot(dir, again);
    expect(calls).toBe(0);
    expect(rt3.policy.valid).toBe(false);
  });

  test('invalid draft from the hook ⇒ no throw, owners only, no marker', () => {
    const dir = mkdtempSync(path.join(root, 'seam-'));
    let rt!: SecurityRuntime;
    expect(() => { rt = boot(dir, (d) => { d.bindings.push({ match: {}, role: 'operator' }); return d; }); }).not.toThrow();
    expect(rt.policy.valid).toBe(false);
    expect(rt.policy.resolve(fromAuthUser({ uid: 'o', email: OWNER })).role).toBe('owner');
    expect(rt.policy.resolve(fromSlack('UOPS')).role).toBe('anonymous');
    expect(existsSync(path.join(dir, 'security', 'policy.json'))).toBe(false);
    expect(existsSync(path.join(dir, 'security', '.migrated'))).toBe(false);
  });

  test('PASSIVE ⇒ hook ignored; runs on promotion', () => {
    const dir = mkdtempSync(path.join(root, 'seam-'));
    let active = false, calls = 0;
    const rt = boot(dir, (d) => { calls++; d.bindings.push(slackOp); return d; }, () => active);
    expect(calls).toBe(0);
    expect(existsSync(path.join(dir, 'security'))).toBe(false);
    active = true; rt.activate();
    expect(calls).toBe(1);
    expect(rt.policy.resolve(fromSlack('UOPS')).role).toBe('operator');
  });
});
