// `mayReplyTo` — the owner toggle that gates an AUTOMATIC outbound reply to a low-trust inbound sender.
// It reads the real agent-config.json (same file the owner-only PUT /api/config writes), so these tests
// swap that file and restore it, exactly as engine-billing-guard.test.ts does.
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initSecurity, mayReplyTo, __resetSecurityForTest } from '../runtime.ts';
import { anonymous, fromAuthUser, fromEmailSender } from '../principal.ts';
import { CONFIG_PATH } from '../../agent-config.ts';
import type { AuditRecord } from '../audit.ts';

delete process.env.DATA_SYNC_ENABLE;
delete process.env.DATA_SYNC_REPO;

const OWNER = 'owner@untrusted-replies.test';
const MEMBER = 'member@untrusted-replies.test';
const OPERATOR = 'operator@untrusted-replies.test';
const GUEST = 'guest@untrusted-replies.test';

let root: string;
const prevOwners = process.env.OWNERS;
/** The deployment's real agent-config.json, restored verbatim afterwards. */
let prevConfig: string | null = null;

/** Set (or clear) the flag in the file `getAgentConfig()` actually reads. */
function setFlag(value: boolean | undefined): void {
  const cfg = value === undefined ? {} : { allowUntrustedReplies: value };
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

/** A runtime whose policy names the standard roles, with bindings for the test principals. */
function runtimeWithRoles() {
  const dir = mkdtempSync(path.join(root, 'rt-'));
  const rt = initSecurity({
    policy: { path: path.join(dir, 'security', 'policy.json'), whitelistPath: path.join(dir, 'whitelist.json'), watch: false },
    audit: { dir: path.join(dir, 'audit') },
    notify: () => {},
  });
  rt.policy.save({
    ...rt.policy.current,
    bindings: [
      { match: { kind: 'user', emailIn: [OPERATOR] }, role: 'operator' },
      { match: { kind: 'user', emailIn: [MEMBER] }, role: 'member' },
      { match: { kind: 'email', emailIn: [GUEST] }, role: 'guest' },
    ],
  });
  return rt;
}

const owner = () => fromAuthUser({ uid: OWNER, email: OWNER });
const operator = () => fromAuthUser({ uid: OPERATOR, email: OPERATOR });
const member = () => fromAuthUser({ uid: MEMBER, email: MEMBER });
const guest = () => fromEmailSender(GUEST, false);
/** An unverified sender nothing binds — falls through to the `anonymous` default. */
const unknownSender = () => fromEmailSender('stranger@elsewhere.test', false);

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'untrusted-replies-'));
  process.env.OWNERS = OWNER;
  mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  prevConfig = existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, 'utf8') : null;
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  if (prevConfig === null) { if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH); }
  else writeFileSync(CONFIG_PATH, prevConfig);
  if (prevOwners === undefined) delete process.env.OWNERS; else process.env.OWNERS = prevOwners;
});
afterEach(() => __resetSecurityForTest());

describe('flag OFF (the default)', () => {
  test('no reply below member rank; member and above still reply', () => {
    setFlag(undefined); // absent = off, what a fresh install runs
    runtimeWithRoles();
    expect(mayReplyTo(guest())).toBe(false);
    expect(mayReplyTo(unknownSender())).toBe(false);
    expect(mayReplyTo(anonymous())).toBe(false);
    expect(mayReplyTo(member())).toBe(true);
    expect(mayReplyTo(operator())).toBe(true);
    expect(mayReplyTo(owner())).toBe(true);
  });

  test('an explicit false behaves like absent', () => {
    setFlag(false);
    runtimeWithRoles();
    expect([mayReplyTo(guest()), mayReplyTo(member())]).toEqual([false, true]);
  });

  test('a suppressed reply is audited once per turn, not once per call', () => {
    setFlag(false);
    const rt = runtimeWithRoles();
    for (let i = 0; i < 5; i++) expect(mayReplyTo(guest(), { sessionId: 's-1', channel: 'mail' })).toBe(false);
    mayReplyTo(guest(), { sessionId: 's-2', channel: 'mail' });
    const rows = rt.audit.query({ limit: 100 }).items.filter((r: AuditRecord) => r.reason === 'untrusted-reply');
    expect(rows.length).toBe(2); // one per session, not six
    expect(rows[0]).toMatchObject({ type: 'guard.limit', principal: `email:${GUEST}`, role: 'guest', target: 'mail' });
  });

  test('a replyable principal is never audited as suppressed', () => {
    setFlag(false);
    const rt = runtimeWithRoles();
    expect(mayReplyTo(member(), { sessionId: 's-ok' })).toBe(true);
    expect(rt.audit.query({ limit: 100 }).items.filter((r: AuditRecord) => r.reason === 'untrusted-reply')).toEqual([]);
  });
});

describe('flag ON', () => {
  test('every principal is replyable, guest and anonymous included', () => {
    setFlag(true);
    runtimeWithRoles();
    for (const p of [guest(), unknownSender(), anonymous(), member(), operator(), owner()]) {
      expect(mayReplyTo(p)).toBe(true);
    }
  });
});

describe('fails closed', () => {
  test('no security runtime ⇒ no untrusted reply', () => {
    setFlag(false);
    __resetSecurityForTest();
    expect(mayReplyTo(guest())).toBe(false);
    expect(mayReplyTo(member())).toBe(false); // nothing can be resolved, so nothing is replyable
  });

  test('an invalid policy ⇒ no untrusted reply, even for a would-be member', () => {
    setFlag(false);
    const dir = mkdtempSync(path.join(root, 'bad-'));
    const policyPath = path.join(dir, 'security', 'policy.json');
    mkdirSync(path.dirname(policyPath), { recursive: true });
    writeFileSync(policyPath, '{ not json');
    const rt = initSecurity({
      policy: { path: policyPath, whitelistPath: path.join(dir, 'whitelist.json'), watch: false },
      audit: { dir: path.join(dir, 'audit') },
      notify: () => {}, log: { info() {}, warn() {}, error() {} },
    });
    expect(rt.policy.valid).toBe(false);
    expect(mayReplyTo(guest())).toBe(false);
    expect(mayReplyTo(member())).toBe(false);
    expect(mayReplyTo(owner())).toBe(false);
  });

  test('the flag still wins when it is ON — an operator opted in explicitly', () => {
    setFlag(true);
    __resetSecurityForTest();
    expect(mayReplyTo(guest())).toBe(true);
  });
});
