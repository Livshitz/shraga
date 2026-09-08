import { describe, test, expect, afterEach } from 'bun:test';
import { getSessionUrl, getPublicOrigin } from '../shraga-config.ts';
import { backfillScope, ensureBuiltinSchedules, FAILURE_NOTIFIER_SCHEDULE_ID, SYSTEM_UID } from '../scheduler/builtins.ts';
import type { Schedule } from '../scheduler/types.ts';

const ORIGINAL_ORIGIN = process.env.PUBLIC_ORIGIN;
afterEach(() => {
  if (ORIGINAL_ORIGIN === undefined) delete process.env.PUBLIC_ORIGIN;
  else process.env.PUBLIC_ORIGIN = ORIGINAL_ORIGIN;
});

describe('session URL resolution', () => {
  test('builds an absolute link when a public origin is configured', () => {
    process.env.PUBLIC_ORIGIN = 'https://agent.example.com';
    expect(getSessionUrl('abc-123')).toBe('https://agent.example.com/?session=abc-123');
  });

  test('tolerates a trailing slash rather than emitting a double slash', () => {
    process.env.PUBLIC_ORIGIN = 'https://agent.example.com/';
    expect(getPublicOrigin()).toBe('https://agent.example.com');
    expect(getSessionUrl('abc-123')).toBe('https://agent.example.com/?session=abc-123');
  });

  test('omits the link entirely when unconfigured — never a localhost fallback', () => {
    delete process.env.PUBLIC_ORIGIN;
    expect(getSessionUrl('abc-123')).toBeUndefined();
  });

  test('omits the link when the run produced no session', () => {
    process.env.PUBLIC_ORIGIN = 'https://agent.example.com';
    expect(getSessionUrl(undefined)).toBeUndefined();
  });
});

/** The reconcile trap: a deployment that already persisted the schedule keeps its stored
 *  task.prompt across upgrades, so editing the shipped default alone reaches nobody. */
describe('already-persisted failure-notifier schedule', () => {
  const persistedWithLegacyPrompt = (): Schedule => ({
    id: FAILURE_NOTIFIER_SCHEDULE_ID,
    name: 'Scheduled-job failure notifier',
    enabled: true,
    trigger: { kind: 'event', source: 'schedule.finished', match: { status: 'error' } },
    task: { kind: 'prompt', prompt: 'NOTIFY — send one alert.\n  *Session:* <deployment URL>/?session=<sessionId>\nDo NOT try to fix the job yourself.' },
    scope: 'system',
    createdBy: { uid: SYSTEM_UID, email: 'system@shraga.local' },
    createdAt: 1,
    updatedAt: 1,
    runCount: 7,
  }) as Schedule;

  test('reconcile alone does NOT rewrite a stored prompt (documents why the payload fix is needed)', () => {
    const schedules = [persistedWithLegacyPrompt()];
    ensureBuiltinSchedules(schedules);
    // Proves the trap is real: the shipped default never lands on an existing deployment.
    expect((schedules[0].task as { prompt: string }).prompt).toContain('<deployment URL>');
  });

  test('backfill heals the stale Session line in place', () => {
    const schedules = [persistedWithLegacyPrompt()];
    backfillScope(schedules);
    const prompt = (schedules[0].task as { prompt: string }).prompt;
    expect(prompt).not.toContain('<deployment URL>');
    expect(prompt).toContain('sessionUrl');
    // Surrounding deployment customisations survive — only the one line changed.
    expect(prompt).toContain('NOTIFY — send one alert.');
    expect(prompt).toContain('Do NOT try to fix the job yourself.');
  });

  /** The stale line is rewritten in place, so anything a deployment wrote around it is data we
   *  are one `saveSchedules` away from destroying for good. */
  test('preserves an inline annotation written after the placeholder', () => {
    const s = persistedWithLegacyPrompt();
    (s.task as { prompt: string }).prompt =
      'NOTIFY — send one alert.\n  *Session:* <deployment URL>/?session=<sessionId>   <-- OUR NOTE: page oncall too\nDo NOT try to fix the job yourself.';
    backfillScope([s]);
    const prompt = (s.task as { prompt: string }).prompt;
    expect(prompt).not.toContain('<deployment URL>');
    expect(prompt).toContain('<-- OUR NOTE: page oncall too');
  });

  test('heals every occurrence, not just the first', () => {
    const s = persistedWithLegacyPrompt();
    (s.task as { prompt: string }).prompt =
      'NOTIFY — send one alert.\n  *Session:* <deployment URL>/?session=<sessionId>\nAlso in the digest:\n  *Session:* <deployment URL>/?session=<sessionId>\nDo NOT try to fix the job yourself.';
    backfillScope([s]);
    const prompt = (s.task as { prompt: string }).prompt;
    expect(prompt).not.toContain('<deployment URL>');
    expect(prompt.match(/sessionUrl/g)?.length).toBe(2);
    expect(prompt).toContain('Also in the digest:');
  });

  test('does not fabricate a Session line a deployment deliberately deleted', () => {
    const s = persistedWithLegacyPrompt();
    const without = 'NOTIFY — send one alert.\nDo NOT try to fix the job yourself.';
    (s.task as { prompt: string }).prompt = without;
    backfillScope([s]);
    expect((s.task as { prompt: string }).prompt).toBe(without);
  });

  test('heal is idempotent and leaves an already-good prompt alone', () => {
    const schedules = [persistedWithLegacyPrompt()];
    backfillScope(schedules);
    const once = (schedules[0].task as { prompt: string }).prompt;
    backfillScope(schedules);
    expect((schedules[0].task as { prompt: string }).prompt).toBe(once);
  });
});

/** The failure notifier must not inherit the global agent-config engine: an optional engine can fail
 *  to register on a boot (add-on absent, missing key), which is exactly the class of failure this job
 *  exists to report. Live data had `model: "composer-2.5"` and NO engine — an incoherent half-pin that
 *  ran on whatever the ambient config was, and billed Anthropic for a Cursor model id. */
describe('failure-notifier engine pin', () => {
  const stored = (task: Record<string, unknown>): Schedule => ({
    id: FAILURE_NOTIFIER_SCHEDULE_ID,
    name: 'Scheduled-job failure notifier',
    enabled: true,
    trigger: { kind: 'event', source: 'schedule.finished', match: { status: 'error' } },
    task,
    scope: 'system',
    createdBy: { uid: SYSTEM_UID, email: 'system@shraga.local' },
    createdAt: 1,
    updatedAt: 1,
    runCount: 7,
  }) as unknown as Schedule;

  test('the shipped builtin pins no engine — it follows agent config like every other schedule', () => {
    // The pin was shipped on a premise since disproved by the box's own logs: nothing was ever
    // misrouted, the deployment was simply globally on claude-code then and on agentx now. Hard-coding
    // that stale state also made the alarm the second casualty of the real failure mode (an org cap
    // on the pinned provider).
    const schedules = ensureBuiltinSchedules([]);
    const notifier = schedules.find((s) => s.id === FAILURE_NOTIFIER_SCHEDULE_ID)!;
    const task = notifier.task as { prompt: string; engine?: string; model?: string };
    expect(task.engine).toBeUndefined();
    expect(task.model).toBeUndefined();
    expect(task.prompt.startsWith('[')).toBe(false); // no synthesized runtime directive either
  });

  test("the reverted reconcile's own stamp is undone, not folded into a directive", () => {
    // Exactly the state on the live box: this id, engine claude-code, no model — written by the
    // reconcile clause being reverted, never by an operator. Folding it would perpetuate the pin.
    const schedules = [stored({ kind: 'prompt', prompt: 'custom prompt', engine: 'claude-code' })];
    backfillScope(schedules);
    const task = schedules[0].task as { prompt: string; engine?: string };
    expect(task.engine).toBeUndefined();
    expect(task.prompt).toBe('custom prompt'); // no directive either — it follows agent config now
  });

  test('a stored legacy pin becomes the prompt directive — the selection survives, visibly', () => {
    const schedules = [stored({ kind: 'prompt', prompt: 'custom prompt', model: 'composer-2.5' })];
    backfillScope(schedules);
    ensureBuiltinSchedules(schedules);
    const task = schedules[0].task as { prompt: string; engine?: string; model?: string };
    expect(task.model).toBeUndefined();
    expect(task.engine).toBeUndefined();
    // Byte-identical to what runner.ts used to synthesize onto the prompt — behaviour unchanged.
    expect(task.prompt).toBe('[model:composer-2.5] custom prompt');
  });

  test('an explicit stored pair folds into one directive group', () => {
    const schedules = [stored({ kind: 'prompt', prompt: 'p', engine: 'agentx', model: 'cursor/composer-2.5' })];
    backfillScope(schedules);
    const task = schedules[0].task as { prompt: string; engine?: string; model?: string };
    expect(task.prompt).toBe('[engine:agentx,model:cursor/composer-2.5] p');
    expect(task.engine).toBeUndefined();
    expect(task.model).toBeUndefined();
  });

});
