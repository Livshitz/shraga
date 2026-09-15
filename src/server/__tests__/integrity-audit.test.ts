import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { audit, findBaselineRef } from '../integrity-audit.ts';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function git(dir: string, ...args: string[]): string {
  const r = Bun.spawnSync(['git', '-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args]);
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
}

function repo(): { dir: string; write: (f: string, c: string | Uint8Array) => void; commit: (msg?: string) => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'integrity-audit-'));
  dirs.push(dir);
  git(dir, 'init', '-q');
  return {
    dir,
    write: (f, c) => { mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); writeFileSync(path.join(dir, f), c); },
    commit: (msg = 'auto: sync') => { git(dir, 'add', '-A'); git(dir, 'commit', '-qm', msg, '--allow-empty'); },
  };
}

describe('audit', () => {
  test('reports missing, truncated, degraded and invalid-json for changed files', async () => {
    const r = repo();
    r.write('gone.md', 'bye');
    r.write('renamed.md', 'moving');
    r.write('big.md', 'x'.repeat(1000));
    r.write('contacts.json', JSON.stringify(Array.from({ length: 10 }, (_, i) => i)));
    r.commit();
    rmSync(path.join(r.dir, 'gone.md'));
    rmSync(path.join(r.dir, 'renamed.md'));
    r.write('moved.md', 'moving');
    r.write('big.md', 'x'.repeat(100));
    r.write('contacts.json', '[1,2]');
    r.write('broken.json', '{ nope');
    r.commit();

    const issues = await audit('HEAD~1', r.dir);
    expect(issues).toEqual([
      { file: 'big.md', kind: 'truncated', detail: '1000B → 100B (10%)' },
      { file: 'contacts.json', kind: 'degraded', detail: '10 → 2 entries' },
      { file: 'gone.md', kind: 'missing', detail: 'in reference but not HEAD' },
      { file: 'renamed.md', kind: 'missing', detail: 'in reference but not HEAD' },
      { file: 'broken.json', kind: 'invalid-json', detail: 'parse error' },
    ]);
  });

  test('unchanged files are not examined — a pre-existing invalid json is not re-reported', async () => {
    const r = repo();
    r.write('old-broken.json', '{ nope');
    r.write('a.md', 'a');
    r.commit();
    r.write('a.md', 'b');
    r.commit();
    expect(await audit('HEAD~1', r.dir)).toEqual([]);
  });

  test('a small shrink within the slack is not an issue', async () => {
    const r = repo();
    r.write('contacts.json', '[1,2,3,4]');
    r.commit();
    r.write('contacts.json', '[1,2]');
    r.commit();
    expect(await audit('HEAD~1', r.dir)).toEqual([]);
  });

  test('an unknown ref rejects (caller logs "skipped") instead of throwing synchronously', async () => {
    const r = repo();
    r.write('a.md', 'a');
    r.commit();
    const p = audit('HEAD~1', r.dir);
    expect(p).toBeInstanceOf(Promise);
    await expect(p).rejects.toThrow(/git diff failed/);
  });

  test('is proportional and never blocks the event loop on a large repo', async () => {
    const r = repo();
    for (let i = 0; i < 3000; i++) r.write(`notes/n${i}.md`, `note ${i}\n${'0'.repeat(300)}`);
    for (let i = 0; i < 200; i++) r.write(`json/j${i}.json`, `{"id":${i}}`);
    r.write('contacts.json', JSON.stringify(Array.from({ length: 50 }, (_, i) => i)));
    r.commit();
    r.write('contacts.json', '[1,2]');
    r.commit();

    const spawn = spyOn(Bun, 'spawn');
    let maxGap = 0;
    let last = performance.now();
    const hb = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now; }, 5);
    try {
      const issues = await audit('HEAD~1', r.dir);
      maxGap = Math.max(maxGap, performance.now() - last);
      expect(issues).toEqual([{ file: 'contacts.json', kind: 'degraded', detail: '50 → 2 entries' }]);
      expect(spawn).toHaveBeenCalledTimes(3); // diff + batch-check + one cat-file --batch, independent of the 3201 files
      expect(maxGap).toBeLessThan(250);
    } finally {
      clearInterval(hb);
      spawn.mockRestore();
    }
  });

  test('large changed binaries are size-checked in bytes but never read into memory', async () => {
    const r = repo();
    const bin = new Uint8Array(4 * 1024 * 1024).fill(0xff);
    r.write('media.bin', bin);
    r.write('contacts.json', '[1,2,3]');
    r.commit();
    r.write('media.bin', bin.subarray(0, 1024));
    r.write('contacts.json', '[1,2,3,4]');
    r.commit();
    const binShas = [git(r.dir, 'rev-parse', 'HEAD~1:media.bin'), git(r.dir, 'rev-parse', 'HEAD:media.bin')];

    const spawn = spyOn(Bun, 'spawn');
    try {
      const issues = await audit('HEAD~1', r.dir);
      expect(issues).toEqual([{ file: 'media.bin', kind: 'truncated', detail: '4194304B → 1024B (0%)' }]);
      const inputs = await Promise.all(spawn.mock.calls.map(async ([cmd, opts]) => ({
        args: (cmd as string[]).join(' '),
        stdin: (opts as { stdin?: unknown })?.stdin instanceof Blob ? await ((opts as { stdin: Blob }).stdin).text() : '',
      })));
      const batch = inputs.find(i => i.args.endsWith('cat-file --batch'));
      expect(batch).toBeDefined();
      for (const sha of binShas) expect(batch!.stdin).not.toContain(sha);
      expect(inputs.find(i => i.args.endsWith('--batch-check'))!.stdin).toContain(binShas[0]);
    } finally {
      spawn.mockRestore();
    }
  });

  test('a .json over the size cap is skipped with a warning, never silently', async () => {
    const r = repo();
    r.write('raw.json', '[]');
    r.commit();
    r.write('raw.json', `[${'1,'.repeat(9 * 1024 * 1024)}1]`); // ~18MB > 16MB cap
    r.commit();
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await audit('HEAD~1', r.dir)).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('skipped raw.json');
    } finally {
      warn.mockRestore();
    }
  });

  test('a data dir that is a subfolder of the repo is scoped to it, with dir-relative paths', async () => {
    const r = repo();
    r.write('src.ts', 'x'.repeat(1000));
    r.write('data/contacts.json', JSON.stringify([1, 2, 3, 4, 5, 6]));
    r.commit();
    r.write('src.ts', 'x');
    r.write('data/contacts.json', '[1]');
    r.commit();
    expect(await audit('HEAD~1', path.join(r.dir, 'data'))).toEqual([
      { file: 'contacts.json', kind: 'degraded', detail: '6 → 1 entries' },
    ]);
  });
});

describe('findBaselineRef', () => {
  test('picks the latest "auto: sync" commit, else HEAD~1', async () => {
    const r = repo();
    r.write('a.md', 'a');
    r.commit('auto: sync one');
    const sync = git(r.dir, 'rev-parse', 'HEAD');
    r.write('a.md', 'b');
    r.commit('manual edit');
    expect(await findBaselineRef(r.dir)).toBe(sync);

    const bare = repo();
    expect(await findBaselineRef(bare.dir)).toBe('HEAD~1');
  });
});
