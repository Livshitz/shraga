import { describe, test, expect, beforeAll } from 'bun:test';
import { registerPoll, handlePollClose, initPolls, loadPoll } from '../polls.ts';
import { upsertSession, loadConversation } from '../sessions.ts';

// A closing poll persists `status:'closed'` and re-renders Slack BEFORE it wakes the session. So if
// the wake cannot run a turn — no runner wired, or the session is still busy past the wake lock's
// bounded wait — the tally has nowhere left to go: the poll is closed, the transcript holds a
// `[Poll result]` prompt with no answer, and the record is pruned after 7 days. The lines are
// already built at that point, so they must be delivered as plain text instead of dropped.

const SID = 'poll-fallback-session';
let turnRuns = 0;

beforeAll(() => {
  upsertSession(SID, 'poll fallback', { uid: 'u1', email: 'u1@example.com' });
  // The 'no-output' shape: a wake that could not run a turn (exactly what boot.ts's runTurn returns
  // when the session stays locked past WAKE_LOCK_WAIT_MS).
  initPolls({ broadcast: () => {}, runTurn: async () => { turnRuns++; return []; } });
});

describe('poll close when the wake cannot run a turn', () => {
  test('the tally is delivered as plain text instead of being lost', async () => {
    registerPoll({
      pollId: 'p-fallback-1', channel: 'C1', ts: '1.1', title: 'Ship it?',
      options: [{ label: 'yes' }, { label: 'no' }], kind: 'poll',
      sessionId: SID, uid: 'u1', userEmail: 'u1@example.com',
    });
    await handlePollClose('p-fallback-1');

    expect(turnRuns).toBe(1);                       // the wake was attempted
    expect(loadPoll('p-fallback-1')?.status).toBe('closed');

    const msgs = loadConversation(SID);
    const textOf = (role: string) => msgs.filter((m) => m.role === role)
      .flatMap((m) => m.blocks).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
    // wake.ts appends the trigger as a USER message before running the turn, and that prompt already
    // quotes the title AND the tally lines — so asserting on the transcript as a whole proves
    // nothing (it passes with the fix removed). The delivery is an ASSISTANT message; assert there.
    expect(textOf('user')).toContain('[Poll result]');
    const answer = textOf('assistant');
    expect(answer).toContain('Ship it?');
    expect(answer).toMatch(/yes: 0 votes/);
  });
});
