// Real git, real DataSync, in a child process with its own DATA_DIR (paths.ts freezes DATA_DIR per process).
// Reproduces the 2026-10-02 feedox alert: a merge left a committed node_modules tree unmerged, and the
// "not committing: unmerged paths" alert listed every file in it. Gitignored conflicts are now untracked
// (kept on disk), and the alert caps its file list.
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listFiles } from '../data-sync.ts';

test('listFiles caps a long list with a count', () => {
  expect(listFiles(['a', 'b'])).toBe('a, b');
  expect(listFiles(Array.from({ length: 13 }, (_, i) => `f${i}`))).toBe('f0, f1, f2, f3, f4, f5, f6, f7, f8, f9 … +3 more');
});

test('conflicted gitignored paths are untracked, not reported; the alert lists at most 10 files', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ds-unmerged-'));
  const BARE = path.join(root, 'remote.git'), DATA = path.join(root, 'data');
  const env = {
    ...process.env, DATA_DIR: DATA, BARE, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  };
  try {
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', BARE], { env });
    const code = `
      const { execFileSync } = await import('node:child_process');
      const { existsSync, mkdirSync, readFileSync, writeFileSync } = await import('node:fs');
      const path = await import('node:path');
      const { DataSync } = await import(${JSON.stringify(path.join(import.meta.dir, '../data-sync.ts'))});
      const { BARE, DATA_DIR } = process.env;
      const git = (...a) => { try { return execFileSync('git', a, { cwd: DATA_DIR, encoding: 'utf8', stdio: 'pipe' }).trim(); } catch (e) { return String(e.stdout || ''); } };
      const w = (f, s) => { mkdirSync(path.dirname(path.join(DATA_DIR, f)), { recursive: true }); writeFileSync(path.join(DATA_DIR, f), s); };
      console.error = () => {};
      const alerts = [];
      const out = {};
      try {
        const ds = new DataSync({ repoUrl: BARE, branch: 'main', enabled: true, deploymentId: '' });
        ds.askClaude = async () => 'sync';
        ds.notifyOwners = async (t) => { alerts.push(String(t)); };
        await ds.init();
        w('.gitignore', readFileSync(path.join(DATA_DIR, '.gitignore'), 'utf8') + 'node_modules/\\n'); git('add', '.gitignore'); git('commit', '-qm', 'ignore node_modules');
        // Both sides of a merge change the same files, including a tree committed before it was ignored.
        const nm = Array.from({ length: 30 }, (_, i) => 'skills/x/node_modules/pkg/f' + i + '.js');
        const data = Array.from({ length: 12 }, (_, i) => 'd' + i + '.json');
        const all = [...nm, ...data];
        all.forEach(f => w(f, 'base\\n')); git('add', '-f', ...all); git('commit', '-qm', 'base');
        git('checkout', '-qb', 'side'); all.forEach(f => w(f, 'side\\n')); git('add', '-f', ...all); git('commit', '-qm', 'side');
        git('checkout', '-q', 'main'); all.forEach(f => w(f, 'main\\n')); git('add', '-f', ...all); git('commit', '-qm', 'main');
        git('merge', 'side');
        out.before = git('diff', '--name-only', '--diff-filter=U').split('\\n').filter(Boolean).length;
        out.blocked = await ds.guardConflictMarkers();
        const left = git('diff', '--name-only', '--diff-filter=U').split('\\n').filter(Boolean);
        out.left = left;
        out.nmTracked = git('ls-files', 'skills/x/node_modules');
        out.nmOnDisk = existsSync(path.join(DATA_DIR, nm[0]));
        out.alert = alerts.find(a => a.includes('unmerged paths')) || '';
      } catch (e) { out.err = String(e?.stack || e); }
      process.stdout.write('\\nRESULT' + JSON.stringify(out));
    `;
    const stdout = execFileSync('bun', ['-e', code], { env, encoding: 'utf8', timeout: 60_000 });
    const res = JSON.parse(stdout.slice(stdout.lastIndexOf('RESULT') + 6));
    expect(res.err).toBeUndefined();
    expect(res.before).toBe(42);
    expect(res.blocked).toBe(true);                       // the real data conflicts still block the commit
    expect(res.left.sort()).toEqual(Array.from({ length: 12 }, (_, i) => `d${i}.json`).sort());
    expect(res.nmTracked).toBe('');                       // the ignored tree left the index…
    expect(res.nmOnDisk).toBe(true);                      // …but stays on disk
    expect(res.alert).toContain('+2 more');
    expect(res.alert).not.toContain('node_modules');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);
