import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Audit, GENESIS_HASH, type AuditRecord } from '../audit.ts';
import { Policy, defaultPolicy, type PolicyOptions } from '../policy.ts';

const errors: string[] = [];
const quiet = { info() {}, warn() {}, error(m: string) { errors.push(m); } };
let dir: string;
let now: number;

beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'audit-test-')); now = Date.parse('2026-01-31T23:59:00Z'); errors.length = 0; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const mk = () => new Audit({ dir: path.join(dir, 'audit'), clock: () => now, log: quiet });
const lines = (f: string) => readFileSync(path.join(dir, 'audit', f), 'utf8').trim().split('\n').map(l => JSON.parse(l) as AuditRecord);

describe('Audit chain', () => {
  test('continues across monthly rotation', () => {
    const a = mk();
    const first = a.append({ type: 'auth.allow', principal: 'user:a' })!;
    a.append({ type: 'turn.start', principal: 'user:a', sessionId: 's1' });
    now = Date.parse('2026-02-01T00:00:01Z');
    a.append({ type: 'turn.end', principal: 'user:a', sessionId: 's1' });
    expect(readdirSync(path.join(dir, 'audit')).sort()).toEqual(['2026-01.jsonl', '2026-02.jsonl']);
    expect(first.prevHash).toBe(GENESIS_HASH);
    const jan = lines('2026-01.jsonl'), feb = lines('2026-02.jsonl');
    expect(jan[1].prevHash).toBe(jan[0].hash);
    expect(feb[0].prevHash).toBe(jan[1].hash);
    expect(a.verify()).toEqual({ ok: true, lines: 3 });
    expect(a.verify('2026-02.jsonl')).toEqual({ ok: true, lines: 1 }); // seeded from January's tail
  });

  test('continues across a restart (new instance), incl. tails longer than one read chunk', () => {
    const a = mk();
    for (let i = 0; i < 400; i++) a.append({ type: 'tool.allow', target: `Read-${i}`, meta: { pad: 'x'.repeat(200) } });
    const b = mk();
    expect(b.head).toBe(a.head);
    const rec = b.append({ type: 'tool.deny', target: 'Bash' })!;
    expect(rec.prevHash).toBe(a.head);
    expect(b.verify()).toEqual({ ok: true, lines: 401 });
  });

  test('clock going back a month still appends to the newest file (file order = chain order)', () => {
    now = Date.parse('2026-03-01T00:00:00Z'); mk().append({ type: 'escalate' });
    now = Date.parse('2026-02-15T00:00:00Z'); mk().append({ type: 'escalate' });
    expect(readdirSync(path.join(dir, 'audit'))).toEqual(['2026-03.jsonl']);
    expect(mk().verify().ok).toBe(true);
  });

  test('verify detects an edited line and a deleted line', () => {
    const a = mk();
    for (const t of ['auth.allow', 'auth.deny', 'role.resolve', 'turn.start'] as const) a.append({ type: t, principal: 'user:a', reason: 'r' });
    const file = path.join(dir, 'audit', '2026-01.jsonl');
    const orig = readFileSync(file, 'utf8');

    writeFileSync(file, orig.replace('"type":"auth.deny"', '"type":"auth.allow"'));
    expect(a.verify()).toEqual({ ok: false, lines: 2, brokenAt: { file: '2026-01.jsonl', line: 2, reason: 'hash' } });

    const ls = orig.trim().split('\n');
    writeFileSync(file, [ls[0], ls[2], ls[3]].join('\n') + '\n');
    expect(a.verify()).toEqual({ ok: false, lines: 2, brokenAt: { file: '2026-01.jsonl', line: 2, reason: 'prev-hash' } });

    writeFileSync(file, ls.slice(1).join('\n') + '\n'); // first-ever line removed
    expect(a.verify().brokenAt).toEqual({ file: '2026-01.jsonl', line: 1, reason: 'prev-hash' });

    writeFileSync(file, orig);
    expect(a.verify().ok).toBe(true);
  });
});

describe('Audit sanitize', () => {
  test('strips secret/body-named keys at any depth, redacts credential-looking values, truncates', () => {
    const a = mk();
    const rec = a.append({
      type: 'key.create', principal: 'user:a', reason: 'y'.repeat(1000),
      meta: {
        keyId: 'k_1', apiKey: 'sk-live', token: 't', accessToken: 't', client_secret: 's', password: 'p', Authorization: 'a',
        cookie: 'c', prompt: 'hello', body: 'b', nested: { refreshToken: 'r', ok: 1, header: 'Bearer abc.def', slack: 'xoxb-123' },
        long: 'z'.repeat(1000),
      },
    })!;
    const line = readFileSync(path.join(dir, 'audit', '2026-01.jsonl'), 'utf8');
    for (const bad of ['sk-live', 'apiKey', 'accessToken', 'client_secret', 'password', 'Authorization', 'cookie', 'prompt', 'refreshToken', 'Bearer', 'xoxb']) expect(line).not.toContain(bad);
    expect(rec.meta).toEqual({ keyId: 'k_1', nested: { ok: 1, header: '[redacted]', slack: '[redacted]' }, long: `${'z'.repeat(256)}…` });
    expect(rec.reason!.length).toBe(257);
    expect(a.verify().ok).toBe(true);
  });

  test('oversized meta is replaced by a key list', () => {
    const meta = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`f${i}`, 'v'.repeat(200)]));
    const rec = mk().append({ type: 'policy.change', meta })!;
    expect(rec.meta).toEqual({ _truncated: true, keys: Object.keys(meta).slice(0, 20) });
  });
});

describe('Audit query', () => {
  const seed = () => {
    const a = mk();
    for (let i = 0; i < 10; i++) {
      now = Date.parse(`2026-0${i < 5 ? 1 : 2}-1${i}T00:00:00Z`);
      a.append({ type: i % 2 ? 'tool.deny' : 'tool.allow', principal: i % 3 ? 'user:a' : 'user:b', target: `t${i}` });
    }
    return a;
  };

  test('newest first, filters by type/principal/time', () => {
    const a = seed();
    expect(a.query({ limit: 100 }).items.map(r => r.target)).toEqual(['t9', 't8', 't7', 't6', 't5', 't4', 't3', 't2', 't1', 't0']);
    expect(a.query({ limit: 100, type: 'tool.deny' }).items.map(r => r.target)).toEqual(['t9', 't7', 't5', 't3', 't1']);
    expect(a.query({ limit: 100, principal: 'user:b' }).items.map(r => r.target)).toEqual(['t9', 't6', 't3', 't0']);
    expect(a.query({ limit: 100, type: ['tool.deny'], principal: 'user:b' }).items.map(r => r.target)).toEqual(['t9', 't3']);
    expect(a.query({ limit: 100, from: '2026-01-13T00:00:00Z', to: new Date('2026-02-16T00:00:00Z') }).items.map(r => r.target)).toEqual(['t6', 't5', 't4', 't3']);
  });

  test('pagination walks every match exactly once across files, last page has no cursor', () => {
    const a = seed();
    const seen: string[] = [];
    let cursor: string | undefined, pages = 0;
    do {
      const page = a.query({ limit: 3, principal: 'user:a', cursor });
      seen.push(...page.items.map(r => r.target!));
      cursor = page.nextCursor; pages++;
    } while (cursor && pages < 10);
    expect(seen).toEqual(['t8', 't7', 't5', 't4', 't2', 't1']);
    expect(pages).toBe(2);
    expect(() => a.query({ limit: 1, cursor: 'garbage' })).toThrow('invalid audit cursor');
  });
});

describe('Audit failure isolation', () => {
  test('append never throws on an unwritable dir; failures counted', () => {
    const blocker = path.join(dir, 'file');
    writeFileSync(blocker, 'x');
    const a = new Audit({ dir: path.join(blocker, 'audit'), clock: () => now, log: quiet });
    expect(a.append({ type: 'auth.deny' })).toBeNull();
    expect(a.append({ type: 'bogus' as any })).toBeNull();
    expect(a.failures).toBe(2);
    expect(a.head).toBe(GENESIS_HASH);
    expect(errors.some(e => e.startsWith('[audit] append failed'))).toBe(true);
  });

  test("Policy's onTamper feeds audit.append as policy.tamper", () => {
    const a = mk();
    const onTamper: PolicyOptions['onTamper'] = info => a.append({ type: 'policy.tamper', target: info.path, reason: info.reason, meta: { expected: info.expected, actual: info.actual } });
    const policyPath = path.join(dir, 'security', 'policy.json');
    const pol = new Policy({ path: policyPath, whitelistPath: path.join(dir, 'whitelist.json'), watch: false, log: quiet, onTamper });
    pol.save(defaultPolicy());
    writeFileSync(policyPath, JSON.stringify({ ...defaultPolicy(), bindings: [{ match: { kind: 'user' }, role: 'operator' }] }));
    expect(pol.reload()).toBe(false);
    const [rec] = a.query({ limit: 5, type: 'policy.tamper' }).items;
    expect(rec).toMatchObject({ type: 'policy.tamper', target: policyPath, reason: 'hash-mismatch' });
    expect(typeof (rec.meta as any).actual).toBe('string');
  });
});
