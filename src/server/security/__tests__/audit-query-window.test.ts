import { test, expect, afterEach } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Audit } from '../audit.ts';
import { recentPrincipals } from '../owner-routes.ts';

// A `from` window must cost the window, not the whole audit history (the Principals endpoint queries every request).
const quiet = { info() {}, warn() {}, error() {} };
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) { try { chmodSync(path.join(d, '2025-01.jsonl'), 0o600); } catch {} rmSync(d, { recursive: true, force: true }); } });

const rec = (ts: string, principal: string) => JSON.stringify({ ts, type: 'turn.start', principal, prevHash: 'x', hash: `h-${principal}-${ts}` }) + '\n';
const month = (ms: number) => new Date(ms).toISOString().slice(0, 7);

test('old month files are never opened: 200k old records + an empty window returns fast', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'audit-window-')); dirs.push(dir);
  const old = path.join(dir, '2025-01.jsonl');
  writeFileSync(old, rec('2025-01-01T00:00:00.000Z', 'user:old@x').repeat(200_000));
  chmodSync(old, 0o000); // opening it throws EACCES → query would throw instead of returning
  const audit = new Audit({ dir, log: quiet });
  const t0 = performance.now();
  const out = recentPrincipals({ audit } as any, Date.now() - 86_400_000, 200);
  const ms = performance.now() - t0;
  expect(out).toEqual({ principals: [], truncated: false });
  expect(ms).toBeLessThan(200);
  // Control: without `from` the same query DOES open the file (proves the chmod trap is armed).
  expect(() => audit.query({ limit: 1 })).toThrow();
});

test('within a current file, reading stops below the window (+ skew slack) but in-window records are all returned', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'audit-window-')); dirs.push(dir);
  const now = Date.now();
  const stale = new Date(now - 90 * 86_400_000).toISOString();
  const fresh = (i: number) => new Date(now - 1000 + i).toISOString();
  // 200k records older than from − 31d at the top of THIS month's file, then 3 in-window records (appended last = newest).
  writeFileSync(path.join(dir, `${month(now)}.jsonl`), rec(stale, 'user:old@x').repeat(200_000) + [0, 1, 2].map(i => rec(fresh(i), `user:new${i}@x`)).join(''));
  const audit = new Audit({ dir, log: quiet });
  const t0 = performance.now();
  const page = audit.query({ from: now - 86_400_000, limit: 500 });
  const ms = performance.now() - t0;
  expect(page.items.map(r => r.principal)).toEqual(['user:new2@x', 'user:new1@x', 'user:new0@x']);
  expect(page.nextCursor).toBeUndefined();
  expect(ms).toBeLessThan(200);
  // Control: a full scan of the same file (no from) reaches the old records.
  const t1 = performance.now();
  expect(audit.query({ principal: 'user:none', limit: 1 }).items).toEqual([]);
  expect(performance.now() - t1).toBeGreaterThan(ms * 3);
});

test('skew slack: a record in the month file before `from`\'s month is still found; older files are skipped', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'audit-window-')); dirs.push(dir);
  const from = Date.parse('2026-03-02T00:00:00Z');
  writeFileSync(path.join(dir, '2026-02.jsonl'), rec('2026-03-05T00:00:00.000Z', 'user:skewed@x')); // ts ahead of its file
  writeFileSync(path.join(dir, '2026-01.jsonl'), rec('2026-03-06T00:00:00.000Z', 'user:too-old-file@x')); // beyond the slack: skipped
  const audit = new Audit({ dir, log: quiet });
  expect(audit.query({ from, limit: 10 }).items.map(r => r.principal)).toEqual(['user:skewed@x']);
});
