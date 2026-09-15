import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Guard, clientIp, parseRate, parseTrustedProxies, type GuardOptions } from '../guard.ts';
import { SecurityRuntime } from '../runtime.ts';
import { anonymous, fromApiKey, fromAuthUser } from '../principal.ts';
import type { AuditEvent } from '../audit.ts';

delete process.env.DATA_SYNC_ENABLE;
delete process.env.DATA_SYNC_REPO;

const quiet = { info() {}, warn() {}, error() {} };
let root: string;
beforeAll(() => { root = mkdtempSync(path.join(tmpdir(), 'sec-guard-')); });
afterAll(() => rmSync(root, { recursive: true, force: true }));

const P = fromApiKey({ id: 'k1', uid: 'u1', email: 'a@b.test' });
const tmpBlocks = () => path.join(mkdtempSync(path.join(root, 'g-')), 'security', 'blocks.json');

function mk(extra: Partial<GuardOptions> = {}, now = { t: 1_000_000 }) {
  const events: Array<[AuditEvent, string | undefined]> = [];
  const g = new Guard({
    clock: () => now.t, log: quiet, blocksPath: tmpBlocks(), enforce: () => true,
    audit: (e, k) => events.push([e, k]), trustedProxies: parseTrustedProxies(''),
    ...extra,
  });
  return { g, now, events };
}

describe('rates', () => {
  test('parseRate', () => {
    expect(parseRate('600/h')).toEqual({ cap: 600, periodMs: 3_600_000 });
    expect(parseRate('5/m')).toEqual({ cap: 5, periodMs: 60_000 });
    expect(parseRate('0')).toEqual({ cap: 0, periodMs: 3_600_000 });
    expect(parseRate('nope')).toBeNull();
  });

  test('bucket drains, then refills with a fake clock', () => {
    const { g, now } = mk();
    const input = { principal: P, rank: 20, rate: '2/m' };
    expect(g.check(input).ok).toBe(true);
    expect(g.check(input).ok).toBe(true);
    const denied = g.check(input);
    expect(denied).toEqual({ ok: false, status: 429, retryAfter: 30, reason: 'rate' });
    now.t += 29_000;
    expect(g.check(input).ok).toBe(false);
    now.t += 1_000; // 30s = one token back
    expect(g.check(input).ok).toBe(true);
    expect(g.check(input).ok).toBe(false);
    now.t += 10 * 60_000; // refill caps at capacity (2), not 20
    expect(g.check(input).ok).toBe(true);
    expect(g.check(input).ok).toBe(true);
    expect(g.check(input).ok).toBe(false);
  });

  test('"0" denies everything with 403 and is not an auto-block signal', () => {
    const { g } = mk({ limits: { blockAfter: 2 } });
    for (let i = 0; i < 5; i++) expect(g.check({ principal: P, rank: 0, rate: '0' })).toEqual({ ok: false, status: 403, reason: 'rate-zero' });
    expect(g.list()).toHaveLength(0);
  });

  test('a denial on one bucket consumes no token from the others', () => {
    const { g } = mk({ limits: { ip: '1/h' } });
    expect(g.check({ principal: P, ip: '9.9.9.9', rank: 20, rate: '2/h' }).ok).toBe(true);
    expect(g.check({ principal: P, ip: '9.9.9.9', rank: 20, rate: '2/h' })).toMatchObject({ ok: false, reason: 'rate' }); // ip empty
    expect(g.check({ principal: P, ip: '8.8.8.8', rank: 20, rate: '2/h' }).ok).toBe(true); // principal still had its 2nd token
  });

  test('clock stepping back 1h does not drain the bucket', () => {
    const { g, now } = mk({}, { t: 10_000_000 });
    const input = { principal: P, rank: 20, rate: '60/h' };
    expect(g.check(input).ok).toBe(true);
    now.t -= 3_600_000;
    for (let i = 0; i < 59; i++) expect(g.check(input).ok).toBe(true); // the remaining 59 tokens are all still there
    expect(g.check(input).ok).toBe(false);
  });
});

describe('shared IP', () => {
  const IP = '203.0.113.7';
  const guest = fromApiKey({ id: 'guest', uid: 'g' });
  const owner = fromAuthUser({ uid: 'o', email: 'o@x.test' });

  test('100 guest denials from one IP never lock the owner out of that IP', () => {
    const { g } = mk({ limits: { ip: '5/h' } });
    let denials = 0;
    for (let i = 0; denials < 100; i++) if (!g.check({ principal: guest, ip: IP, rank: 20, rate: '100000/h' }).ok) denials++;
    expect(g.list().map(b => b.key)).toContain(`ip:${IP}`); // single principal drove it → the IP IS blocked for guests
    expect(g.check({ principal: guest, ip: IP, rank: 20, rate: '100000/h' })).toMatchObject({ ok: false, reason: 'blocked' });
    expect(g.check({ principal: owner, ip: IP, rank: 100, rate: '600/h' })).toEqual({ ok: true });
  });

  test('hits from more than one authenticated principal never auto-block the IP', () => {
    const { g } = mk({ limits: { ip: '1/h', blockAfter: 5 } });
    const a = fromApiKey({ id: 'a', uid: 'a' }), b = fromApiKey({ id: 'b', uid: 'b' });
    for (let i = 0; i < 50; i++) g.check({ principal: i % 2 ? a : b, ip: IP, rank: 20, rate: '100000/h' });
    expect(g.list()).toHaveLength(0);
  });

  test('a single abusive unauthenticated source still gets its IP blocked', () => {
    const { g } = mk({ limits: { ip: '1/h', blockAfter: 5 } });
    for (let i = 0; i < 10; i++) g.check({ principal: anonymous(), ip: IP, rank: 0, rate: '100000/h' });
    expect(g.list().map(b => b.key)).toContain(`ip:${IP}`);
  });
});

describe('auto-block', () => {
  test('after N hits → persisted, survives a new Guard, audited once as guard.block', () => {
    const now = { t: 5_000_000 };
    const { g, events } = mk({ limits: { blockAfter: 3, blockTtlMs: 60_000 } }, now);
    const input = { principal: P, rank: 20, rate: '1/h' };
    expect(g.check(input).ok).toBe(true);
    for (let i = 0; i < 3; i++) expect(g.check(input)).toMatchObject({ ok: false, status: 429 });
    const blocked = g.check(input);
    expect(blocked).toEqual({ ok: false, status: 403, reason: 'blocked', retryAfter: 60 });

    const file = JSON.parse(readFileSync(g.options.blocksPath, 'utf8'));
    expect(Object.keys(file.blocks)).toEqual([`principal:${P.id}`]);
    expect(events.filter(([e]) => e.type === 'guard.block' && e.meta?.created)).toHaveLength(1);
    expect(events.filter(([e]) => e.type === 'guard.limit').every(([, k]) => !!k)).toBe(true); // limit audits are deduped

    const g2 = new Guard({ clock: () => now.t, log: quiet, blocksPath: g.options.blocksPath, enforce: () => true });
    expect(g2.check({ principal: P, rank: 20, rate: '100/h' })).toMatchObject({ ok: false, status: 403, reason: 'blocked' });
  });

  test('owners (exempt rank) are rate-limited but never auto-blocked', () => {
    const { g } = mk({ limits: { blockAfter: 2 } });
    const owner = { principal: fromAuthUser({ uid: 'o', email: 'o@x.test' }), rank: 100, rate: '1/h' };
    for (let i = 0; i < 6; i++) g.check(owner);
    expect(g.list()).toHaveLength(0);
  });

  test('expired entries are pruned at load and on expiry', () => {
    const blocksPath = tmpBlocks();
    mkdirSync(path.dirname(blocksPath), { recursive: true });
    const now = { t: 10_000_000 };
    writeFileSync(blocksPath, JSON.stringify({ version: 1, blocks: {
      'ip:1.1.1.1': { until: now.t - 1, reason: 'old', at: 0 },
      [`principal:${P.id}`]: { until: now.t + 5_000, reason: 'auto', at: now.t },
      'junk': { until: 'soon' },
    } }));
    const g = new Guard({ clock: () => now.t, log: quiet, blocksPath, enforce: () => true });
    expect(g.list().map(b => b.key)).toEqual([`principal:${P.id}`]);
    expect(Object.keys(JSON.parse(readFileSync(blocksPath, 'utf8')).blocks)).toEqual([`principal:${P.id}`]);

    expect(g.check({ principal: P, rank: 20, rate: '9/h' })).toMatchObject({ ok: false, reason: 'blocked', retryAfter: 5 });
    now.t += 5_000;
    expect(g.check({ principal: P, rank: 20, rate: '9/h' }).ok).toBe(true);
    expect(JSON.parse(readFileSync(blocksPath, 'utf8')).blocks).toEqual({});
  });

  test('PASSIVE never writes blocks.json; activate() persists the in-memory blocks', () => {
    let active = false;
    const { g } = mk({ isActive: () => active, limits: { blockAfter: 1 } });
    g.check({ principal: P, rank: 20, rate: '1/h' });
    g.check({ principal: P, rank: 20, rate: '1/h' });
    expect(g.list()).toHaveLength(1);
    expect(existsSync(g.options.blocksPath)).toBe(false);
    active = true; g.activate();
    expect(Object.keys(JSON.parse(readFileSync(g.options.blocksPath, 'utf8')).blocks)).toEqual([`principal:${P.id}`]);
  });
});

describe('client IP', () => {
  test('x-forwarded-for is ignored without a trusted proxy (spoofing)', () => {
    const none = parseTrustedProxies(undefined);
    expect(clientIp('203.0.113.7', '1.2.3.4', none)).toBe('203.0.113.7');
    expect(clientIp('::ffff:127.0.0.1', '1.2.3.4', none)).toBe('127.0.0.1');
    // a trusted list that doesn't include the actual peer: still ignored
    expect(clientIp('203.0.113.7', '1.2.3.4', parseTrustedProxies('10.0.0.0/8'))).toBe('203.0.113.7');
  });

  test('honored from a trusted proxy: rightmost untrusted hop wins over client-supplied values', () => {
    const trusted = parseTrustedProxies('127.0.0.1, ::1, 10.0.0.0/8');
    expect(clientIp('127.0.0.1', '1.2.3.4', trusted)).toBe('1.2.3.4');
    expect(clientIp('::ffff:127.0.0.1', '6.6.6.6, 198.51.100.9, 10.1.2.3', trusted)).toBe('198.51.100.9');
    expect(clientIp('::1', ['6.6.6.6', '198.51.100.9'], trusted)).toBe('198.51.100.9');
    expect(clientIp('127.0.0.1', 'garbage, 10.0.0.5', trusted)).toBe('10.0.0.5');
    expect(clientIp('127.0.0.1', undefined, trusted)).toBe('127.0.0.1');
  });

  test('Guard.ipOf reads the socket peer + header; loopback gets no IP bucket', () => {
    const { g } = mk({ trustedProxies: parseTrustedProxies('127.0.0.1'), limits: { ip: '1/h' } });
    const req = (xff?: string) => ({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': xff } });
    expect(g.ipOf(req('198.51.100.1'))).toBe('198.51.100.1');
    const other = (id: string) => fromApiKey({ id, uid: id });
    // loopback (no forwarded client): many principals, no shared ip:127.0.0.1 bucket
    for (let i = 0; i < 5; i++) expect(g.check({ principal: other(`l${i}`), ip: g.ipOf(req()), rank: 20, rate: '9/h' }).ok).toBe(true);
    expect(g.check({ principal: other('x1'), ip: g.ipOf(req('198.51.100.1')), rank: 20, rate: '9/h' }).ok).toBe(true);
    expect(g.check({ principal: other('x2'), ip: g.ipOf(req('198.51.100.1')), rank: 20, rate: '9/h' })).toMatchObject({ ok: false, reason: 'rate' });
  });
});

describe('bounds', () => {
  test('memory stays bounded under 100k distinct principals/IPs', () => {
    const { g } = mk({ limits: { maxKeys: 1_000, blockAfter: 1 }, enforce: () => false });
    const t0 = performance.now();
    for (let i = 0; i < 100_000; i++) {
      const ip = `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
      const p = fromApiKey({ id: `spray-${i}`, uid: 'x' });
      g.check({ principal: p, ip, rank: 20, rate: '1/h' });
      g.check({ principal: p, ip, rank: 20, rate: '1/h' }); // hit → block path too
    }
    const inner = g as any;
    expect(inner.buckets.size).toBeLessThanOrEqual(1_000);
    expect(inner.hits.size).toBeLessThanOrEqual(1_000);
    expect(inner.blocks.size).toBeLessThanOrEqual(1_000);
    expect(performance.now() - t0).toBeLessThan(60_000);
  }, 90_000);

  test('concurrency ceiling: release on throw, idempotent release, rank >= 50 bypasses', async () => {
    const { g } = mk({ limits: { maxConcurrentTurns: 1 } });
    await expect(g.withTurn(20, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(g.turnsInFlight).toBe(0);

    const r = g.acquireTurn(20)!;
    expect(r).toBeFunction();
    expect(g.acquireTurn(20)).toBeNull();
    expect(g.admit({ principal: P, rank: 20, rate: '9/h' })).toMatchObject({ ok: false, status: 429, reason: 'turn-ceiling' });
    expect(g.acquireTurn(50)).toBeFunction(); // member+ not counted
    r(); r();
    expect(g.turnsInFlight).toBe(0);
    const a = g.admit({ principal: P, rank: 20, rate: '9/h' });
    expect(a.ok).toBe(true);
    if (a.ok) a.release();
    expect(g.turnsInFlight).toBe(0);
  });
});

describe('shadow mode', () => {
  test('never denies: rate, auto-block, blocklist and turn ceiling all admit with wouldDeny', () => {
    const { g, events } = mk({ enforce: () => false, limits: { blockAfter: 2, maxConcurrentTurns: 0 },
      blocklist: (p) => (p.id === 'apikey:banned' ? { until: null, reason: 'manual' } : undefined) });
    const input = { principal: P, rank: 20, rate: '1/h' };
    const verdicts = Array.from({ length: 6 }, () => g.check(input));
    expect(verdicts.every(v => v.ok)).toBe(true);
    expect(verdicts.at(-1)).toMatchObject({ ok: true, wouldDeny: { status: 403, reason: 'blocked' } });
    expect(g.check({ principal: fromApiKey({ id: 'banned', uid: 'b' }), rank: 20, rate: '9/h' })).toMatchObject({ ok: true, wouldDeny: { reason: 'blocked' } });
    expect(g.check({ principal: P, rank: 0, rate: '0' })).toMatchObject({ ok: true, wouldDeny: { reason: 'blocked' } });
    const other = fromApiKey({ id: 'fresh', uid: 'f' });
    const adm = g.admit({ principal: other, rank: 20, rate: '9/h' });
    expect(adm).toMatchObject({ ok: true, wouldDeny: { reason: 'turn-ceiling' } });
    expect(events.some(([e]) => e.type === 'guard.limit' && e.meta?.enforced === false)).toBe(true);
    expect(events.some(([e]) => e.type === 'guard.block' && e.meta?.created)).toBe(true);
  });

  test('SECURITY_ENFORCE env is the default switch', () => {
    const prev = process.env.SECURITY_ENFORCE;
    try {
      const g = new Guard({ log: quiet, blocksPath: tmpBlocks() });
      delete process.env.SECURITY_ENFORCE;
      expect(g.check({ principal: P, rank: 0, rate: '0' }).ok).toBe(true);
      process.env.SECURITY_ENFORCE = 'true';
      expect(g.check({ principal: P, rank: 0, rate: '0' }).ok).toBe(false);
    } finally { if (prev === undefined) delete process.env.SECURITY_ENFORCE; else process.env.SECURITY_ENFORCE = prev; }
  });
});

describe('SecurityRuntime.admitTurn (policy → guard → audit)', () => {
  test('rank/rate come from the resolved profile; guard events land in the audit chain, deduped', () => {
    const dir = mkdtempSync(path.join(root, 'rt-'));
    const now = { t: Date.now() };
    const rt = new SecurityRuntime({
      clock: () => now.t, notify: () => {}, log: quiet,
      policy: { path: path.join(dir, 'security', 'policy.json'), whitelistPath: path.join(dir, 'w.json'), watch: false },
      audit: { dir: path.join(dir, 'audit') },
      guard: { blocksPath: path.join(dir, 'security', 'blocks.json'), enforce: () => true, limits: { blockAfter: 100 } },
    });
    // default policy: an api key resolves to anonymous → profile "none" → rate "0"
    expect(rt.admitTurn(P)).toEqual({ ok: false, status: 403, reason: 'rate-zero' });
    expect(rt.admitTurn(P)).toMatchObject({ ok: false });
    const limits = rt.audit.query({ limit: 100 }).items.filter(r => r.type === 'guard.limit');
    expect(limits).toHaveLength(1);
    expect(limits[0]).toMatchObject({ principal: P.id, target: `principal:${P.id}`, reason: 'rate-zero' });
    rt.close();
  });
});
