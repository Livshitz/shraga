// A data repo that gitignores audit/ (agent-data: anchors only, in commit messages) must still flush and pull cleanly:
// staging an ignored audit/ failed every flush, and the pull's stash refused the ignored pathspec, so the box stopped pulling.
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('data-sync flushes and pulls when audit/ is gitignored', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ds-audit-ign-'));
  const BARE = path.join(root, 'remote.git'), PEER = path.join(root, 'peer'), DATA = path.join(root, 'data');
  const env = {
    ...process.env, DATA_DIR: DATA, BARE, PEER, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  };
  const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env, stdio: 'pipe' });
  try {
    git(root, 'init', '-q', '--bare', '-b', 'main', BARE);
    git(root, 'init', '-q', '-b', 'main', PEER);
    writeFileSync(path.join(PEER, 'notes.md'), 'v1\n');
    writeFileSync(path.join(PEER, '.gitignore'), 'audit/\n');
    git(PEER, 'add', '-A'); git(PEER, 'commit', '-qm', 'seed'); git(PEER, 'remote', 'add', 'origin', BARE); git(PEER, 'push', '-qu', 'origin', 'main');

    const code = `
      const { execFileSync } = await import('node:child_process');
      const { existsSync, writeFileSync } = await import('node:fs');
      const path = await import('node:path');
      const { DataSync } = await import(${JSON.stringify(path.join(import.meta.dir, '../data-sync.ts'))});
      const { Audit } = await import(${JSON.stringify(path.join(import.meta.dir, '../security/audit.ts'))});
      const { BARE, PEER, DATA_DIR } = process.env;
      const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
      const errors = []; console.error = console.warn = (...a) => errors.push(a.join(' '));
      const out = {};
      try {
        const ds = new DataSync({ repoUrl: BARE, branch: 'main', enabled: true, deploymentId: '', auditWriter: true });
        ds.askClaude = async () => 'update notes';
        await ds.init();
        const audit = new Audit({ log: { info() {}, warn() {}, error() {} } });
        audit.append({ type: 'auth.allow', principal: 'user:a' });
        writeFileSync(path.join(DATA_DIR, 'notes.md'), 'v2\\n');
        ds.pending.add('notes.md');
        await ds.flush();
        out.remote = git(BARE, 'ls-tree', '-r', '--name-only', 'main').split('\\n');

        // Dirty tracked file + a peer commit: the pull must stash and merge.
        audit.append({ type: 'turn.end', principal: 'user:a' });
        writeFileSync(path.join(DATA_DIR, 'notes.md'), 'v3\\n');
        git(PEER, 'pull', '-q'); writeFileSync(path.join(PEER, 'skill.md'), 'peer\\n');
        git(PEER, 'add', '-A'); git(PEER, 'commit', '-qm', 'skill'); git(PEER, 'push', '-q');
        await ds.pull();
        out.merged = existsSync(path.join(DATA_DIR, 'skill.md'));
        out.behind = git(DATA_DIR, 'rev-list', '--count', 'HEAD..origin/main');
      } catch (e) { out.error = String(e?.stack ?? e); }
      out.errors = errors;
      process.stdout.write('@@OUT@@' + JSON.stringify(out));
      process.exit(0);`;
    const kid = Bun.spawn(['bun', '-e', code], { env, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr] = await Promise.all([new Response(kid.stdout).text(), new Response(kid.stderr).text()]);
    if (await kid.exited !== 0) throw new Error(`child failed:\n${stderr}`);
    const out = JSON.parse(stdout.split('@@OUT@@').at(-1)!);

    expect(out.error).toBeUndefined();
    expect(out.errors.filter((e: string) => /audit log failed|Stash failed|ignored/.test(e))).toEqual([]);
    expect(out.remote.filter((f: string) => f.startsWith('audit/'))).toEqual([]);
    expect([out.merged, out.behind]).toEqual([true, '0']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
