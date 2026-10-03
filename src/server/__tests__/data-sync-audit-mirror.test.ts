// Real git, real DataSync, child process with its own DATA_DIR. A syncing instance that is NOT the audit writer (a dev
// laptop on the shared data repo) must keep pulling although every writer commit touches audit/, take the writer's
// audit/ over its own stale local lines, and never push audit/.
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('a non-writer data-sync mirrors the remote audit log and never pushes its own', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ds-audit-mirror-'));
  const BARE = path.join(root, 'remote.git'), PEER = path.join(root, 'peer'), DATA = path.join(root, 'data');
  const env = {
    ...process.env, DATA_DIR: DATA, BARE, PEER, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  };
  const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env, stdio: 'pipe' });
  try {
    git(root, 'init', '-q', '--bare', '-b', 'main', BARE);
    git(root, 'init', '-q', '-b', 'main', PEER);
    execFileSync('mkdir', ['-p', path.join(PEER, 'audit')]);
    writeFileSync(path.join(PEER, 'audit', '2026-10.jsonl'), 'w1\n');
    writeFileSync(path.join(PEER, 'notes.md'), 'v1\n');
    git(PEER, 'add', '-A'); git(PEER, 'commit', '-qm', 'seed'); git(PEER, 'remote', 'add', 'origin', BARE); git(PEER, 'push', '-qu', 'origin', 'main');

    const code = `
      const { execFileSync } = await import('node:child_process');
      const { appendFileSync, existsSync, readFileSync, writeFileSync } = await import('node:fs');
      const path = await import('node:path');
      const { DataSync } = await import(${JSON.stringify(path.join(import.meta.dir, '../data-sync.ts'))});
      const { BARE, PEER, DATA_DIR } = process.env;
      const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
      const errors = []; console.error = (...a) => errors.push(a.join(' '));
      const month = path.join(DATA_DIR, 'audit', '2026-10.jsonl');
      // The writer (peer) commits audit lines with every change, as the box does.
      const writer = (file, line) => { git(PEER, 'pull', '-q'); appendFileSync(path.join(PEER, 'audit', '2026-10.jsonl'), line + '\\n'); writeFileSync(path.join(PEER, file), 'peer\\n'); git(PEER, 'add', '-A'); git(PEER, 'commit', '-qm', file); git(PEER, 'push', '-q'); };
      const out = {};
      try {
      const ds = new DataSync({ repoUrl: BARE, branch: 'main', enabled: true, deploymentId: '', auditWriter: false });
      ds.askClaude = async () => 'update notes';
      await ds.init();

      // A: a writer commit touching audit/ is pulled (not refused) even with stale local audit lines in the worktree.
      appendFileSync(month, 'mirror-local\\n');
      writer('n2.md', 'w2');
      await ds.pull();
      out.a = { merged: existsSync(path.join(DATA_DIR, 'n2.md')), audit: readFileSync(month, 'utf8'), synced: git(DATA_DIR, 'rev-parse', 'HEAD') === git(BARE, 'rev-parse', 'main') };

      // B: a mirror flush pushes its data but never audit/.
      appendFileSync(month, 'mirror-local2\\n');
      writeFileSync(path.join(DATA_DIR, 'notes.md'), 'mirror\\n');
      ds.pending.add('notes.md'); ds.pending.add('audit/2026-10.jsonl');
      await ds.flush();
      out.b = { notes: git(BARE, 'show', 'main:notes.md'), audit: git(BARE, 'show', 'main:audit/2026-10.jsonl'), body: git(BARE, 'log', '-1', '--format=%B', 'main') };

      // C: a mirror audit commit left unpushed by a pre-fix build conflicts with the writer's — the writer's chain wins.
      git(DATA_DIR, 'checkout', '-q', '--', 'audit');
      appendFileSync(month, 'mirror-committed\\n');
      git(DATA_DIR, 'commit', '-qam', 'legacy mirror audit');
      writer('n3.md', 'w3');
      await ds.pull();
      out.c = { merged: existsSync(path.join(DATA_DIR, 'n3.md')), audit: readFileSync(month, 'utf8'), unmerged: git(DATA_DIR, 'diff', '--name-only', '--diff-filter=U') };
      } catch (e) { out.error = String(e?.stack ?? e); }
      out.refused = errors.filter(e => e.includes('pull refused'));
      process.stdout.write('@@OUT@@' + JSON.stringify(out));
      process.exit(0);`;
    const kid = Bun.spawn(['bun', '-e', code], { env, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr] = await Promise.all([new Response(kid.stdout).text(), new Response(kid.stderr).text()]);
    if (await kid.exited !== 0) throw new Error(`child failed:\n${stderr}`);
    const out = JSON.parse(stdout.split('@@OUT@@').at(-1)!);

    expect(out.error).toBeUndefined();
    expect(out.refused).toEqual([]);
    expect(out.a).toEqual({ merged: true, audit: 'w1\nw2\n', synced: true });
    expect(out.b.notes).toBe('mirror');
    expect(out.b.audit).toBe('w1\nw2');
    expect(out.b.body).not.toContain('audit-head:');
    expect(out.c).toEqual({ merged: true, audit: 'w1\nw2\nw3\n', unmerged: '' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
