// data/mcps/ must ship with the README that says what is actually read there.
//
// The gap this closes is not cosmetic: an operator encoded a real security intent into a
// `data/mcps/_global.json` that no loader has ever opened (globals come from shraga.config.ts),
// the edit was a silent no-op, and prod RTDB stayed writable. Seeding the explanation into every
// deployment is the cheapest inoculation.
import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const APP = path.resolve(import.meta.dirname, '..', '..', '..');
const roots: string[] = [];
afterAll(() => roots.forEach(r => rmSync(r, { recursive: true, force: true })));

test('seedDefaults() writes data/mcps/README.md, and re-seeds it when an operator deletes it', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'shraga-seed-'));
  roots.push(root);
  mkdirSync(path.join(root, 'data'), { recursive: true });
  const script = path.join(root, 'seed-run.ts');
  writeFileSync(script, `import { seedDefaults } from ${JSON.stringify(path.join(APP, 'src/server/seed.ts'))};\nseedDefaults();\n`);

  const readme = path.join(root, 'data', 'mcps', 'README.md');
  for (const round of ['fresh', 're-seed after deletion']) {
    const proc = Bun.spawn(['bun', 'run', script], {
      cwd: APP,
      env: { ...process.env, DATA_DIR: path.join(root, 'data') },
      stdout: 'ignore', stderr: 'pipe',
    });
    await proc.exited;
    expect(`${round}: ${existsSync(readme)}`).toBe(`${round}: true`);
    const text = readFileSync(readme, 'utf-8');
    // The two claims that were false-by-omission in the incident.
    expect(text).toContain('shraga.config.ts');
    expect(text).toContain('_global.json');
    rmSync(readme);
  }
});
