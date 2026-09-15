// No-human principals: what an internal/system/slack caller resolves to (policy.ts resolve rules 1-3).
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Policy, defaultPolicy } from '../policy.ts';
import { fromInternal, fromSlack, fromApiKey, fromEmailSender, isSystemPrincipal, SYSTEM_UID } from '../principal.ts';
import { SYSTEM_UID as BUILTINS_SYSTEM_UID } from '../../scheduler/builtins.ts';

const quiet = { info() {}, warn() {}, error() {} };
const OWNER = 'boss@owner.test';
let dir: string;
let prevOwners: string | undefined;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'resolve-nh-')); prevOwners = process.env.OWNERS; process.env.OWNERS = OWNER; });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); if (prevOwners === undefined) delete process.env.OWNERS; else process.env.OWNERS = prevOwners; });

function policy() {
  const pol = new Policy({ path: path.join(dir, 'security', 'policy.json'), whitelistPath: path.join(dir, 'w.json'), watch: false, log: quiet });
  const p = defaultPolicy();
  p.bindings = [
    { match: { kind: 'user', emailIn: ['op@team.test'] }, role: 'operator' },
    { match: { kind: 'user', domain: 'team.test' }, role: 'member' },
    { match: { kind: 'slack', id: 'slack:UGUEST' }, role: 'guest' },
  ];
  pol.save(p);
  return pol;
}

describe('internal principal acting for a user re-resolves as that user would log in now', () => {
  test.each(['wake', 'web-retry', 'scheduler', 'slack-retry', 'ws-unresolved'])('%s lane: owner email → owner; bound email → its role; unknown → default', (lane) => {
    const pol = policy();
    expect(pol.resolve(fromInternal({ uid: 'u1', email: OWNER, lane })).role).toBe('owner');
    expect(pol.resolve(fromInternal({ uid: 'u2', email: 'op@team.test', lane })).role).toBe('operator');
    expect(pol.resolve(fromInternal({ uid: 'u3', email: 'dev@team.test', lane })).role).toBe('member');
    expect(pol.resolve(fromInternal({ uid: 'u4', email: 'stranger@else.test', lane })).role).toBe('anonymous');
    expect(pol.resolve(fromInternal({ uid: 'slack-bot', lane })).role).toBe('anonymous');
  });

  test('a downgraded creator runs with the CURRENT role (resolution is live, nothing is baked in)', () => {
    const pol = policy();
    const sched = fromInternal({ uid: 'u2', email: 'op@team.test', lane: 'scheduler' });
    expect(pol.resolve(sched).role).toBe('operator');
    const p = pol.current; p.bindings = p.bindings.filter(b => b.role !== 'operator'); pol.save(p);
    expect(pol.resolve(sched).role).toBe('member');
    process.env.OWNERS = 'someone-else@x.test';
    expect(pol.resolve(fromInternal({ uid: 'u1', email: OWNER, lane: 'wake' })).role).toBe('anonymous');
  });
});

describe('system lanes resolve to operator', () => {
  test('built-in schedules, module schedules and the legacy raw internal token', () => {
    expect(SYSTEM_UID).toBe(BUILTINS_SYSTEM_UID); // one definition
    const pol = policy();
    expect(pol.resolve(fromInternal({ uid: SYSTEM_UID, email: 'system@shraga.local', lane: 'scheduler' })).role).toBe('operator');
    expect(pol.resolve(fromInternal({ uid: 'module:reports', email: 'module@shraga.local', lane: 'scheduler' })).role).toBe('operator');
    expect(pol.resolve(fromInternal({ uid: 'agent-internal', email: 'agent@internal', lane: 'mcp-legacy-token' })).role).toBe('operator');
  });

  test('the uid shape alone is not a system lane (email must be the lane identity); other kinds never are', () => {
    const pol = policy();
    expect(isSystemPrincipal(fromInternal({ uid: 'module:x', email: 'attacker@else.test' }))).toBe(false);
    expect(isSystemPrincipal(fromInternal({ uid: 'module:', email: 'module@shraga.local' }))).toBe(false);
    expect(isSystemPrincipal(fromInternal({ uid: 'u9', email: 'system@shraga.local' }))).toBe(false);
    expect(isSystemPrincipal(fromApiKey({ id: 'agent-internal', uid: 'agent-internal', email: 'agent@internal' }))).toBe(false);
    expect(pol.resolve(fromInternal({ uid: 'module:x', email: 'attacker@else.test' })).role).toBe('anonymous');
  });

  test('a fail-closed (invalid) policy has no operator: system lanes fall to default', () => {
    const pol = new Policy({ path: path.join(dir, 'missing', 'policy.json'), whitelistPath: path.join(dir, 'w.json'), watch: false, log: quiet, isActive: () => false });
    expect(pol.valid).toBe(false);
    expect(pol.resolve(fromInternal({ uid: SYSTEM_UID, email: 'system@shraga.local' })).role).toBe('anonymous');
  });
});

describe('Slack principal resolves through email bindings like a verified login, never owner', () => {
  test('email bindings apply; an owner address over Slack is NOT owner; no email → slack-id bindings, else default', () => {
    const pol = policy();
    expect(pol.resolve(fromSlack('U1', { email: 'op@team.test' })).role).toBe('operator');
    expect(pol.resolve(fromSlack('U2', { email: 'dev@team.test' })).role).toBe('member');
    expect(pol.resolve(fromSlack('U3', { email: OWNER })).role).toBe('anonymous');
    expect(pol.resolve(fromSlack('UGUEST')).role).toBe('guest');
    expect(pol.resolve(fromSlack('U4')).role).toBe('anonymous');
  });

  test('earliest binding wins across the slack view and the email view', () => {
    const pol = policy();
    const p = pol.current;
    p.bindings.unshift({ match: { kind: 'slack', id: 'slack:U5' }, role: 'guest' });
    pol.save(p);
    expect(pol.resolve(fromSlack('U5', { email: 'op@team.test' })).role).toBe('guest');
  });

  test('email senders and api keys are unchanged (no email→user view)', () => {
    const pol = policy();
    expect(pol.resolve(fromEmailSender('op@team.test', true)).role).toBe('anonymous');
    expect(pol.resolve(fromApiKey({ id: 'k1', uid: 'u', email: OWNER })).role).toBe('anonymous');
  });
});
