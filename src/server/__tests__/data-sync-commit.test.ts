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

  test('72-120 char prose goes to the fallback instead of being truncated mid-word', () => {
    // Real fuzzed model output: 79 chars, no preamble word. Used to emit "...so ad".
    const prose = 'The change adds a new geographic targeting rule to the config file so ads work.';
    expect(prose.length).toBeGreaterThan(72);
    expect(extractCommitSubject(prose)).toBe('');
  });

  test('a legitimate subject that merely starts with a common word survives', () => {
    expect(extractCommitSubject('the diff view now renders inline')).toBe('the diff view now renders inline');
    expect(extractCommitSubject('this change is scoped to the geo rule')).toBe('this change is scoped to the geo rule');
  });

  test('strips a numbered-list prefix', () => {
    expect(extractCommitSubject('1. add geo targeting rule')).toBe('add geo targeting rule');
    expect(extractCommitSubject('2) add geo targeting rule')).toBe('add geo targeting rule');
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
function harness(opts: { askClaude: (p?: string, m?: string, ac?: AbortController) => Promise<string>; failOn?: string; status?: string }) {
  const ds: any = new DataSync({ repoUrl: 'x', branch: 'main', enabled: true } as any);
  const calls: string[][] = [];
  ds.git = async (...args: string[]) => {
    calls.push(args);
    if (opts.failOn && args[0] === opts.failOn) throw new Error(`boom in git ${args[0]}`);
    if (args[0] === 'status') return opts.status ?? ' M CLAUDE.md\n';
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
  // Guards the `finally`: this path leaves flush() through a BARE `return` inside the try,
  // so without `finally` the latch stays true forever and sync wedges silently.
  test('when git reports NO CHANGES (bare early-return inside the try)', async () => {
    const { ds, calls } = harness({ askClaude: async () => 'ok', status: '' });
    await ds.flush();
    expect(calls.some(c => c[0] === 'commit')).toBe(false);   // really took the early-return path
    expect(ds.pushing).toBe(false);
  });

  test('when nothing is ahead of origin (the other bare early-return)', async () => {
    const { ds } = harness({ askClaude: async () => 'add a rule' });
    ds.git = (((orig) => async (...args: string[]) => (args[0] === 'rev-list' ? '0\n' : orig(...args)))(ds.git)) as any;
    await ds.flush();
    expect(ds.pushing).toBe(false);
  });

  // NOTE: no 'inner await REJECTS' test — the pre-fix code released the latch on rejection too
  // (`catch { ... } this.pushing = false;`), so such a test passes against the bug. Deleted rather
  // than kept: a test that passes both ways is worse than no test.
  test('the LLM call is ABORTED on timeout, not just abandoned', async () => {
    process.env.DATA_SYNC_COMMIT_MSG_TIMEOUT_MS = '30';
    try {
      let seen: AbortController | undefined;
      const { ds } = harness({ askClaude: (_p, _m, ac) => { seen = ac; return new Promise<string>(() => {}); } });
      await ds.flush();
      expect(seen).toBeInstanceOf(AbortController);
      expect(seen!.signal.aborted).toBe(true);
    } finally {
      delete process.env.DATA_SYNC_COMMIT_MSG_TIMEOUT_MS;
    }
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
