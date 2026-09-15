import { describe, test, expect } from 'bun:test';
import {
  decideClaudeTurn, buildContextDelta, buildResumePrompt, sectionHashes, shortHash, isResumeEnabled,
  conversationSummaryKey, unseenMessages, MAX_UNSEEN_CHARS, sectionsAfterSubmit, isResumeFailure, speakerKey,
  type ClaudeResumeState, type TurnDecisionInput,
} from '../engine/claude-resume.ts';
import { parseDirectives } from '../directives.ts';
import type { ConvMessage } from '../sessions.ts';

// DATA_DIR comes from the shared preload (bunfig.toml -> setup.ts).
const sessions = await import('../sessions.ts');

const msg = (id: string, role: ConvMessage['role'], text: string, extra: Partial<ConvMessage> = {}): ConvMessage =>
  ({ id, role, blocks: [{ type: 'text', text }], ...extra });

// Turn 1 started with [u1]; turn 2 now starts with [u1, a1, u2] — the normal, resumable shape.
const conv2 = [msg('u1', 'user', 'remember PELICAN-42'), msg('a1', 'assistant', 'noted'), msg('u2', 'user', 'what was it?')];
const state: ClaudeResumeState = {
  claudeSessionId: 'cc-1', configDirHash: 'dir-a', speaker: 'spk-a', startedAt: 1, markId: 'u1', summaryKey: '', sections: {},
};
const input = (over: Partial<TurnDecisionInput> = {}): TurnDecisionInput => ({
  enabled: true, state, conversation: conv2, configDirHash: 'dir-a', speaker: 'spk-a', hasTranscript: () => true, ...over,
});

describe('decideClaudeTurn', () => {
  test('flag off → fresh (today\'s path, no reason)', () => {
    expect(decideClaudeTurn(input({ enabled: false })).path).toBe('fresh');
  });

  test('all facts match → resume, with nothing unseen', () => {
    expect(decideClaudeTurn(input())).toEqual({ path: 'resume', unseen: [] });
  });

  test('no stored session → fallback:no-session', () => {
    expect(decideClaudeTurn(input({ state: undefined })).path).toBe('fallback:no-session');
  });

  test('another engine ran a turn → fallback:engine-switch', () => {
    expect(decideClaudeTurn(input({ state: { ...state, interruptedBy: 'cursor' } })).path).toBe('fallback:engine-switch');
  });

  test('a different speaker than the stored session\'s → fallback:speaker-change (privacy)', () => {
    expect(decideClaudeTurn(input({ speaker: 'spk-b' })).path).toBe('fallback:speaker-change');
    // A state saved before speakers were recorded is never assumed to be this speaker's.
    const { speaker: _s, ...legacy } = state;
    expect(decideClaudeTurn(input({ state: legacy as ClaudeResumeState })).path).toBe('fallback:speaker-change');
  });

  test('speakerKey: stable per uid+email (case-insensitive email), differs across people, no raw email', () => {
    expect(speakerKey('u1', 'A@x.test')).toBe(speakerKey('u1', 'a@x.test '));
    expect(speakerKey('u1', 'a@x.test')).not.toBe(speakerKey('u2', 'b@x.test'));
    expect(speakerKey('u1', 'a@x.test')).not.toContain('@');
  });

  test('a CLI process still alive on this session (steer takeover) → fallback:concurrent-run', () => {
    expect(decideClaudeTurn(input({ cliAlive: true })).path).toBe('fallback:concurrent-run');
  });

  test('config/account dir changed → fallback:account-change', () => {
    expect(decideClaudeTurn(input({ configDirHash: 'dir-b' })).path).toBe('fallback:account-change');
  });

  test('conversation replayed/edited → fallback:reset', () => {
    expect(decideClaudeTurn(input({ conversationReset: true })).path).toBe('fallback:reset');
  });

  test('a shraga summary written after the session started → fallback:summary', () => {
    const summary: ConvMessage = { id: 's', role: 'assistant', blocks: [{ type: 'summary', text: 'x', compactedCount: 20 }] };
    expect(decideClaudeTurn(input({ conversation: [summary, ...conv2] })).path).toBe('fallback:summary');
    // ...and a state saved AFTER that summary resumes.
    expect(decideClaudeTurn(input({ conversation: [summary, ...conv2], state: { ...state, summaryKey: 'summary:20' } })).path).toBe('resume');
  });

  test('a /compact marker (synthetic leading message) also counts as a summary', () => {
    const marker = msg('compact-summary', 'assistant', '<conversation_summary>\nold\n</conversation_summary>');
    expect(conversationSummaryKey([marker, ...conv2])).toMatch(/^marker:/);
    expect(decideClaudeTurn(input({ conversation: [marker, ...conv2] })).path).toBe('fallback:summary');
  });

  test('mark message gone (history rewritten) → fallback:history-diverged', () => {
    expect(decideClaudeTurn(input({ conversation: conv2.slice(1) })).path).toBe('fallback:history-diverged');
    expect(decideClaudeTurn(input({ state: { ...state, markId: undefined } })).path).toBe('fallback:history-diverged');
  });

  test('too much unseen out-of-band text → fallback:drift', () => {
    const big = msg('ctx', 'user', 'x'.repeat(MAX_UNSEEN_CHARS + 1));
    const conv = [conv2[0], conv2[1], big, conv2[2]];
    expect(decideClaudeTurn(input({ conversation: conv })).path).toBe('fallback:drift');
  });

  test('transcript deleted (CLI cleanup / moved dir) → fallback:transcript-missing', () => {
    expect(decideClaudeTurn(input({ hasTranscript: () => false })).path).toBe('fallback:transcript-missing');
  });

  test('out-of-band messages between turns are resumed WITH them, not dropped', () => {
    const ctx: ConvMessage = { id: 'c', role: 'user', blocks: [{ type: 'context', label: 'Slack reply coordinates', text: 'thread 123' }] };
    const peer = msg('p', 'user', '[Dana]: also check the invoice');
    const d = decideClaudeTurn(input({ conversation: [conv2[0], conv2[1], peer, ctx, conv2[2]] }));
    expect(d.path).toBe('resume');
    expect(d.unseen.map((m) => m.id)).toEqual(['p', 'c']);
  });
});

describe('unseenMessages', () => {
  test('drops the previous reply (first, assistant) and this turn\'s prompt (last, user)', () => {
    expect(unseenMessages(conv2, 'u1')).toEqual([]);
  });
  test('an ephemeral turn (prompt not persisted) keeps nothing extra', () => {
    expect(unseenMessages(conv2.slice(0, 2), 'u1')).toEqual([]);
  });
});

describe('buildContextDelta', () => {
  const sections = { user: '<current_user>elya</current_user>', skillIndex: '<available-skills>a</available-skills>', workspace: '<workspace>t1</workspace>' };
  const prev = sectionHashes(sections);

  test('nothing changed → only the current speaker\'s user section (re-sent on EVERY resume turn)', () => {
    const delta = buildContextDelta(prev, sections);
    expect(delta).toContain('<section name="user">\n<current_user>elya</current_user>\n</section>');
    expect(delta).not.toContain('available-skills');
    expect(delta).not.toContain('<workspace>');
    const { user: _u, ...noUser } = sections;
    expect(buildContextDelta(sectionHashes(noUser), noUser)).toBe('');
  });

  test('sends only the changed section and a newly triggered skill, in full', () => {
    const next = { ...sections, 'skill:debug': '<skill name="debug">steps</skill>', workspace: '<workspace>t1\nt2</workspace>' };
    const delta = buildContextDelta(prev, next);
    expect(delta).toContain('<section name="workspace">\n<workspace>t1\nt2</workspace>\n</section>');
    expect(delta).toContain('<section name="skill:debug">');
    expect(delta).not.toContain('available-skills');
  });

  test('a section that no longer applies is named, not re-sent', () => {
    const { workspace: _w, ...rest } = sections;
    expect(buildContextDelta(prev, rest)).toContain('No longer applicable: workspace');
  });

  test('hashes skip empty sections and are stable', () => {
    expect(sectionHashes({ a: 'x', b: '' })).toEqual({ a: shortHash('x') });
  });
});

describe('sectionsAfterSubmit (a cancelled turn may or may not have reached the transcript)', () => {
  test('unchanged sections keep their hash; changed, new and removed ones are marked unknown so the next turn re-sends them', () => {
    const prev = sectionHashes({ user: 'A-member', workspace: 'w1', roster: 'r' });
    const next = sectionHashes({ user: 'A-owner', workspace: 'w1', 'skill:x': 's' });
    const after = sectionsAfterSubmit(prev, next);
    expect(after.workspace).toBe(prev.workspace);
    // Reverting to turn-1 content must still produce a delta (the transcript may hold the cancelled version).
    expect(buildContextDelta(after, { user: 'A-member', workspace: 'w1', roster: 'r' })).toContain('<section name="roster">');
    expect(buildContextDelta(after, { user: 'A-member', workspace: 'w1', roster: 'r' })).toContain('No longer applicable: skill:x');
    expect(buildContextDelta(after, { user: 'A-member', workspace: 'w1', roster: 'r' })).not.toContain('<section name="workspace">');
  });
});

describe('isResumeFailure', () => {
  test('resume/transcript errors retry fresh; quota, auth and API errors do not', () => {
    expect(isResumeFailure('No conversation found with session ID: 00000000-0000-4000-8000-000000000000')).toBe(true);
    expect(isResumeFailure('Claude Code returned an error result: No conversation found with session ID: x')).toBe(true);
    expect(isResumeFailure("You've hit your limit · resets 2pm (UTC)")).toBe(false);
    expect(isResumeFailure('api_error_status=429')).toBe(false);
    expect(isResumeFailure('Invalid API key · Please run /login')).toBe(false);
    expect(isResumeFailure('Claude Code process exited with code 1')).toBe(false);
  });
});

describe('buildResumePrompt', () => {
  test('user text FIRST, then unseen messages, then the context delta', () => {
    const p = buildResumePrompt('what was it?', [msg('p', 'user', '[Dana]: hi')], '<context_update>\nx\n</context_update>');
    expect(p.startsWith('what was it?\n\n<messages_since_last_turn>')).toBe(true);
    expect(p.indexOf('User: [Dana]: hi')).toBeLessThan(p.indexOf('<context_update>'));
  });
  test('nothing extra → exactly the user text', () => {
    expect(buildResumePrompt('hello', [], '')).toBe('hello');
  });
});

describe('resume flag', () => {
  test('directive wins over config; default off', () => {
    expect(isResumeEnabled({}, {})).toBe(false);
    expect(isResumeEnabled({}, { sdkResume: true })).toBe(true);
    expect(isResumeEnabled({ resume: false }, { sdkResume: true })).toBe(false);
    expect(isResumeEnabled({ resume: true }, {})).toBe(true);
    // PUT /api/sessions/:id/directives stores passthrough values opaquely.
    expect(isResumeEnabled({ resume: 'on' as unknown as boolean }, {})).toBe(true);
  });

  test('[resume:on|off] parses as a directive and is stripped from the prompt', () => {
    expect(parseDirectives('[resume:on] hi')).toMatchObject({ prompt: 'hi', directives: { resume: true } });
    expect(parseDirectives('[opus, resume:off] hi')).toMatchObject({ prompt: 'hi', directives: { resume: false } });
  });
});

describe('setClaudeResume', () => {
  test('stores, patches (engine-switch marker) and clears the mapping', () => {
    sessions.upsertSession('resume-s1', 'hi', { uid: 'u', email: 'e@x.test' });
    sessions.setClaudeResume('resume-s1', undefined, { interruptedBy: 'cursor' }); // patch without state = no-op
    expect(sessions.getSession('resume-s1')?.claudeResume).toBeUndefined();
    sessions.setClaudeResume('resume-s1', state);
    sessions.setClaudeResume('resume-s1', undefined, { interruptedBy: 'cursor' });
    expect(sessions.getSession('resume-s1')?.claudeResume).toEqual({ ...state, interruptedBy: 'cursor' });
    sessions.setClaudeResume('resume-s1', undefined);
    expect(sessions.getSession('resume-s1')?.claudeResume).toBeUndefined();
  });
});
