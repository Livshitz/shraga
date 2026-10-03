// Real git (bare remote + 2 clones), real DataSync, one child process per boot (DATA_DIR is a module constant).
// A path newly added to .gitignore (feedox 2026-10-03: workspace/.agent/) must leave the repo in ONE clean commit by the
// designated instance, and every other clone that pulls that untrack commit must keep the files on disk — before the
// fix the boot left 35 deletions half-staged (shrink guard unstaged only the big files) and a pulling clone lost them.
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('untracking a newly ignored path is clean, idempotent, and never deletes files on a pulling clone', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ds-untrack-'));
  const BARE = path.join(root, 'remote.git'), A = path.join(root, 'a'), B = path.join(root, 'b');
  const env = {
    ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  };
  const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env, stdio: 'pipe', encoding: 'utf8' }).trim();
  const memory = Array.from({ length: 80 }, (_, i) => `memory line ${i}`).join('\n') + '\n';
  // One boot of DataSync in `dir`: init() (+ optional pull()), then report the repo state.
  const boot = async (dir: string, writer: boolean, pull: boolean) => {
    const code = `
      const { DataSync } = await import(${JSON.stringify(path.join(import.meta.dir, '../data-sync.ts'))});
      const out = {};
      try {
        const ds = new DataSync({ repoUrl: process.env.BARE, branch: 'main', enabled: true, deploymentId: '', auditWriter: ${writer} });
        ds.askClaude = async () => 'msg';
        await ds.init();
        if (${pull}) await ds.pull();
      } catch (e) { out.error = String(e?.stack ?? e); }
      process.stdout.write('@@OUT@@' + JSON.stringify(out));
      process.exit(0);`;
    const kid = Bun.spawn(['bun', '-e', code], { env: { ...env, DATA_DIR: dir, BARE }, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr] = await Promise.all([new Response(kid.stdout).text(), new Response(kid.stderr).text()]);
    if (await kid.exited !== 0) throw new Error(`child failed:\n${stderr}`);
    const out = JSON.parse(stdout.split('@@OUT@@').at(-1)!);
    expect(out.error).toBeUndefined();
    git(dir, 'fetch', '-q', 'origin');
    return {
      staged: git(dir, 'diff', '--cached', '--name-only'),
      tracked: git(dir, 'ls-files', 'workspace/.agent'),
      ignored: (() => { try { return git(dir, 'check-ignore', 'workspace/.agent/memory/MEMORY.md'); } catch { return ''; } })(), // '' while still tracked
      onDisk: execFileSync('find', ['workspace/.agent', '-type', 'f'], { cwd: dir, encoding: 'utf8' }).split('\n').filter(Boolean).length,
      memory: execFileSync('cat', ['workspace/.agent/memory/MEMORY.md'], { cwd: dir, encoding: 'utf8' }),
      synced: git(dir, 'rev-parse', 'HEAD') === git(dir, 'rev-parse', 'origin/main'),
      head: git(dir, 'rev-parse', 'HEAD'),
    };
  };
  try {
    // Seed: 1 big memory file (trips the shrink guard when "deleted") + 34 small ones, all tracked.
    git(root, 'init', '-q', '--bare', '-b', 'main', BARE);
    git(root, 'clone', '-q', BARE, A);
    mkdirSync(path.join(A, 'workspace/.agent/memory'), { recursive: true });
    mkdirSync(path.join(A, 'workspace/.agent/notes'), { recursive: true });
    writeFileSync(path.join(A, 'workspace/.agent/memory/MEMORY.md'), memory);
    for (let i = 0; i < 34; i++) writeFileSync(path.join(A, `workspace/.agent/notes/n${i}.md`), `note ${i}\n`);
    writeFileSync(path.join(A, 'notes.md'), 'v1\n');
    git(A, 'add', '-A'); git(A, 'commit', '-qm', 'seed'); git(A, 'push', '-q', 'origin', 'main');
    await boot(A, true, false); // commits DataSync's own .gitignore baseline, so later boots only differ by the new rule
    git(root, 'clone', '-q', BARE, B);
    // Somebody commits the new ignore rule (feedox c1294982) — the files stay tracked until a DataSync boot untracks them.
    appendFileSync(path.join(A, '.gitignore'), 'workspace/.agent/\n');
    git(A, 'add', '.gitignore'); git(A, 'commit', '-qm', 'ignore .agent'); git(A, 'push', '-q', 'origin', 'main');

    // A non-designated clone never untracks: index stays clean, nothing staged, files stay tracked.
    const b0 = await boot(B, false, true);
    expect(b0.staged).toBe('');
    expect(b0.tracked).not.toBe('');
    expect(b0.synced).toBe(true);

    // The designated instance untracks in ONE clean commit, pushed, files kept on disk.
    const a1 = await boot(A, true, false);
    expect(a1).toMatchObject({ staged: '', tracked: '', ignored: 'workspace/.agent/memory/MEMORY.md', onDisk: 35, memory, synced: true });

    // B pulls the untrack commit and keeps every file on disk, untracked + ignored.
    const b1 = await boot(B, false, true);
    expect(b1).toMatchObject({ staged: '', tracked: '', ignored: 'workspace/.agent/memory/MEMORY.md', onDisk: 35, memory, synced: true, head: a1.head });

    // Repeated restarts are no-ops on both: clean index, no new commits.
    const a2 = await boot(A, true, true), b2 = await boot(B, false, true);
    expect(a2).toMatchObject({ staged: '', tracked: '', onDisk: 35, synced: true, head: a1.head });
    expect(b2).toMatchObject({ staged: '', tracked: '', onDisk: 35, synced: true, head: a1.head });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
