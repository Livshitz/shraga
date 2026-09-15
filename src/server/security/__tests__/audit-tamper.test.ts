// The audit log is not deletable from the app: no DELETE route under /api/owner/audit, and the audit module itself
// only ever appends. (Agent file tools are write-denied on audit/ — enforce.test.ts "protected data".)
import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ownerRouter } from '../owner-routes.ts';

type Route = { path: string; methods: string[] };
const routes = (stack: any[]): Route[] => stack.flatMap((l: any) => l.route
  ? [{ path: String(l.route.path), methods: Object.keys(l.route.methods) }]
  : l.handle?.stack ? routes(l.handle.stack) : []);

test('no DELETE route under /api/owner/audit (owner router, nested routers included)', () => {
  const all = routes((ownerRouter as any).stack);
  expect(all.some(r => r.methods.includes('delete'))).toBe(true); // the walk does see DELETE routes (api-keys) — else this proves nothing
  expect(all.filter(r => r.methods.includes('delete') && /audit/i.test(r.path))).toEqual([]);
});

test('no server source registers a DELETE route for audit, and audit.ts never unlinks, truncates or rewrites', () => {
  const root = path.join(import.meta.dir, '../..');
  const files = (readdirSync(root, { recursive: true }) as string[]).filter(f => f.endsWith('.ts') && !f.includes('__tests__'));
  const offenders = files.filter(f => /\.delete\(\s*['"`][^'"`]*audit/i.test(readFileSync(path.join(root, f), 'utf8')));
  expect(offenders).toEqual([]);
  expect(readFileSync(path.join(import.meta.dir, '../audit.ts'), 'utf8')).not.toMatch(/\b(?:unlinkSync|truncateSync|ftruncateSync|writeFileSync|renameSync|rmSync)\b/);
});
