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

test('a back-skewed record (real append, clock jumps back 90d once) never hides earlier in-window records', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'audit-window-')); dirs.push(dir);
  const now = Date.now();
  let t = now - 3000;
  const audit = new Audit({ dir, log: quiet, clock: () => t });
  audit.append({ type: 'turn.start', principal: 'user:a-before@x' });
  t = now - 90 * 86_400_000;
  audit.append({ type: 'turn.start', principal: 'user:skewed@x' }); // written between the two, stamped 90d ago
  t = now - 1000;
  audit.append({ type: 'turn.start', principal: 'user:b-after@x' });
  const from = now - 86_400_000;
  expect(audit.query({ limit: 10 }).items.map(r => r.principal)).toEqual(['user:b-after@x', 'user:skewed@x', 'user:a-before@x']);
  expect(audit.query({ from, limit: 10 }).items.map(r => r.principal)).toEqual(['user:b-after@x', 'user:a-before@x']);
  expect(recentPrincipals({ audit } as any, from, 200).principals.map((p: any) => p.id).sort()).toEqual(['user:a-before@x', 'user:b-after@x']);
  // Pagination keeps it too: one record per page still reaches the record below the skewed one.
  const p1 = audit.query({ from, limit: 1 });
  expect(audit.query({ from, limit: 1, cursor: p1.nextCursor }).items.map(r => r.principal)).toEqual(['user:a-before@x']);
});

test('skew slack: a record in the month file before `from`\'s month is still found; older files are skipped', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'audit-window-')); dirs.push(dir);
  const from = Date.parse('2026-03-02T00:00:00Z');
  writeFileSync(path.join(dir, '2026-02.jsonl'), rec('2026-03-05T00:00:00.000Z', 'user:skewed@x')); // ts ahead of its file
  writeFileSync(path.join(dir, '2026-01.jsonl'), rec('2026-03-06T00:00:00.000Z', 'user:too-old-file@x')); // beyond the slack: skipped
  const audit = new Audit({ dir, log: quiet });
  expect(audit.query({ from, limit: 10 }).items.map(r => r.principal)).toEqual(['user:skewed@x']);
});
