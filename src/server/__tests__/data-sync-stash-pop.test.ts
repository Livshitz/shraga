// Real git, real DataSync, in a child process with its own DATA_DIR (paths.ts freezes DATA_DIR per process).
// Reproduces the 2026-09-23 feedox wedge: a local write and a peer commit touch the same file, the pre-pull
// stash fails to re-apply, and the worktree is left with conflict markers + an unmerged index. The markers then
// got committed and pushed, and every other commit failed silently. Also: a flush never commits a marked file.
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('a stash-pop conflict is repaired (local side kept, stash dropped) and markers are never committed', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ds-stash-'));
  const BARE = path.join(root, 'remote.git'), PEER = path.join(root, 'peer'), DATA = path.join(root, 'data');
  const env = {
    ...process.env, DATA_DIR: DATA, BARE, PEER, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  };
  const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env, stdio: 'pipe' });
  try {
    git(root, 'init', '-q', '--bare', '-b', 'main', BARE);
    git(root, 'init', '-q', '-b', 'main', PEER);
    writeFileSync(path.join(PEER, 'links.json'), '{\n  "at": 1\n}\n');
    writeFileSync(path.join(PEER, 'other.json'), '{}\n');
    git(PEER, 'add', '-A'); git(PEER, 'commit', '-qm', 'seed'); git(PEER, 'remote', 'add', 'origin', BARE); git(PEER, 'push', '-qu', 'origin', 'main');

    const code = `
      const { execFileSync } = await import('node:child_process');
      const { existsSync, readFileSync, writeFileSync } = await import('node:fs');
      const path = await import('node:path');
      const { DataSync } = await import(${JSON.stringify(path.join(import.meta.dir, '../data-sync.ts'))});
      const { BARE, PEER, DATA_DIR } = process.env;
      const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
      const errors = []; console.error = (...a) => errors.push(a.join(' '));
      const out = {};
      try {
        const ds = new DataSync({ repoUrl: BARE, branch: 'main', enabled: true, deploymentId: '' });
        ds.askClaude = async () => 'sync';
        ds.notifyOwners = async () => {};
        await ds.init();

        // Local (unflushed) write + untracked file, and a peer commit to the same line.
        writeFileSync(path.join(DATA_DIR, 'links.json'), '{\\n  "at": 2\\n}\\n');
        writeFileSync(path.join(DATA_DIR, 'fresh.json'), '{"new":true}\\n');
        git(PEER, 'pull', '-q'); writeFileSync(path.join(PEER, 'links.json'), '{\\n  "at": 3\\n}\\n');
        git(PEER, 'add', '-A'); git(PEER, 'commit', '-qm', 'peer'); git(PEER, 'push', '-q');

        await ds.pull();
        out.pull = {
          links: readFileSync(path.join(DATA_DIR, 'links.json'), 'utf8'),
          unmerged: git(DATA_DIR, 'diff', '--name-only', '--diff-filter=U'),
          stash: git(DATA_DIR, 'stash', 'list'),
          fresh: existsSync(path.join(DATA_DIR, 'fresh.json')),
          logged: errors.some(e => e.includes('Stash pop')),
        };

        ds.pending.add('links.json');
        await ds.flush();
        out.pushedLinks = git(BARE, 'show', 'main:links.json');

        // A marked file handed to flush is unstaged, not committed; the rest of the flush still syncs.
        writeFileSync(path.join(DATA_DIR, 'other.json'), '{\\n<<<<<<< Updated upstream\\n"a":1\\n=======\\n"a":2\\n>>>>>>> Stashed changes\\n}\\n');
        writeFileSync(path.join(DATA_DIR, 'links.json'), '{\\n  "at": 4\\n}\\n');
        ds.pending.add('other.json'); ds.pending.add('links.json');
        await ds.flush();
        out.guard = {
          pushedOther: git(BARE, 'show', 'main:other.json'),
          pushedLinks: git(BARE, 'show', 'main:links.json'),
          logged: errors.some(e => e.includes('Conflict markers staged')),
        };
      } catch (e) { out.err = String(e?.stack || e); }
      process.stdout.write('\\nRESULT' + JSON.stringify(out));
    `;
    const stdout = execFileSync('bun', ['-e', code], { env, encoding: 'utf8', timeout: 60_000 });
    const res = JSON.parse(stdout.slice(stdout.lastIndexOf('RESULT') + 6));
    expect(res.err).toBeUndefined();
    expect(res.pull.links).toBe('{\n  "at": 2\n}\n');
    expect(res.pull.unmerged).toBe('');
    expect(res.pull.stash).toBe('');
    expect(res.pull.fresh).toBe(true);
    expect(res.pull.logged).toBe(true);
    expect(res.pushedLinks).toBe('{\n  "at": 2\n}');
    expect(res.guard.pushedOther).toBe('{}');
    expect(res.guard.pushedLinks).toBe('{\n  "at": 4\n}');
    expect(res.guard.logged).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);
