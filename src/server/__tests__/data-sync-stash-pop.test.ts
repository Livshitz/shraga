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

// 2026-10-02 feedox: only a nested repo was dirty (` m gh-work/x`), so the status check said dirty but `stash push`
// saved nothing (exit 0) — and the pop re-applied a weeks-old stash, wedging the index on 1949 paths.
test('a pull whose stash push saves nothing never pops an older stash', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ds-stale-'));
  const BARE = path.join(root, 'remote.git'), PEER = path.join(root, 'peer'), DATA = path.join(root, 'data');
  const env = {
    ...process.env, DATA_DIR: DATA, BARE, PEER, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  };
  const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env, stdio: 'pipe' });
  try {
    git(root, 'init', '-q', '--bare', '-b', 'main', BARE);
    git(root, 'init', '-q', '-b', 'main', PEER);
    writeFileSync(path.join(PEER, 'links.json'), '{"at":1}\n');
    git(PEER, 'add', '-A'); git(PEER, 'commit', '-qm', 'seed'); git(PEER, 'remote', 'add', 'origin', BARE); git(PEER, 'push', '-qu', 'origin', 'main');

    const code = `
      const { execFileSync } = await import('node:child_process');
      const { mkdirSync, readFileSync, writeFileSync } = await import('node:fs');
      const path = await import('node:path');
      const { DataSync } = await import(${JSON.stringify(path.join(import.meta.dir, '../data-sync.ts'))});
      const { BARE, PEER, DATA_DIR } = process.env;
      const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
      console.error = () => {};
      const out = {};
      try {
        const ds = new DataSync({ repoUrl: BARE, branch: 'main', enabled: true, deploymentId: '' });
        ds.askClaude = async () => 'sync';
        ds.notifyOwners = async () => {};
        await ds.init();

        // A stale stash left behind from an earlier failed pop.
        writeFileSync(path.join(DATA_DIR, 'links.json'), '{"at":"stale"}\\n');
        git(DATA_DIR, 'stash', 'push', '-m', 'data-sync: pre-pull stash');
        // A committed nested repo whose own worktree is dirty: status shows it, stash cannot save it.
        const sub = path.join(DATA_DIR, 'gh-work', 'x'); mkdirSync(sub, { recursive: true });
        git(sub, 'init', '-q', '-b', 'main'); writeFileSync(path.join(sub, 'f'), 'a\\n'); git(sub, 'add', 'f'); git(sub, 'commit', '-qm', 's');
        git(DATA_DIR, 'add', 'gh-work/x'); git(DATA_DIR, 'commit', '-qm', 'nested'); git(DATA_DIR, 'push', '-q', 'origin', 'main');
        writeFileSync(path.join(sub, 'f'), 'dirty\\n');

        git(PEER, 'pull', '-q'); writeFileSync(path.join(PEER, 'links.json'), '{"at":3}\\n');
        git(PEER, 'add', '-A'); git(PEER, 'commit', '-qm', 'peer'); git(PEER, 'push', '-q');

        await ds.pull();
        out.links = readFileSync(path.join(DATA_DIR, 'links.json'), 'utf8');
        out.unmerged = git(DATA_DIR, 'diff', '--name-only', '--diff-filter=U');
        out.stashes = git(DATA_DIR, 'stash', 'list').split('\\n').filter(Boolean).length;
      } catch (e) { out.err = String(e?.stack || e); }
      process.stdout.write('\\nRESULT' + JSON.stringify(out));
    `;
    const stdout = execFileSync('bun', ['-e', code], { env, encoding: 'utf8', timeout: 60_000 });
    const res = JSON.parse(stdout.slice(stdout.lastIndexOf('RESULT') + 6));
    expect(res.err).toBeUndefined();
    expect(res.links).toBe('{"at":3}\n');
    expect(res.unmerged).toBe('');
    expect(res.stashes).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);

// 2026-10-02 23:28 feedox: workspace/socials.kanban was untracked; the pre-pull `stash push --include-untracked` took it
// off disk, an editor saved an empty board in its place during the pull, the pop refused ("already exists") and the
// stash — the only copy — was dropped because the path existed. Same loss when a peer adds a path a local untracked
// file already holds. An untracked file must survive any pull.
test('a pull never loses an untracked file (rewritten mid-pull, or colliding with a path the peer adds)', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ds-untracked-'));
  const BARE = path.join(root, 'remote.git'), PEER = path.join(root, 'peer'), DATA = path.join(root, 'data');
  const env = {
    ...process.env, DATA_DIR: DATA, BARE, PEER, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  };
  const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env, stdio: 'pipe' });
  try {
    git(root, 'init', '-q', '--bare', '-b', 'main', BARE);
    git(root, 'init', '-q', '-b', 'main', PEER);
    writeFileSync(path.join(PEER, 'links.json'), '{"at":1}\n');
    git(PEER, 'add', '-A'); git(PEER, 'commit', '-qm', 'seed'); git(PEER, 'remote', 'add', 'origin', BARE); git(PEER, 'push', '-qu', 'origin', 'main');

    const code = `
      const { execFileSync } = await import('node:child_process');
      const { existsSync, mkdirSync, readFileSync, writeFileSync } = await import('node:fs');
      const path = await import('node:path');
      const { DataSync } = await import(${JSON.stringify(path.join(import.meta.dir, '../data-sync.ts'))});
      const { BARE, PEER, DATA_DIR } = process.env;
      const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
      console.error = () => {};
      const out = {};
      try {
        const ds = new DataSync({ repoUrl: BARE, branch: 'main', enabled: true, deploymentId: '' });
        ds.askClaude = async () => 'sync';
        ds.notifyOwners = async () => {};
        await ds.init();

        const board = path.join(DATA_DIR, 'workspace', 'socials.kanban');
        mkdirSync(path.dirname(board), { recursive: true });
        writeFileSync(board, 'REAL BOARD\\n');
        writeFileSync(path.join(DATA_DIR, 'clash.json'), '{"mine":true}\\n');
        writeFileSync(path.join(DATA_DIR, 'links.json'), '{"at":"local"}\\n');
        // An editor that recreates its file (empty) whenever it finds it missing — what Bare did with the board.
        const realGit = ds.git.bind(ds);
        ds.git = async (...a) => {
          const r = await realGit(...a);
          if (a[0] === 'merge' && !existsSync(board)) { mkdirSync(path.dirname(board), { recursive: true }); writeFileSync(board, ''); }
          return r;
        };

        git(PEER, 'pull', '-q');
        writeFileSync(path.join(PEER, 'clash.json'), '{"peer":true}\\n');
        writeFileSync(path.join(PEER, 'peer.json'), '{}\\n');
        git(PEER, 'add', '-A'); git(PEER, 'commit', '-qm', 'peer'); git(PEER, 'push', '-q');

        await ds.pull();
        out.board = readFileSync(board, 'utf8');
        out.clash = readFileSync(path.join(DATA_DIR, 'clash.json'), 'utf8');
        out.links = readFileSync(path.join(DATA_DIR, 'links.json'), 'utf8');
        out.pulled = existsSync(path.join(DATA_DIR, 'peer.json'));
        out.unmerged = git(DATA_DIR, 'diff', '--name-only', '--diff-filter=U');
      } catch (e) { out.err = String(e?.stack || e); }
      process.stdout.write('\\nRESULT' + JSON.stringify(out));
    `;
    const stdout = execFileSync('bun', ['-e', code], { env, encoding: 'utf8', timeout: 60_000 });
    const res = JSON.parse(stdout.slice(stdout.lastIndexOf('RESULT') + 6));
    expect(res.err).toBeUndefined();
    expect(res.board).toBe('REAL BOARD\n');
    expect(res.clash).toBe('{"mine":true}\n');
    expect(res.links).toBe('{"at":"local"}\n');
    expect(res.pulled).toBe(true);
    expect(res.unmerged).toBe('');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);

/** Bare remote + peer clone seeded with links.json + old.json; runs `body` (JS, with ds/git/write/read/PEER/DATA_DIR/out/alerts in scope) in a child. */
function runScenario(body: string): Record<string, any> {
  const root = mkdtempSync(path.join(tmpdir(), 'ds-scen-'));
  const BARE = path.join(root, 'remote.git'), PEER = path.join(root, 'peer'), DATA = path.join(root, 'data');
  const env = {
    ...process.env, DATA_DIR: DATA, BARE, PEER, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  };
  const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env, stdio: 'pipe' });
  try {
    git(root, 'init', '-q', '--bare', '-b', 'main', BARE);
    git(root, 'init', '-q', '-b', 'main', PEER);
    writeFileSync(path.join(PEER, 'links.json'), '{"at":1}\n');
    writeFileSync(path.join(PEER, 'old.json'), 'old content line\nmore\n');
    git(PEER, 'add', '-A'); git(PEER, 'commit', '-qm', 'seed'); git(PEER, 'remote', 'add', 'origin', BARE); git(PEER, 'push', '-qu', 'origin', 'main');
    const code = `
      const { execFileSync } = await import('node:child_process');
      const { existsSync, readFileSync, writeFileSync } = await import('node:fs');
      const path = await import('node:path');
      const { DataSync } = await import(${JSON.stringify(path.join(import.meta.dir, '../data-sync.ts'))});
      const { BARE, PEER, DATA_DIR } = process.env;
      const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
      const write = (f, s) => writeFileSync(path.join(DATA_DIR, f), s);
      const read = f => existsSync(path.join(DATA_DIR, f)) ? readFileSync(path.join(DATA_DIR, f), 'utf8') : null;
      console.error = () => {}; console.warn = () => {};
      const out = {}, alerts = [];
      try {
        const ds = new DataSync({ repoUrl: BARE, branch: 'main', enabled: true, deploymentId: '' });
        ds.askClaude = async () => 'sync';
        ds.notifyOwners = async t => { alerts.push(t); };
        await ds.init();
        git(PEER, 'pull', '-q');
        ${body}
      } catch (e) { out.err = String(e?.stack || e); }
      process.stdout.write('\\nRESULT' + JSON.stringify(out));
    `;
    const stdout = execFileSync('bun', ['-e', code], { env, encoding: 'utf8', timeout: 60_000 });
    return JSON.parse(stdout.slice(stdout.lastIndexOf('RESULT') + 6));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const peerCommit = `git(PEER, 'add', '-A'); git(PEER, 'commit', '-qm', 'peer'); git(PEER, 'push', '-q');`;

// A local untracked file colliding with a path the peer adds is force-staged to ride the stash. When the merge
// aborts, the pop restored it STAGED and the next flush committed + pushed a file this instance never tracked.
test('a colliding untracked file stays untracked (never pushed) when the merge aborts', () => {
  const res = runScenario(`
    write('clash.json', 'MINE\\n');
    writeFileSync(path.join(PEER, 'clash.json'), 'peer\\n'); ${peerCommit}
    const real = ds.git.bind(ds);
    ds.git = async (...a) => { if (a[0] === 'merge' && a[1] !== '--abort') throw new Error('simulated merge failure'); return real(...a); };
    await ds.pull();
    ds.git = real;
    out.clash = read('clash.json');
    out.status = git(DATA_DIR, 'status', '--porcelain', '--', 'clash.json');
    const pre = git(DATA_DIR, 'rev-parse', 'HEAD');
    write('links.json', 'flushed\\n'); ds.pending.add('links.json'); await ds.flush();
    const flushCommit = git(DATA_DIR, 'rev-list', '--reverse', '--first-parent', pre + '..HEAD').split('\\n')[0];
    out.committed = git(DATA_DIR, 'show', '--name-only', '--format=', flushCommit);
  `);
  expect(res.err).toBeUndefined();
  expect(res.clash).toBe('MINE\n');
  expect(res.status).toBe('?? clash.json');
  expect(res.committed).toBe('links.json');
});

// `diff --diff-filter=A` with rename detection reports a remote rename as R, so a local untracked file at the
// rename target was never staged and the merge refused forever ("Merge failed for unknown reason").
test('a path the remote introduces by rename does not wedge the pull', () => {
  const res = runScenario(`
    write('x.json', 'MINE\\n');
    git(PEER, 'mv', 'old.json', 'x.json'); ${peerCommit}
    await ds.pull();
    out.merged = git(DATA_DIR, 'rev-parse', 'HEAD') === git(DATA_DIR, 'rev-parse', 'origin/main');
    out.x = read('x.json');
  `);
  expect(res.err).toBeUndefined();
  expect(res.merged).toBe(true);
  expect(res.x).toBe('MINE\n');
});

// A writer saving a stashed tracked file mid-pull makes `stash pop` refuse ("would be overwritten") with no
// conflicts — the stash was then dropped and the unflushed edit lost.
test('a refused stash pop keeps the stash and alerts', () => {
  const res = runScenario(`
    write('links.json', 'LOCAL UNFLUSHED EDIT\\n');
    writeFileSync(path.join(PEER, 'peer.json'), '{}\\n'); ${peerCommit}
    const real = ds.git.bind(ds);
    ds.git = async (...a) => { const r = await real(...a); if (a[0] === 'merge') write('links.json', ''); return r; };
    await ds.pull();
    out.stash = git(DATA_DIR, 'stash', 'list') ? git(DATA_DIR, 'show', 'stash@{0}:links.json') : '';
    out.alerted = alerts.some(a => a.includes('stash kept'));
  `);
  expect(res.err).toBeUndefined();
  expect(res.stash).toBe('LOCAL UNFLUSHED EDIT');
  expect(res.alerted).toBe(true);
});

test('a colliding untracked file stays untracked when the stash push fails (pull skipped)', () => {
  const res = runScenario(`
    write('clash.json', 'MINE\\n'); write('links.json', 'dirty\\n');
    writeFileSync(path.join(PEER, 'clash.json'), 'peer\\n'); ${peerCommit}
    const real = ds.git.bind(ds);
    ds.git = async (...a) => { if (a[0] === 'stash' && a[1] === 'push') throw new Error('simulated stash failure'); return real(...a); };
    await ds.pull();
    out.status = git(DATA_DIR, 'status', '--porcelain', '--', 'clash.json');
  `);
  expect(res.err).toBeUndefined();
  expect(res.status).toBe('?? clash.json');
});

// A local untracked path that blocks the merge without being an added name (untracked `a/b` vs remote file `a`):
// git refuses, the pull aborts every cycle and local flushes never reach the remote — it must alert, naming the path.
test('a merge refused by a blocking untracked path alerts once with the path, and never touches it', () => {
  const res = runScenario(`
    require('node:fs').mkdirSync(path.join(DATA_DIR, 'a'), { recursive: true }); write('a/b', 'MINE\\n');
    writeFileSync(path.join(PEER, 'a'), 'peer\\n'); ${peerCommit}
    await ds.pull(); await ds.pull();
    out.merged = git(DATA_DIR, 'rev-parse', 'HEAD') === git(DATA_DIR, 'rev-parse', 'origin/main');
    out.ab = read('a/b');
    out.alerts = alerts.filter(a => a.includes('pull is blocked'));
  `);
  expect(res.err).toBeUndefined();
  expect(res.merged).toBe(false);
  expect(res.ab).toBe('MINE\n');
  expect(res.alerts.length).toBe(1);
  expect(res.alerts[0]).toContain('a/b');
});
