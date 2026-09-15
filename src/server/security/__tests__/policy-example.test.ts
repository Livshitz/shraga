import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Policy, validatePolicy } from '../policy.ts';
import { fromAuthUser, fromEmailSender, fromSlack } from '../principal.ts';

// The documented example (shraga skill → Security model) must stay loadable by the real validator.
const EXAMPLE = path.resolve(import.meta.dir, '../../../../defaults/security/policy.example.json');
const quiet = { info() {}, warn() {}, error() {} };
let dir: string;
let prevOwners: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'policy-example-'));
  prevOwners = process.env.OWNERS;
  process.env.OWNERS = 'boss@example.com';
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (prevOwners === undefined) delete process.env.OWNERS; else process.env.OWNERS = prevOwners;
});

describe('defaults/security/policy.example.json', () => {
  test('passes validatePolicy', () => {
    expect(validatePolicy(JSON.parse(readFileSync(EXAMPLE, 'utf8')))).toEqual([]);
  });

  test('loads as a valid Policy and resolves as documented', () => {
    const p = path.join(dir, 'security', 'policy.json');
    mkdirSync(path.dirname(p), { recursive: true });
    copyFileSync(EXAMPLE, p);
    const pol = new Policy({ path: p, whitelistPath: path.join(dir, 'whitelist.json'), watch: false, log: quiet });
    expect(pol.valid).toBe(true);
    expect(pol.resolve(fromAuthUser({ uid: 'b', email: 'boss@example.com' })).role).toBe('owner'); // OWNERS, not the file
    expect(pol.resolve(fromAuthUser({ uid: 'o', email: 'sre@example.com' })).role).toBe('operator');
    expect(pol.resolve(fromSlack('U0123ABCD')).role).toBe('operator');
    expect(pol.resolve(fromAuthUser({ uid: 'm', email: 'dev@example.com' })).role).toBe('member');
    expect(pol.resolve(fromEmailSender('a@example.com', true)).role).toBe('member');
    expect(pol.resolve(fromEmailSender('x@other.org', true)).role).toBe('guest');
    expect(pol.resolve(fromEmailSender('x@other.org', false)).role).toBe('anonymous');
    expect(pol.blocked(fromEmailSender('bot@spam.example', true))).toBeDefined();
    pol.close();
  });
});
