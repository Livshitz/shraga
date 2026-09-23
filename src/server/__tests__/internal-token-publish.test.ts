// A non-server process importing auth.ts (the `shraga para post` CLI) must not overwrite the live server's
// `.internal-token` — it did on import, and every token signed from the file then 401'd (feedox 2026-09-23).
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('importing auth.ts leaves the server token alone; publishInternalToken() writes it', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'itok-'));
  const DATA = path.join(root, 'data'), TOK = path.join(root, '.tmp', '.internal-token');
  mkdirSync(DATA, { recursive: true }); mkdirSync(path.dirname(TOK), { recursive: true });
  writeFileSync(TOK, 'live-server-secret');
  const env = { ...process.env, DATA_DIR: DATA, INTERNAL_API_TOKEN: '' };
  const auth = JSON.stringify(path.join(import.meta.dir, '../auth.ts'));
  try {
    execFileSync('bun', ['-e', `await import(${auth});`], { env, stdio: 'pipe', timeout: 30_000 });
    expect(readFileSync(TOK, 'utf8')).toBe('live-server-secret');
    execFileSync('bun', ['-e', `const a = await import(${auth}); a.publishInternalToken();`], { env, stdio: 'pipe', timeout: 30_000 });
    const written = readFileSync(TOK, 'utf8');
    expect(written).not.toBe('live-server-secret');
    expect(written).toMatch(/^[0-9a-f]{64}$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
