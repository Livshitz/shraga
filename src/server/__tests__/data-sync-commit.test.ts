import { describe, expect, test } from 'bun:test';
import { DataSync, extractCommitSubject, fallbackCommitMessage, withTimeout } from '../data-sync.ts';

describe('extractCommitSubject', () => {
  test('fence-only reply yields nothing (prod commit 1f6c20a was literally "```")', () => {
    expect(extractCommitSubject('```')).toBe('');
    expect(extractCommitSubject('```\n```')).toBe('');
    expect(extractCommitSubject('```text\n\n```')).toBe('');
  });

  test('empty / whitespace reply yields nothing', () => {
    expect(extractCommitSubject('')).toBe('');
    expect(extractCommitSubject('   \n\n ')).toBe('');
  });

  test('prose reply is rejected, not truncated', () => {
    expect(extractCommitSubject('Looking at this diff, the change updates the agent config to add a new rule.')).toBe('');
    expect(extractCommitSubject("Here's a commit message for you:\n\nupdate rules")).toBe('');
    expect(extractCommitSubject('Commit message:')).toBe('');
    expect(extractCommitSubject('x'.repeat(200))).toBe('');
  });

  test('pulls the subject out of a fenced / decorated reply', () => {
    expect(extractCommitSubject('```\nadd geo targeting rule\n```')).toBe('add geo targeting rule');
    expect(extractCommitSubject('`add geo targeting rule`')).toBe('add geo targeting rule');
    expect(extractCommitSubject('- add geo targeting rule')).toBe('add geo targeting rule');
    expect(extractCommitSubject('"add geo targeting rule"')).toBe('add geo targeting rule');
    expect(extractCommitSubject('add geo targeting rule')).toBe('add geo targeting rule');
  });

  test('bounds the subject to 72 chars', () => {
    const long = 'update ' + 'a'.repeat(200);
    expect(extractCommitSubject(long)).toBe('');            // paragraph-length -> fallback
    const sub = 'update ' + 'a'.repeat(80);
    expect(extractCommitSubject(sub).length).toBeLessThanOrEqual(72);
  });
});

describe('fallbackCommitMessage', () => {
  test('is deterministic and bounded', () => {
    expect(fallbackCommitMessage(['CLAUDE.md'])).toBe('sync: CLAUDE.md');
    expect(fallbackCommitMessage([])).toBe('sync: update agent data');
    const many = Array.from({ length: 20 }, (_, i) => `skills/some-long-skill-name-${i}.md`);
    const msg = fallbackCommitMessage(many);
    expect(msg.length).toBeLessThanOrEqual(72);
    expect(msg).toContain('+19 more');
  });
});

describe('withTimeout', () => {
  test('rejects a promise that never settles', async () => {
    await expect(withTimeout(new Promise(() => {}), 20, 'hang')).rejects.toThrow(/timed out/);
  });
});

/** Drive the real flush() with git + the LLM call stubbed. */
function harness(opts: { askClaude: () => Promise<string>; failOn?: string }) {
  const ds: any = new DataSync({ repoUrl: 'x', branch: 'main', enabled: true } as any);
  const calls: string[][] = [];
  ds.git = async (...args: string[]) => {
    calls.push(args);
    if (opts.failOn && args[0] === opts.failOn) throw new Error(`boom in git ${args[0]}`);
    if (args[0] === 'status') return ' M CLAUDE.md\n';
    if (args[0] === 'diff' && args.includes('--stat')) return ' CLAUDE.md | 2 +-\n';
    if (args[0] === 'diff') return '--- a/CLAUDE.md\n+++ b/CLAUDE.md\n+rule\n';
    if (args[0] === 'rev-list') return '1\n';
    return '';
  };
  ds.askClaude = opts.askClaude;
  ds.guardMassDeletions = async () => false;
  ds.rebuildLog = async () => [];
  ds.pending.add('CLAUDE.md');
  return { ds, calls };
}

describe('flush() releases the push latch', () => {
  test('when an inner await REJECTS', async () => {
    const { ds } = harness({ askClaude: async () => 'ok', failOn: 'status' });
    await expect(ds.flush()).resolves.toBeUndefined();
    expect(ds.pushing).toBe(false);
  });

  test('when the LLM call HANGS — degrades to the deterministic fallback', async () => {
    process.env.DATA_SYNC_COMMIT_MSG_TIMEOUT_MS = '30';
    try {
      const { ds, calls } = harness({ askClaude: () => new Promise<string>(() => {}) });
      await ds.flush();
      expect(ds.pushing).toBe(false);
      const commit = calls.find(c => c[0] === 'commit')!;
      expect(commit[2]).toBe('sync: CLAUDE.md');
    } finally {
      delete process.env.DATA_SYNC_COMMIT_MSG_TIMEOUT_MS;
    }
  });

  test('a fence-only model reply never reaches git commit -m verbatim', async () => {
    const { ds, calls } = harness({ askClaude: async () => '```\n```' });
    await ds.flush();
    const commit = calls.find(c => c[0] === 'commit')!;
    expect(commit[2]).toBe('sync: CLAUDE.md');
    expect(ds.pushing).toBe(false);
  });

  test('so the NEXT flush proceeds instead of early-returning forever', async () => {
    const { ds, calls } = harness({ askClaude: async () => 'add a rule' });
    await ds.flush();
    ds.pending.add('CLAUDE.md');
    await ds.flush();
    expect(calls.filter(c => c[0] === 'commit').length).toBe(2);
  });
});
