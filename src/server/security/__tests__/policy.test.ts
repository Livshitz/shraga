import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Policy, defaultPolicy, validatePolicy, type PolicyFile } from '../policy.ts';
import { fromAuthUser, fromEmailSender, fromSlack, anonymous } from '../principal.ts';

const quiet = { info() {}, warn() {}, error() {} };
let dir: string;
let prevOwners: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'policy-test-'));
  prevOwners = process.env.OWNERS;
  process.env.OWNERS = 'Boss@Owner.com, boss@owner.com';
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (prevOwners === undefined) delete process.env.OWNERS; else process.env.OWNERS = prevOwners;
});

const mk = (o: Partial<ConstructorParameters<typeof Policy>[0]> = {}) =>
  new Policy({ path: path.join(dir, 'security', 'policy.json'), whitelistPath: path.join(dir, 'whitelist.json'), watch: false, log: quiet, ...o });

function seeded(): PolicyFile {
  const p = defaultPolicy();
  p.bindings = [
    { match: { kind: 'user', emailIn: ['op@7chairs.org'] }, role: 'operator' },
    { match: { kind: 'email', domain: '7chairs.org', verified: true }, role: 'member' },
    { match: { kind: 'email', verified: true }, role: 'guest' },
    { match: { kind: 'user', emailIn: ['op@7chairs.org'] }, role: 'guest' }, // shadowed — first match wins
  ];
  return p;
}

describe('Policy.resolve', () => {
  test('first matching binding wins, in file order', () => {
    const pol = mk(); pol.save(seeded());
    expect(pol.resolve(fromAuthUser({ uid: 'u', email: 'OP@7chairs.org' })).role).toBe('operator');
    expect(pol.resolve(fromEmailSender('a@7chairs.org', true)).role).toBe('member');
    expect(pol.resolve(fromEmailSender('a@7chairs.org', false)).role).toBe('anonymous');
    expect(pol.resolve(fromEmailSender('x@gmail.com', true)).role).toBe('guest');
    expect(pol.resolve(fromSlack('U1')).role).toBe('anonymous');
    const r = pol.resolve(fromEmailSender('x@gmail.com', true));
    expect(r.profile.tools).toEqual(['escalate']);
    expect(r.rank).toBe(20);
  });

  test('earlier generic binding beats later email-indexed binding', () => {
    const p = defaultPolicy();
    p.bindings = [{ match: { kind: 'user' }, role: 'guest' }, { match: { emailIn: ['op@x.com'] }, role: 'operator' }];
    const pol = mk(); pol.save(p);
    expect(pol.resolve(fromAuthUser({ uid: 'u', email: 'op@x.com' })).role).toBe('guest');
  });

  test('owner comes from OWNERS env, not the file; unverified never owner', () => {
    const pol = mk(); pol.save(seeded());
    expect(pol.resolve(fromAuthUser({ uid: 'b', email: 'boss@owner.com' })).role).toBe('owner');
    expect(pol.resolve(fromEmailSender('boss@owner.com', false)).role).toBe('anonymous');
    const bad = seeded(); bad.bindings.push({ match: { kind: 'user' }, role: 'owner' });
    expect(() => pol.save(bad)).toThrow(/cannot grant owner/);
  });
});

describe('fail closed', () => {
  for (const [label, content] of [['empty', ''], ['garbage', '{nope'], ['schema', JSON.stringify({ roles: {}, profiles: {} })]] as const) {
    test(`${label} file ⇒ only owners above anonymous`, () => {
      const p = path.join(dir, 'security', 'policy.json');
      require('node:fs').mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, content);
      const pol = mk();
      expect(pol.valid).toBe(false);
      expect(pol.resolve(fromAuthUser({ uid: 'u', email: 'op@7chairs.org' })).role).toBe('anonymous');
      expect(pol.resolve(fromAuthUser({ uid: 'u', email: 'op@7chairs.org' })).profile.tools).toEqual([]);
      expect(pol.resolve(fromAuthUser({ uid: 'b', email: 'boss@owner.com' })).role).toBe('owner');
      expect(pol.resolve(fromAuthUser({ uid: 'b', email: 'boss@owner.com' })).profile.tools).toEqual(['*']);
    });
  }
  test('validatePolicy flags dangling refs', () => {
    const p: any = defaultPolicy(); p.roles.member.profile = 'ghost'; p.default = 'nobody';
    expect(validatePolicy(p).join()).toMatch(/ghost.*|nobody/);
  });
});

describe('effective (taint)', () => {
  test('takes the lower of floor and role', () => {
    const pol = mk(); pol.save(seeded());
    expect(pol.effective(100, 'operator').role).toBe('operator');
    expect(pol.effective(20, 'operator').role).toBe('guest');
    expect(pol.effective(30, 'operator').role).toBe('guest'); // highest role at/below floor
    expect(pol.effective(0, 'owner').role).toBe('anonymous');
    expect(pol.effective(50, 'guest').role).toBe('guest');
  });
});

describe('provenance', () => {
  test('external edit is rejected, last-good kept, onTamper fired', () => {
    const tampers: any[] = [];
    const pol = mk({ onTamper: (t) => tampers.push(t) });
    pol.save(seeded());
    expect(pol.reload()).toBe(true); // our own write
    const file = pol.options.path;
    const evil = JSON.parse(readFileSync(file, 'utf8'));
    evil.bindings.unshift({ match: { kind: 'email' }, role: 'operator' });
    writeFileSync(file, JSON.stringify(evil));
    expect(pol.reload()).toBe(false);
    expect(tampers).toHaveLength(1);
    expect(tampers[0].reason).toBe('hash-mismatch');
    expect(pol.resolve(fromEmailSender('x@gmail.com', false)).role).toBe('anonymous');
    unlinkSync(file);
    expect(pol.reload()).toBe(false);
    expect(tampers[1].reason).toBe('deleted');
    expect(pol.valid).toBe(true);
  });

  test('watcher: own save applies, external write is rejected', async () => {
    const tampers: any[] = [];
    const pol = mk({ watch: true, onTamper: (t) => tampers.push(t) });
    try {
      pol.save(seeded());
      await Bun.sleep(300);
      expect(tampers).toHaveLength(0);
      const evil = JSON.parse(readFileSync(pol.options.path, 'utf8'));
      evil.default = 'operator';
      writeFileSync(pol.options.path, JSON.stringify(evil));
      for (let i = 0; i < 40 && !tampers.length; i++) await Bun.sleep(50);
      expect(tampers.length).toBeGreaterThan(0);
      expect(pol.resolve(anonymous()).role).toBe('anonymous');
    } finally { pol.close(); }
  });
});

describe('migration', () => {
  test('missing policy ⇒ generated from whitelist + hook, then resolvable', () => {
    writeFileSync(path.join(dir, 'whitelist.json'), JSON.stringify(['A@x.com', 'b@y.com']));
    const pol = mk({ migrate: (d) => { d.bindings.push({ match: { kind: 'slack', id: 'slack:U9' }, role: 'operator' }); } });
    expect(existsSync(pol.options.path)).toBe(true);
    expect(pol.valid).toBe(true);
    expect(pol.resolve(fromAuthUser({ uid: 'a', email: 'a@x.com' })).role).toBe('operator');
    expect(pol.resolve(fromAuthUser({ uid: 'c', email: 'c@x.com' })).role).toBe('anonymous');
    expect(pol.resolve(fromSlack('U9')).role).toBe('operator');
    expect(pol.reload()).toBe(true); // migrated file is trusted provenance
  });

  test('no whitelist ⇒ defaults with no bindings', () => {
    const pol = mk();
    expect(pol.current.bindings).toEqual([]);
    expect(pol.resolve(fromAuthUser({ uid: 'a', email: 'a@x.com' })).role).toBe('anonymous');
  });
});
