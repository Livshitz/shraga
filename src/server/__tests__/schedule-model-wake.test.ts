import { describe, test, expect } from 'bun:test';
import { isScheduledSession, SCHEDULED_SESSION_PREFIX } from '../scheduler/runner.ts';

/** Wake turns (polls, background-job report-back) in a scheduled run's own session must run as
 *  scheduled (→ scheduleModel); boot.ts's runTurn keys that off isScheduledSession. */
describe('isScheduledSession', () => {
  test('matches the ids runSchedule mints, nothing else', () => {
    expect(isScheduledSession(`${SCHEDULED_SESSION_PREFIX}daily-1760000000000`)).toBe(true);
    expect(isScheduledSession('sched-abc-123')).toBe(true);
    expect(isScheduledSession('chat-123')).toBe(false);
    expect(isScheduledSession('my-sched-1')).toBe(false);
  });
});
