// Real git, real DataSync, in a child process with its own DATA_DIR (paths.ts freezes DATA_DIR per process).
// The audit log is single-writer: committed + head-anchored on flush, left in place (never stashed) on pull — proven
// with the dir + month file append-only on macOS (uappnd ≈ chattr +a), where a stash of audit/ fails — and a remote
// commit that rewrites it is refused. security/ (policy.json) is never committed.
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('data-sync keeps the audit log single-writer and policy.json local', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ds-audit-'));
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
    git(PEER, 'add', '-A'); git(PEER, 'commit', '-qm', 'seed'); git(PEER, 'remote', 'add', 'origin', BARE); git(PEER, 'push', '-qu', 'origin', 'main');

    const code = `
      const { execFileSync } = await import('node:child_process');
      const { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } = await import('node:fs');
      const path = await import('node:path');
      const { DataSync } = await import(${JSON.stringify(path.join(import.meta.dir, '../data-sync.ts'))});
      const { Audit } = await import(${JSON.stringify(path.join(import.meta.dir, '../security/audit.ts'))});
      const { BARE, PEER, DATA_DIR } = process.env;
      const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
      const errors = []; console.error = (...a) => errors.push(a.join(' '));
      const peerCommit = (file) => { git(PEER, 'pull', '-q'); writeFileSync(path.join(PEER, file), 'peer\\n'); git(PEER, 'add', '-A'); git(PEER, 'commit', '-qm', file); git(PEER, 'push', '-q'); };
      const out = {};
      try {
      const ds = new DataSync({ repoUrl: BARE, branch: 'main', enabled: true, deploymentId: '' });
      ds.askClaude = async () => 'update notes';
      await ds.init();

      // A: flush commits the audit log with its head anchored; security/ stays local.
      const audit = new Audit({ log: { info() {}, warn() {}, error() {} } });
      audit.append({ type: 'auth.allow', principal: 'user:a' });
      const rec = audit.append({ type: 'turn.start', principal: 'user:a' });
      writeFileSync(path.join(DATA_DIR, 'notes.md'), 'v2\\n');
      mkdirSync(path.join(DATA_DIR, 'security'), { recursive: true });
      writeFileSync(path.join(DATA_DIR, 'security', 'policy.json'), '{}');
      writeFileSync(path.join(DATA_DIR, 'security', '.migrated'), '');
      ds.pending.add('notes.md');
      await ds.flush();
      out.ignored = git(DATA_DIR, 'check-ignore', 'security/policy.json', 'security/.migrated').split('\\n');
      out.a = { body: git(BARE, 'log', '-1', '--format=%B', 'main'), head: rec.hash, remote: git(BARE, 'ls-tree', '-r', '--name-only', 'main').split('\\n') };

      // B: pull while the audit log is dirty — and append-only on darwin, where stashing it would fail the pull.
      const auditDir = path.join(DATA_DIR, 'audit');
      const month = path.join(auditDir, readdirSync(auditDir).find(f => f.endsWith('.jsonl')));
      audit.append({ type: 'turn.end', principal: 'user:a' });
      writeFileSync(path.join(DATA_DIR, 'scratch.md'), 'local\\n');
      peerCommit('notes2.md');
      const flags = process.platform === 'darwin';
      if (flags) execFileSync('chflags', ['uappnd', auditDir, month]);
      const bAudit = readFileSync(month, 'utf8');
      try { await ds.pull(); } finally { if (flags) execFileSync('chflags', ['nouappnd', auditDir, month]); }
      out.b = { merged: existsSync(path.join(DATA_DIR, 'notes2.md')), auditSame: readFileSync(month, 'utf8') === bAudit,
        scratch: existsSync(path.join(DATA_DIR, 'scratch.md')), stash: git(DATA_DIR, 'stash', 'list'), flags };

      // C: a remote commit that rewrites the audit log is refused — nothing merges, the local log is untouched. The local
      // log is committed first (clean), so git itself wouldn't stop a fast-forward from rewriting it.
      writeFileSync(path.join(DATA_DIR, 'notes.md'), 'v3\\n');
      ds.pending.add('notes.md');
      await ds.flush();
      out.cClean = git(DATA_DIR, 'status', '--porcelain', '--', 'audit');
      git(PEER, 'pull', '-q');
      const peerMonth = path.join(PEER, 'audit', path.basename(month));
      writeFileSync(peerMonth, readFileSync(peerMonth, 'utf8').split('\\n')[0] + '\\n');
      writeFileSync(path.join(PEER, 'notes3.md'), 'peer\\n');
      git(PEER, 'add', '-A'); git(PEER, 'commit', '-qm', 'rewrite audit'); git(PEER, 'push', '-q');
      const cHead = git(DATA_DIR, 'rev-parse', 'HEAD'), cAudit = readFileSync(month, 'utf8');
      await ds.pull();
      out.c = { headSame: git(DATA_DIR, 'rev-parse', 'HEAD') === cHead, notes3: existsSync(path.join(DATA_DIR, 'notes3.md')),
        auditSame: readFileSync(month, 'utf8') === cAudit, refused: errors.some(e => e.includes('pull refused')) };
      } catch (e) { out.error = String(e?.stack ?? e); }
      out.errors = errors;
      process.stdout.write('@@OUT@@' + JSON.stringify(out));
      process.exit(0);`;
    const kid = Bun.spawn(['bun', '-e', code], { env, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr] = await Promise.all([new Response(kid.stdout).text(), new Response(kid.stderr).text()]);
    if (await kid.exited !== 0) throw new Error(`child failed:\n${stderr}`);
    const out = JSON.parse(stdout.split('@@OUT@@').at(-1)!);

    expect([out.a?.body, out.errors]).toEqual([expect.stringContaining('audit-head:'), expect.any(Array)]);
    expect(out.ignored).toEqual(['security/policy.json', 'security/.migrated']);
    expect(out.a.body).toContain(`audit-head: ${out.a.head}`);
    expect(out.a.remote.some((f: string) => /^audit\/\d{4}-\d{2}\.jsonl$/.test(f))).toBe(true);
    expect(out.a.remote.filter((f: string) => f.startsWith('security/'))).toEqual([]);
    expect(out.b).toEqual({ merged: true, auditSame: true, scratch: true, stash: '', flags: process.platform === 'darwin' });
    expect(out.error).toBeUndefined();
    expect(out.cClean).toBe('');
    expect(out.c).toEqual({ headSame: true, notes3: false, auditSame: true, refused: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
