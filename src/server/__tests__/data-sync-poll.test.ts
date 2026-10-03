// Real git, real DataSync, child process with its own DATA_DIR. An idle non-writer clone (no local writes, no
// webhook — GitHub only reaches the box) must catch up with origin on its own within the poll interval.
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('an idle clone pulls a peer commit within the poll interval, with no local action', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ds-poll-'));
  const BARE = path.join(root, 'remote.git'), PEER = path.join(root, 'peer'), DATA = path.join(root, 'data');
  const env = {
    ...process.env, DATA_DIR: DATA, BARE, PEER, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  };
  const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env, stdio: 'pipe' });
  try {
    git(root, 'init', '-q', '--bare', '-b', 'main', BARE);
    git(root, 'init', '-q', '-b', 'main', PEER);
    writeFileSync(path.join(PEER, 'a.json'), '{}\n');
    git(PEER, 'add', '-A'); git(PEER, 'commit', '-qm', 'seed'); git(PEER, 'remote', 'add', 'origin', BARE); git(PEER, 'push', '-qu', 'origin', 'main');

    const code = `
      const { execFileSync } = await import('node:child_process');
      const { existsSync, writeFileSync } = await import('node:fs');
      const path = await import('node:path');
      const { DataSync } = await import(${JSON.stringify(path.join(import.meta.dir, '../data-sync.ts'))});
      const { PEER, DATA_DIR } = process.env;
      const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
      const out = {};
      try {
        const ds = new DataSync({ repoUrl: process.env.BARE, branch: 'main', enabled: true, deploymentId: '', pollMs: 300, notify: false, auditWriter: false });
        ds.askClaude = async () => 'sync';
        ds.notifyOwners = async () => {};
        await ds.init();
        await ds.syncOnBoot();
        out.bootHasA = existsSync(path.join(DATA_DIR, 'a.json'));

        git(PEER, 'pull', '-q'); // init may have pushed its .gitignore commit
        const before = git(DATA_DIR, 'rev-parse', 'HEAD');
        writeFileSync(path.join(PEER, 'b.json'), '{"peer":1}\\n');
        git(PEER, 'add', '-A'); git(PEER, 'commit', '-qm', 'peer'); git(PEER, 'push', '-q');
        const origin = git(PEER, 'rev-parse', 'HEAD');

        out.startedBehind = before !== origin;
        const t0 = Date.now();
        while (Date.now() - t0 < 5000 && git(DATA_DIR, 'rev-parse', 'HEAD') !== origin) await new Promise(r => setTimeout(r, 50));
        out.caughtUp = git(DATA_DIR, 'rev-parse', 'HEAD') === origin;
        out.hasB = existsSync(path.join(DATA_DIR, 'b.json'));
        ds.stopPolling?.();
      } catch (e) { out.err = String(e?.stack || e); }
      process.stdout.write('\\nRESULT' + JSON.stringify(out));
      process.exit(0);
    `;
    const stdout = execFileSync('bun', ['-e', code], { env, encoding: 'utf8', timeout: 60_000 });
    const res = JSON.parse(stdout.slice(stdout.lastIndexOf('RESULT') + 6));
    expect(res.err).toBeUndefined();
    expect(res.bootHasA).toBe(true);
    expect(res.startedBehind).toBe(true);
    expect(res.caughtUp).toBe(true);
    expect(res.hasB).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);
