import { describe, test, expect, beforeAll, afterAll, beforeEach, mock } from 'bun:test';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Schedule, ScheduleRunSummary } from '../scheduler/types.ts';

// A completed one-off schedule is DELETED from schedules.json by the engine. schedules.json is a
// whole-file JSON array in a git repo that a bot and humans both write, so a conflicting rebase —
// or data-sync's own LLM conflict resolver, which is instructed to "always keep both (union
// merge)" — can put a deleted entry BACK. Twice on 2026-08-16 that resurrected an enabled
// `kind: "once"` Mailchimp campaign send in shraga-circles. This suite pins what may and may not
// re-arm after such a resurrection. Same stubbed-runner harness as scheduler-run-lock.test.ts.
const realRunner = { ...(await import('../scheduler/runner.ts')) };
let stubActive = false;
let started: string[] = [];

mock.module('../scheduler/runner.ts', () => ({
  ...realRunner,
  async runSchedule(
    schedule: Schedule,
    _onEvent: (ev: object) => void,
    registerRun: (sid: string, ac: AbortController) => void,
    ...rest: unknown[]
  ): Promise<ScheduleRunSummary> {
    if (!stubActive) return realRunner.runSchedule(schedule, _onEvent, registerRun, ...(rest as []));
    const sessionId = `stub-${schedule.id}-${started.length}`;
    started.push(schedule.id);
    registerRun(sessionId, new AbortController());
    await new Promise((r) => setTimeout(r, 5));
    (await import('../scheduler/storage.ts')).clearRunningMarker(schedule.id);
    return { at: Date.now(), sessionId, status: 'ok' };
  },
}));

let engine: typeof import('../scheduler/engine.ts');
let storage: typeof import('../scheduler/storage.ts');
let DATA_DIR: string;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  stubActive = true;
  for (const k of ['DATA_SYNC_SCHEDULER_ACTIVE', 'SCHEDULER_CATCHUP_DELAY_MS', 'SCHEDULER_MAX_MISSED_AGE_MS']) savedEnv[k] = process.env[k];
  process.env.DATA_SYNC_SCHEDULER_ACTIVE = 'true';
  process.env.SCHEDULER_CATCHUP_DELAY_MS = '30';
  delete process.env.SCHEDULER_MAX_MISSED_AGE_MS;
  ({ DATA_DIR } = await import('../paths.ts'));
  engine = await import('../scheduler/engine.ts');
  storage = await import('../scheduler/storage.ts');
});
afterAll(() => {
  stubActive = false;
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

const HOUR = 60 * 60 * 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let n = 0;
function onceSchedule(at: number, over: Partial<Schedule> = {}): Schedule {
  const id = `once-res-${++n}`;
  return {
    id,
    name: `Send Mailchimp campaign ${n}`,
    enabled: true,
    trigger: { kind: 'once', at },
    task: { kind: 'prompt', prompt: 'send the campaign' },
    scope: 'user',
    createdBy: { uid: 'u1', email: 'u1@example.com' },
    createdAt: Date.now() - 3 * 24 * HOUR,
    updatedAt: Date.now() - 3 * 24 * HOUR,
    runCount: 0,
    ...over,
  };
}

/** Simulate a server boot over the given on-disk schedules. */
function boot(schedules: Schedule[]): void {
  writeFileSync(path.join(DATA_DIR, 'schedules.json'), JSON.stringify(schedules, null, 2));
  engine.start(() => {});
}

beforeEach(() => { started = []; });

describe('resurrected one-off schedules', () => {
  test('control: a future `once` still fires when its time comes', async () => {
    const s = onceSchedule(Date.now() + 120);
    boot([s]);
    await sleep(300);
    expect(started).toEqual([s.id]);
  });

  test('a past-due `once` (the incident: 50h overdue) is never fired, and is retired', async () => {
    const s = onceSchedule(Date.now() - 50 * HOUR);
    boot([s]);
    await sleep(300);
    expect(started).toEqual([]);
    expect(engine.getSchedule(s.id)?.enabled).toBe(false);
    expect(engine.getSchedule(s.id)?.nextRun).toBeUndefined();
  });

  test('a resurrected `once` that ALREADY RAN does not re-fire, even with a future `at`', async () => {
    // The dangerous shape: the merge brought the entry back AND its `at` is still ahead, so the
    // past-due guard cannot see it. The only evidence it already sent is the completion marker
    // the engine wrote before deleting it.
    const s = onceSchedule(Date.now() + 120);
    storage.writeCompletionMarker({ completedAt: Date.now() - HOUR, triggeredBy: 'scheduler', scheduleId: s.id });
    boot([s]);
    await sleep(300);
    expect(started).toEqual([]);
    expect(engine.getSchedule(s.id)?.enabled).toBe(false);
  });

  test('a resurrected `once` carrying its own successful lastRun does not re-fire', async () => {
    // Second witness, and the one that survives a wiped/rebuilt data dir: the entry the merge
    // resurrected carries `lastRun.status === "ok"` from the run that preceded its deletion.
    const s = onceSchedule(Date.now() + 120, {
      runCount: 1,
      lastRun: { at: Date.now() - HOUR, sessionId: 'sched-prev', status: 'ok' },
    });
    boot([s]);
    await sleep(300);
    expect(started).toEqual([]);
    expect(engine.getSchedule(s.id)?.enabled).toBe(false);
  });
});

describe('a one-off that has NOT successfully run is left alone', () => {
  test('a failed manual attempt does not cancel the still-pending scheduled send', async () => {
    // `markRunStarted`/`recordAttemptOutcome` write a completion marker at FIRE time, with
    // `completedAt: 0` while the schedule has never completed. So a future-dated one-off that a
    // user test-ran manually — and whose run errored — carries a marker without ever having
    // sent. Treating "a marker exists" as "it already ran" retires that schedule, silently
    // cancelling a send that never happened (and reporting it as completed at epoch 0).
    const s = onceSchedule(Date.now() + 120);
    storage.writeCompletionMarker({
      completedAt: 0, triggeredBy: 'manual', scheduleId: s.id,
      lastAttemptAt: Date.now() - HOUR, attemptWindow: Date.now() - HOUR, status: 'error',
    });
    boot([s]);
    await sleep(300);
    expect(started).toEqual([s.id]);
    // And having now genuinely sent, it retires the normal way — deleted, not left armed.
    expect(engine.getSchedule(s.id)).toBeUndefined();
  });
});
