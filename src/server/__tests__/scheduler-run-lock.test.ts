import { describe, test, expect, beforeAll, afterAll, beforeEach, mock } from 'bun:test';
import { spawnSync, spawn } from 'node:child_process';
import { writeFileSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Schedule, ScheduleRunSummary, CompletionMarker, RunningMarker, RunOutcome, RunRefusal } from '../scheduler/types.ts';

// Drives the REAL engine (start/runNow/resumeRun/catch-up) against a stubbed runner, so the
// assertions are about WHO gets to start a run and what gets recorded — not about agent output.
//
// Same delegate-when-inactive shape as scheduler-retry.test.ts: `mock.module` is process-global
// and permanent, so the stub must fall through to the real module outside this file.
const realRunner = { ...(await import('../scheduler/runner.ts')) };
let stubActive = false;

/** Every run the engine actually started, in order. */
let started: { scheduleId: string; sessionId: string; resumed: boolean }[] = [];
/** Terminal status the stub reports for the next run(s). */
let nextStatus: ScheduleRunSummary['status'] = 'ok';
/** How long a stubbed run stays in flight. */
let runMs = 5;
/** When set, the next stubbed run REJECTS instead of resolving — the unexpected-throw path. */
let throwNext = false;
/** Peak number of concurrently in-flight runs — must never exceed 1 per schedule. */
let peakConcurrent = 0;
let inFlight = 0;

mock.module('../scheduler/runner.ts', () => ({
  ...realRunner,
  async runSchedule(
    schedule: Schedule,
    _onEvent: (ev: object) => void,
    registerRun: (sid: string, ac: AbortController) => void,
    _override?: string,
    resume?: { sessionId: string; prompt: string },
  ): Promise<ScheduleRunSummary> {
    // eslint-disable-next-line prefer-rest-params
    if (!stubActive) return realRunner.runSchedule(...(arguments as unknown as Parameters<typeof realRunner.runSchedule>));
    const sessionId = resume?.sessionId ?? `stub-${schedule.id}-${Date.now()}-${started.length}`;
    started.push({ scheduleId: schedule.id, sessionId, resumed: !!resume });
    registerRun(sessionId, new AbortController());
    peakConcurrent = Math.max(peakConcurrent, ++inFlight);
    await new Promise((r) => setTimeout(r, runMs));
    inFlight--;
    if (throwNext) { throwNext = false; throw new Error('runner blew up'); }
    // The real runner clears the lock when it reaches a terminal state — mirror that, otherwise
    // the engine's own release would be the only one and we'd not be testing the real ordering.
    (await import('../scheduler/storage.ts')).clearRunningMarker(schedule.id);
    return { at: Date.now(), sessionId, status: nextStatus };
  },
}));

let engine: typeof import('../scheduler/engine.ts');
let storage: typeof import('../scheduler/storage.ts');
let timing: typeof import('../scheduler/timing.ts');
let DATA_DIR: string;

const savedEnv: Record<string, string | undefined> = {};
beforeAll(async () => {
  stubActive = true;
  // bun test shares ONE process across files — restore these so sibling suites (which assert the
  // scheduler is INACTIVE) aren't affected by us.
  for (const k of ['DATA_SYNC_SCHEDULER_ACTIVE', 'SCHEDULER_CATCHUP_DELAY_MS', 'SCHEDULER_MAX_MISSED_AGE_MS']) savedEnv[k] = process.env[k];
  process.env.DATA_SYNC_SCHEDULER_ACTIVE = 'true';
  process.env.SCHEDULER_CATCHUP_DELAY_MS = '30';
  // NOTE: SCHEDULER_MAX_MISSED_AGE_MS is deliberately NOT set — every test below runs against the
  // shipped 6h default. Fixtures use an hourly cron so their missed window is at most 60m old
  // whatever time of day the suite runs, and the incident tests build their window explicitly.
  delete process.env.SCHEDULER_MAX_MISSED_AGE_MS;
  ({ DATA_DIR } = await import('../paths.ts'));
  engine = await import('../scheduler/engine.ts');
  storage = await import('../scheduler/storage.ts');
  timing = await import('../scheduler/timing.ts');
});
afterAll(() => {
  stubActive = false;
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

const DAY = 24 * 60 * 60 * 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let n = 0;
function makeSchedule(over: Partial<Schedule> = {}): Schedule {
  const id = `lock-test-${++n}`;
  return {
    id,
    name: `lock test ${n}`,
    enabled: true,
    // Hourly: the missed window is never more than 60m old, so these fixtures are catch-up
    // eligible under the REAL 6h default at any time of day. Staleness is exercised explicitly
    // by the incident tests, which build a 14h-old window.
    trigger: { kind: 'cron', expr: '0 * * * *', tz: 'UTC' },
    task: { kind: 'prompt', prompt: 'do the thing' },
    scope: 'user',
    createdBy: { uid: 'u1', email: 'u1@example.com' },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    runCount: 0,
    ...over,
  };
}

/** Simulate a server boot: persist the given schedules, then start the engine over them. */
function boot(schedules: Schedule[]): void {
  writeFileSync(path.join(DATA_DIR, 'schedules.json'), JSON.stringify(schedules, null, 2));
  engine.start(() => {});
}

/** Assert a start request was refused, and return WHY. The reason is part of the contract now:
 *  boot recovery records it on the session, and the API maps it to a 409 body. */
function refusedWith(o: RunOutcome): RunRefusal {
  expect(o.ok).toBe(false);
  return (o as Extract<RunOutcome, { ok: false }>).reason;
}

function markerFor(id: string): CompletionMarker | null {
  return storage.readCompletionMarker(id);
}
function lockFor(id: string): RunningMarker | null {
  return storage.readRunningMarker(id);
}

/** A pid that is alive but is NOT this process — a stand-in for the previous/parallel instance. */
function spawnLivePid(): { pid: number; kill: () => void } {
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  return { pid: child.pid!, kill: () => { try { child.kill('SIGKILL'); } catch { /* gone */ } } };
}

/** A pid that is definitely dead: run a process to completion, then reuse its (now free) pid. */
function deadPid(): number {
  const r = spawnSync('true', [], { stdio: 'ignore' });
  const pid = r.pid!;
  expect(storage.isProcessAlive(pid)).toBe(false);
  return pid;
}

beforeEach(() => {
  started = [];
  nextStatus = 'ok';
  throwNext = false;
  runMs = 5;
  peakConcurrent = 0;
  inFlight = 0;
});

describe('scheduler run lock', () => {
  test('a lock written before a restart still blocks a run after it (live pid)', async () => {
    const s = makeSchedule({ trigger: { kind: 'interval', everyMs: 60_000 } });
    const other = spawnLivePid();
    try {
      // As if the previous process wrote it and is still alive across our "restart".
      storage.writeRunningMarker({ pid: other.pid, startedAt: Date.now() - 1000, scheduleId: s.id, window: Date.now() - 1000 });
      boot([s]);
      expect(refusedWith(engine.runNow(s.id))).toBe('locked');
      await sleep(20);
      expect(started).toHaveLength(0);
      // The foreign lock is untouched — we must not steal a live claim.
      expect(lockFor(s.id)?.pid).toBe(other.pid);
    } finally {
      other.kill();
      storage.clearRunningMarker(s.id);
    }
  });

  test('a lock whose pid is dead is reclaimed (a reboot must not wedge the schedule)', async () => {
    const s = makeSchedule({ trigger: { kind: 'interval', everyMs: 60_000 } });
    storage.writeRunningMarker({ pid: deadPid(), startedAt: Date.now() - DAY, scheduleId: s.id, window: Date.now() - DAY });
    boot([s]);
    expect(engine.runNow(s.id).ok).toBe(true);
    expect(lockFor(s.id)?.pid).toBe(process.pid);
    await sleep(40);
    expect(started.map((r) => r.scheduleId)).toEqual([s.id]);
    // Released on completion.
    expect(lockFor(s.id)).toBeNull();
  });

  test('two manual runNow calls never overlap — the second is queued behind the first', async () => {
    const s = makeSchedule({ trigger: { kind: 'interval', everyMs: 60_000 } });
    storage.clearRunningMarker(s.id);
    boot([s]);
    expect(engine.runNow(s.id).ok).toBe(true);
    const second = engine.runNow(s.id);
    expect(second).toEqual({ ok: true, sessionId: null, queued: true });   // accepted, deferred
    await sleep(80);
    expect(started).toHaveLength(2);
    expect(peakConcurrent).toBe(1);
    expect(lockFor(s.id)).toBeNull();
  });
});

describe('catch-up vs in-place resume', () => {
  test('resume claims the interrupted window first; the pending catch-up becomes a no-op', async () => {
    const s = makeSchedule({
      lastRun: { at: Date.now() - 2 * DAY, sessionId: 'sched-old', status: 'running' },
    });
    rmSync(path.join(DATA_DIR, 'scheduler/completions', `${s.id}.json`), { force: true });
    storage.clearRunningMarker(s.id);

    // The resumed run is STILL IN FLIGHT when the catch-up timer fires, so what suppresses the
    // catch-up here is the run lock itself, not the completion marker.
    runMs = 200;
    boot([s]);                                  // schedules the catch-up (30ms)
    engine.resumeRun(s.id, 'sched-old', 'continue where you left off'); // recovery wins the race
    await sleep(400);                           // let the catch-up timer fire and settle

    expect(started).toHaveLength(1);
    expect(started[0]!.resumed).toBe(true);
    expect(started[0]!.sessionId).toBe('sched-old');
    expect(peakConcurrent).toBe(1);
  });

  test('catch-up claims first when there is nothing to resume; a later resume is refused', async () => {
    const s = makeSchedule({
      lastRun: { at: Date.now() - 2 * DAY, sessionId: 'sched-old2', status: 'running' },
    });
    rmSync(path.join(DATA_DIR, 'scheduler/completions', `${s.id}.json`), { force: true });
    storage.clearRunningMarker(s.id);

    boot([s]);
    await sleep(35);                            // catch-up has fired and is in-flight
    expect(started).toHaveLength(1);
    expect(started[0]!.resumed).toBe(false);
    // The catch-up is in-flight in THIS process, so the in-memory guard answers before the lock.
    expect(refusedWith(engine.resumeRun(s.id, 'sched-old2', 'continue'))).toBe('already-running');
    await sleep(60);
    expect(started).toHaveLength(1);
  });
});

describe('attempts are recorded at start, not only on success', () => {
  test('a run that errors advances lastRun + the marker, and does not re-fire on the next boot', async () => {
    nextStatus = 'error';
    const s = makeSchedule({
      lastRun: { at: Date.now() - 2 * DAY, sessionId: 'sched-err', status: 'ok' },
    });
    rmSync(path.join(DATA_DIR, 'scheduler/completions', `${s.id}.json`), { force: true });
    storage.clearRunningMarker(s.id);

    boot([s]);                                  // boot 1 → catch-up fires
    await sleep(120);
    expect(started).toHaveLength(1);

    const m = markerFor(s.id)!;
    expect(m.status).toBe('error');
    expect(m.completedAt).toBe(0);              // never succeeded
    expect(m.attemptWindow).toBeGreaterThan(Date.now() - 2 * DAY);
    const live = engine.getSchedule(s.id)!;
    expect(live.lastRun!.status).toBe('error');
    expect(live.lastRun!.at).toBeGreaterThan(Date.now() - 60_000);

    // boot 2, over the state boot 1 persisted — the failed window must not be replayed.
    const persisted: Schedule[] = JSON.parse(readFileSync(path.join(DATA_DIR, 'schedules.json'), 'utf-8'));
    started = [];
    boot(persisted);
    await sleep(120);
    expect(started).toHaveLength(0);
  });
});

describe('onMissed policy', () => {
  async function bootMissed(over: Partial<Schedule>, maxAge?: string) {
    const s = makeSchedule({ lastRun: { at: Date.now() - 2 * DAY, sessionId: 'x', status: 'ok' }, ...over });
    rmSync(path.join(DATA_DIR, 'scheduler/completions', `${s.id}.json`), { force: true });
    storage.clearRunningMarker(s.id);
    const prevMax = process.env.SCHEDULER_MAX_MISSED_AGE_MS;
    if (maxAge) process.env.SCHEDULER_MAX_MISSED_AGE_MS = maxAge;
    try {
      boot([s]);
      await sleep(120);
    } finally {
      process.env.SCHEDULER_MAX_MISSED_AGE_MS = prevMax;
    }
    return engine.getSchedule(s.id)!;
  }

  test("absent onMissed defaults to 'run' — the missed window is replayed", async () => {
    const live = await bootMissed({});
    expect(started.map((r) => r.scheduleId)).toEqual([live.id]);
    expect(live.missedRun).toBeUndefined();
  });

  test("'run' replays the missed window", async () => {
    const live = await bootMissed({ onMissed: 'run' });
    expect(started.map((r) => r.scheduleId)).toEqual([live.id]);
  });

  test("'skip' never replays and records the miss", async () => {
    const live = await bootMissed({ onMissed: 'skip' });
    expect(started).toHaveLength(0);
    expect(live.missedRun?.reason).toBe('skip');
  });

  test("'offer' does not auto-fire but records the window for an on-demand run", async () => {
    const live = await bootMissed({ onMissed: 'offer' });
    expect(started).toHaveLength(0);
    expect(live.missedRun?.reason).toBe('offer');
    expect(live.missedRun?.at).toBeGreaterThan(0);
    // …and it is still runnable on demand.
    expect(engine.runNow(live.id).ok).toBe(true);
    await sleep(40);
    expect(started).toHaveLength(1);
  });

  test('an operator-lowered ceiling is honoured', async () => {
    const live = await bootMissed({ onMissed: 'run' }, '1');
    expect(started).toHaveLength(0);
    expect(live.missedRun?.reason).toBe('stale');
  });
});

// ── The incident, at the shipped defaults ────────────────────────────────────
// A box lost power mid-run; on the next boot two daily crons were replayed ~14h after their
// window (08:00/15:30 jobs executing at 22:02 local). No env overrides here: these run against
// SCHEDULER_MAX_MISSED_AGE_MS's real 6h default.

/** A daily cron in UTC whose most recent window is exactly `hoursAgo` hours before now. */
function dailyCronNHoursAgo(hoursAgo: number): Schedule['trigger'] {
  const d = new Date(Date.now() - hoursAgo * 60 * 60 * 1000);
  return { kind: 'cron', expr: `${d.getUTCMinutes()} ${d.getUTCHours()} * * *`, tz: 'UTC' };
}

/** The state a real power-loss leaves on disk: a schedule stuck in 'running', a completion
 *  ledger whose last entry is a STARTED attempt on the interrupted window, and a running marker
 *  still naming the (now dead) pid of the process that died. */
function seedCrashState(s: Schedule, opts: { legacy?: boolean } = {}): number {
  const window = timing.computePrevRun(s.trigger)!;
  // The at-start lastRun the new engine persists. In the legacy shape lastRun only advanced on
  // SUCCESS, so it still points at the last good run — which is what made catch-up eligible.
  s.lastRun = { at: opts.legacy ? window - 2 * DAY : window, sessionId: 'sched-crashed', status: 'running' };
  rmSync(path.join(DATA_DIR, 'scheduler/completions', `${s.id}.json`), { force: true });
  // Written by the PRODUCTION function the engine calls at run start, not a hand-built fixture —
  // so reverting markRunStarted breaks every test that boots from a crash, not just one.
  if (!opts.legacy) storage.markRunStarted(s.id, window);
  storage.writeRunningMarker({ pid: deadPid(), startedAt: window, scheduleId: s.id, window });
  return window;
}

describe('incident: a ~14h-stale daily window must not replay', () => {
  test('catch-up refuses it at the shipped default ceiling', async () => {
    const s = makeSchedule({ trigger: dailyCronNHoursAgo(14) });
    s.lastRun = { at: Date.now() - 2 * DAY, sessionId: 'x', status: 'ok' };
    rmSync(path.join(DATA_DIR, 'scheduler/completions', `${s.id}.json`), { force: true });
    storage.clearRunningMarker(s.id);
    expect(process.env.SCHEDULER_MAX_MISSED_AGE_MS).toBeUndefined();  // really the default

    boot([s]);
    await sleep(120);

    expect(started).toHaveLength(0);
    expect(engine.getSchedule(s.id)!.missedRun?.reason).toBe('stale');
  });

  test('the same schedule 1h late DOES replay — it is the 6h cap that bites, not any age > 0', async () => {
    const s = makeSchedule({ trigger: dailyCronNHoursAgo(1) });
    s.lastRun = { at: Date.now() - 2 * DAY, sessionId: 'x', status: 'ok' };
    rmSync(path.join(DATA_DIR, 'scheduler/completions', `${s.id}.json`), { force: true });
    storage.clearRunningMarker(s.id);

    boot([s]);
    await sleep(120);

    expect(started).toHaveLength(1);
    expect(engine.getSchedule(s.id)!.missedRun).toBeUndefined();
  });

  test('the RESUME path refuses it too — this is the path that actually replayed', async () => {
    const s = makeSchedule({ trigger: dailyCronNHoursAgo(14) });
    const window = seedCrashState(s);
    boot([s]);

    expect(refusedWith(engine.resumeRun(s.id, 'sched-crashed', 'continue'))).toBe('stale');
    await sleep(120);

    expect(started).toHaveLength(0);
    const live = engine.getSchedule(s.id)!;
    expect(live.missedRun?.reason).toBe('stale');
    expect(live.missedRun?.at).toBe(window);
  });

  test("the resume path honours onMissed=skip", async () => {
    const s = makeSchedule({ onMissed: 'skip' });   // hourly ⇒ well inside the ceiling
    seedCrashState(s);
    boot([s]);

    expect(refusedWith(engine.resumeRun(s.id, 'sched-crashed', 'continue'))).toBe('policy-skip');
    await sleep(120);

    expect(started).toHaveLength(0);
    expect(engine.getSchedule(s.id)!.missedRun?.reason).toBe('skip');
  });

  test('a fresh window still resumes — the ceiling does not break recovery', async () => {
    const s = makeSchedule();                        // hourly ⇒ window < 60m old
    seedCrashState(s);
    boot([s]);

    expect(engine.resumeRun(s.id, 'sched-crashed', 'continue').ok).toBe(true);
    await sleep(120);

    expect(started).toHaveLength(1);
    expect(started[0]!.resumed).toBe(true);
    expect(started[0]!.sessionId).toBe('sched-crashed');
  });
});

// ── Non-cron triggers: resume is their ONLY gate ─────────────────────────────────────────────
// `computePrevRun` returns null for interval/once/event, and start()'s catch-up loop skips every
// non-cron trigger — so before this, an interval run interrupted 14h ago resumed unconditionally
// and `onMissed` was silently ignored. The window for these comes from what the interrupted run
// itself recorded (the run lock's `window`), which is what the crash leaves on disk.

/** The disk state a power cut leaves for a NON-cron schedule interrupted `hoursAgo` hours ago:
 *  a dead-pid run lock stamped with the window the run claimed, plus the at-start attempt. */
function seedNonCronCrash(s: Schedule, hoursAgo: number): number {
  const window = Date.now() - hoursAgo * 60 * 60 * 1000;
  s.lastRun = { at: window, sessionId: 'sched-crashed', status: 'running' };
  rmSync(path.join(DATA_DIR, 'scheduler/completions', `${s.id}.json`), { force: true });
  storage.markRunStarted(s.id, window);
  storage.writeRunningMarker({ pid: deadPid(), startedAt: window, scheduleId: s.id, window });
  return window;
}

describe('non-cron: the staleness ceiling and onMissed apply to every trigger kind', () => {
  test('an interval run interrupted 14h ago is NOT resumed at the shipped default ceiling', async () => {
    const s = makeSchedule({ trigger: { kind: 'interval', everyMs: 60_000 } });
    const window = seedNonCronCrash(s, 14);
    boot([s]);

    expect(refusedWith(engine.resumeRun(s.id, 'sched-crashed', 'continue'))).toBe('stale');
    await sleep(120);

    expect(started).toHaveLength(0);
    const live = engine.getSchedule(s.id)!;
    expect(live.missedRun).toEqual({ at: window, reason: 'stale', noticedAt: expect.any(Number) });
  });

  test('a FRESH interval interruption still resumes — the ceiling does not break recovery', async () => {
    const s = makeSchedule({ trigger: { kind: 'interval', everyMs: 60_000 } });
    seedNonCronCrash(s, 1);                          // 1h < 6h ceiling
    boot([s]);

    expect(engine.resumeRun(s.id, 'sched-crashed', 'continue').ok).toBe(true);
    await sleep(120);
    expect(started).toHaveLength(1);
    expect(started[0]!.resumed).toBe(true);
  });

  test("onMissed=skip is honoured on an interval schedule (it was silently ignored)", async () => {
    const s = makeSchedule({ trigger: { kind: 'interval', everyMs: 60_000 }, onMissed: 'skip' });
    seedNonCronCrash(s, 1);                          // fresh ⇒ only the POLICY can refuse it
    boot([s]);

    expect(refusedWith(engine.resumeRun(s.id, 'sched-crashed', 'continue'))).toBe('policy-skip');
    await sleep(120);
    expect(started).toHaveLength(0);
    expect(engine.getSchedule(s.id)!.missedRun?.reason).toBe('skip');
  });

  test('a `once` run interrupted past the ceiling is refused too', async () => {
    const s = makeSchedule({ trigger: { kind: 'once', at: Date.now() + DAY } });
    seedNonCronCrash(s, 14);
    boot([s]);

    expect(refusedWith(engine.resumeRun(s.id, 'sched-crashed', 'continue'))).toBe('stale');
    await sleep(120);
    expect(started).toHaveLength(0);
  });

  test('with no marker at all the window falls back to the at-start lastRun — still gated', async () => {
    const s = makeSchedule({ trigger: { kind: 'event', source: 'probe' } });
    s.lastRun = { at: Date.now() - 14 * 60 * 60 * 1000, sessionId: 'sched-crashed', status: 'running' };
    rmSync(path.join(DATA_DIR, 'scheduler/completions', `${s.id}.json`), { force: true });
    storage.clearRunningMarker(s.id);
    boot([s]);

    expect(refusedWith(engine.resumeRun(s.id, 'sched-crashed', 'continue'))).toBe('stale');
    await sleep(60);
    expect(started).toHaveLength(0);
  });
});

// ── The timer path: a frozen-and-resumed process ─────────────────────────────────────────────
// The box is a laptop. When the lid closes the process is FROZEN, not killed — same pid, no
// restart, so start()'s catch-up scan never runs. On wake the overdue setTimeout fires and the
// elapsed window ran immediately and late, consulting neither onMissed nor the ceiling. Same
// shape for any wall-clock jump (NTP step, VM pause).

/** The state a suspend leaves behind: an armed fire whose time has passed while the process was
 *  frozen. Mutating the live `nextRun` is precisely what a wall-clock jump does to an already
 *  armed timer. Re-arming happens through a replan triggered by an unrelated delete, so the fire
 *  goes through the REAL timer path (replan → setTimeout → fireDue), not a test-only entry. */
function fireLate(s: Schedule, hoursLate: number, fillerId: string): number {
  const live = engine.getSchedule(s.id)!;
  const window = Date.now() - hoursLate * 60 * 60 * 1000;
  live.nextRun = window;
  if (live.trigger.kind === 'once') live.trigger = { kind: 'once', at: window };
  engine.deleteSchedule(fillerId);   // → replan() → an already-overdue timer → fireDue()
  return window;
}

/** Boot `s` alongside a never-firing filler whose deletion is our replan trigger. */
function bootWithFiller(s: Schedule): string {
  const filler = makeSchedule({ trigger: { kind: 'cron', expr: '0 0 1 1 *', tz: 'UTC' } });
  rmSync(path.join(DATA_DIR, 'scheduler/completions', `${s.id}.json`), { force: true });
  storage.clearRunningMarker(s.id);
  boot([s, filler]);
  return filler.id;
}

describe('timer path: a fire that arrives late because the host was suspended', () => {
  test('a punctual fire still fires — normal operation is untouched', async () => {
    const s = makeSchedule();
    const filler = bootWithFiller(s);
    fireLate(s, 0, filler);
    await sleep(80);

    expect(started.map((r) => r.scheduleId)).toEqual([s.id]);
    expect(engine.getSchedule(s.id)!.missedRun).toBeUndefined();
  });

  test('onMissed=skip does NOT gate a punctual fire — it is a missed-window policy, not a mute', async () => {
    const s = makeSchedule({ onMissed: 'skip' });
    const filler = bootWithFiller(s);
    fireLate(s, 0, filler);
    await sleep(80);

    expect(started).toHaveLength(1);
    expect(engine.getSchedule(s.id)!.missedRun).toBeUndefined();
  });

  test('a 14h-stale fire is refused and recorded as missedRun (the incident)', async () => {
    const s = makeSchedule();
    const filler = bootWithFiller(s);
    const window = fireLate(s, 14, filler);
    await sleep(80);

    expect(started).toHaveLength(0);
    expect(engine.getSchedule(s.id)!.missedRun).toEqual({ at: window, reason: 'stale', noticedAt: expect.any(Number) });
  });

  test("the recorded window is the SCHEDULED fire time, not the wake-up time", async () => {
    const s = makeSchedule();
    const filler = bootWithFiller(s);
    const window = fireLate(s, 14, filler);
    await sleep(80);

    const missed = engine.getSchedule(s.id)!.missedRun!;
    expect(missed.at).toBe(window);              // when it should have run
    expect(missed.noticedAt).toBeGreaterThan(window);  // when we noticed, kept separate
  });

  test('onMissed=skip on a stale fire records skip, not stale', async () => {
    const s = makeSchedule({ onMissed: 'skip' });
    const filler = bootWithFiller(s);
    fireLate(s, 14, filler);
    await sleep(80);

    expect(started).toHaveLength(0);
    expect(engine.getSchedule(s.id)!.missedRun?.reason).toBe('skip');
  });

  test('onMissed=offer on a stale fire records offer for an on-demand run', async () => {
    const s = makeSchedule({ onMissed: 'offer' });
    const filler = bootWithFiller(s);
    fireLate(s, 14, filler);
    await sleep(80);

    expect(started).toHaveLength(0);
    expect(engine.getSchedule(s.id)!.missedRun?.reason).toBe('offer');
    // `offer` is a read-path affordance: the missed window must survive onto the API's output.
    expect(engine.listSchedules().find((x) => x.id === s.id)?.missedRun?.reason).toBe('offer');
    expect(engine.runNow(s.id).ok).toBe(true);   // …and can still be run on demand
    await sleep(80);
    expect(started).toHaveLength(1);
  });

  test('a refused fire writes NO attempt/completion marker — nothing to double-record', async () => {
    const s = makeSchedule();
    const filler = bootWithFiller(s);
    fireLate(s, 14, filler);
    await sleep(80);

    expect(markerFor(s.id)).toBeNull();          // the window was never attempted
    expect(lockFor(s.id)).toBeNull();
    // …and a later boot catch-up doesn't re-record it either: the attempt-free window is
    // re-judged by the same rule and lands on the same single missedRun record.
    const before = engine.getSchedule(s.id)!.missedRun!;
    boot([{ ...engine.getSchedule(s.id)! }]);
    await sleep(120);
    expect(started).toHaveLength(0);
    expect(engine.getSchedule(s.id)!.missedRun?.at).toBe(before.at);
  });

  test('an interval job after a 2.5h suspend still fires once, and re-arms normally', async () => {
    const s = makeSchedule({ trigger: { kind: 'interval', everyMs: 5 * 60_000 } });
    const filler = bootWithFiller(s);
    fireLate(s, 2.5, filler);                    // 2.5h < 6h ceiling
    await sleep(80);

    expect(started).toHaveLength(1);             // ONE fire, not one per elapsed period
    const live = engine.getSchedule(s.id)!;
    expect(live.nextRun).toBeGreaterThan(Date.now());
    expect(live.missedRun).toBeUndefined();
  });

  test('an interval job past the ceiling is refused, then resumes on its next period', async () => {
    const s = makeSchedule({ trigger: { kind: 'interval', everyMs: 5 * 60_000 } });
    const filler = bootWithFiller(s);
    fireLate(s, 14, filler);
    await sleep(80);

    expect(started).toHaveLength(0);
    const live = engine.getSchedule(s.id)!;
    expect(live.missedRun?.reason).toBe('stale');
    // Not stranded: still enabled with a fresh future fire ~one period out. The cost of the
    // refusal is a single skipped cycle, which is the honest outcome for a 5-minute job that
    // is 14h late — there is nothing left to catch up.
    expect(live.enabled).toBe(true);
    expect(live.nextRun).toBeGreaterThan(Date.now());
    expect(live.nextRun! - Date.now()).toBeLessThanOrEqual(5 * 60_000);
  });

  test('a `once` that elapsed during the suspend is refused AND retired — never left armed', async () => {
    const s = makeSchedule({ trigger: { kind: 'once', at: Date.now() + DAY } });
    const filler = bootWithFiller(s);
    const window = fireLate(s, 14, filler);
    await sleep(80);

    expect(started).toHaveLength(0);
    const live = engine.getSchedule(s.id)!;
    expect(live.enabled).toBe(false);            // retired, not enabled-but-never-firing
    expect(live.nextRun).toBeUndefined();
    expect(live.missedRun).toEqual({ at: window, reason: 'stale', noticedAt: expect.any(Number) });
  });

  test('a `once` inside the ceiling fires and is auto-deleted as before', async () => {
    const s = makeSchedule({ trigger: { kind: 'once', at: Date.now() + DAY } });
    const filler = bootWithFiller(s);
    fireLate(s, 1, filler);
    await sleep(120);

    expect(started).toHaveLength(1);
    expect(engine.getSchedule(s.id)).toBeUndefined();   // once-schedules self-delete on success
  });
});

describe('onMissed is validated at the write surface', () => {
  test('upsertSchedule rejects a bogus policy rather than persisting it', () => {
    const s = makeSchedule({ onMissed: 'sometimes' as never });
    const r = engine.upsertSchedule(s);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain('Invalid onMissed');
    expect(engine.getSchedule(s.id)).toBeUndefined();
  });

  test('a valid policy round-trips through the schedule read path', () => {
    const s = makeSchedule({ onMissed: 'offer' });
    expect(engine.upsertSchedule(s).ok).toBe(true);
    expect(engine.listSchedules().find((x) => x.id === s.id)?.onMissed).toBe('offer');
  });
});

describe('an unexpected rejection records a terminal outcome', () => {
  test("a throwing run leaves status 'error', not a forever-'started' marker", async () => {
    const s = makeSchedule({ trigger: { kind: 'interval', everyMs: 60_000 } });
    storage.clearRunningMarker(s.id);
    rmSync(path.join(DATA_DIR, 'scheduler/completions', `${s.id}.json`), { force: true });
    boot([s]);
    throwNext = true;                                 // the runner rejects instead of resolving
    expect(engine.runNow(s.id).ok).toBe(true);
    await sleep(60);

    const m = markerFor(s.id)!;
    expect(m.status).toBe('error');                   // was 'started' — indistinguishable from a crash
    expect(m.completedAt).toBe(0);
    expect(engine.getSchedule(s.id)!.lastRun!.status).toBe('error');
    expect(lockFor(s.id)).toBeNull();                 // and the lock is still released
  });
});

// ── Boot ordering: scheduler.start() → recoverInterruptedSessions(), racing catch-up ─────────
// boot.ts calls scheduler.start() and then recoverInterruptedSessions(); recovery is async and
// may finish before OR after the catch-up timer (SCHEDULER_CATCHUP_DELAY_MS, 10s in production).
describe('boot ordering: recovery vs the catch-up timer', () => {
  test('recovery lands BEFORE the catch-up timer — the interrupted session is resumed', async () => {
    const s = makeSchedule();
    seedCrashState(s);
    runMs = 200;                                     // still in flight when catch-up fires
    boot([s]);
    engine.resumeRun(s.id, 'sched-crashed', 'continue');
    await sleep(400);

    expect(started).toHaveLength(1);
    expect(started[0]!.resumed).toBe(true);
    expect(peakConcurrent).toBe(1);
  });

  test('recovery lands AFTER the catch-up timer — real crash state: catch-up never fired, so the resume still wins', async () => {
    const s = makeSchedule();
    seedCrashState(s);                               // attemptWindow on disk ⇒ catch-up suppressed
    boot([s]);
    await sleep(120);                                // well past the 30ms catch-up delay
    expect(started).toHaveLength(0);

    expect(engine.resumeRun(s.id, 'sched-crashed', 'continue').ok).toBe(true);
    await sleep(60);
    expect(started).toHaveLength(1);
    expect(started[0]!.resumed).toBe(true);
  });

  test('recovery lands AFTER the catch-up timer, legacy state (no attempt marker) — catch-up covers the window, the late resume is refused, and it runs exactly once', async () => {
    const s = makeSchedule();
    seedCrashState(s, { legacy: true });
    boot([s]);
    await sleep(120);

    expect(started).toHaveLength(1);
    expect(started[0]!.resumed).toBe(false);         // fresh run, not the interrupted session
    expect(refusedWith(engine.resumeRun(s.id, 'sched-crashed', 'continue'))).toBe('already-completed');
    await sleep(60);
    expect(started).toHaveLength(1);                 // never twice — that is the incident
    expect(peakConcurrent).toBe(1);
  });
});

describe('run lock age ceiling', () => {
  test('a live-pid lock older than the ceiling is reclaimed (post-reboot pid reuse must not wedge a schedule)', async () => {
    const s = makeSchedule({ trigger: { kind: 'interval', everyMs: 60_000 } });
    const other = spawnLivePid();
    try {
      // 30 days old, held by a pid that IS alive — the reboot-pid-reuse scenario.
      storage.writeRunningMarker({ pid: other.pid, startedAt: Date.now() - 30 * DAY, scheduleId: s.id, window: Date.now() - 30 * DAY });
      boot([s]);
      expect(engine.runNow(s.id).ok).toBe(true);
      expect(lockFor(s.id)?.pid).toBe(process.pid);
      await sleep(40);
      expect(started).toHaveLength(1);
    } finally {
      other.kill();
      storage.clearRunningMarker(s.id);
    }
  });

  test('the ceiling is the only escape hatch — a FRESH live-pid lock is never stolen, manual included', async () => {
    const s = makeSchedule({ trigger: { kind: 'interval', everyMs: 60_000 } });
    const other = spawnLivePid();
    try {
      storage.writeRunningMarker({ pid: other.pid, startedAt: Date.now() - 1000, scheduleId: s.id, window: Date.now() - 1000 });
      boot([s]);
      expect(refusedWith(engine.runNow(s.id))).toBe('locked');
      expect(lockFor(s.id)?.pid).toBe(other.pid);
      await sleep(40);
      expect(started).toHaveLength(0);
    } finally {
      other.kill();
      storage.clearRunningMarker(s.id);
    }
  });

  test('an operator can shorten the ceiling to unwedge a schedule now', async () => {
    const s = makeSchedule({ trigger: { kind: 'interval', everyMs: 60_000 } });
    const other = spawnLivePid();
    const prev = process.env.SCHEDULER_RUN_LOCK_MAX_AGE_MS;
    try {
      storage.writeRunningMarker({ pid: other.pid, startedAt: Date.now() - 60_000, scheduleId: s.id, window: Date.now() - 60_000 });
      boot([s]);
      expect(refusedWith(engine.runNow(s.id))).toBe('locked');   // 1m old, default 6h ceiling ⇒ respected
      process.env.SCHEDULER_RUN_LOCK_MAX_AGE_MS = '1000';
      expect(engine.runNow(s.id).ok).toBe(true);
      await sleep(40);
      expect(started).toHaveLength(1);
    } finally {
      if (prev === undefined) delete process.env.SCHEDULER_RUN_LOCK_MAX_AGE_MS; else process.env.SCHEDULER_RUN_LOCK_MAX_AGE_MS = prev;
      other.kill();
      storage.clearRunningMarker(s.id);
    }
  });

  test('updateRunLockPid never forges a lock and never steals a foreign one', () => {
    const id = `lock-pid-${++n}`;
    storage.clearRunningMarker(id);
    storage.updateRunLockPid(id, 4242);
    expect(storage.readRunningMarker(id)).toBeNull();          // no lock held ⇒ none created

    const other = spawnLivePid();
    try {
      storage.writeRunningMarker({ pid: other.pid, startedAt: 111, scheduleId: id, window: 222 });
      storage.updateRunLockPid(id, 4242);
      expect(storage.readRunningMarker(id)!.pid).toBe(other.pid);  // not ours ⇒ untouched

      storage.writeRunningMarker({ pid: process.pid, startedAt: 111, scheduleId: id, window: 222 });
      storage.updateRunLockPid(id, 4242);
      const held = storage.readRunningMarker(id)!;
      expect(held.pid).toBe(4242);
      expect(held.window).toBe(222);
      expect(held.startedAt).toBe(111);                          // age ceiling not refreshed
    } finally {
      other.kill();
      storage.clearRunningMarker(id);
    }
  });
});

describe('an interrupted run keeps its session link', () => {
  test('lastRun.sessionId is persisted as soon as the run registers, not only on completion', async () => {
    runMs = 300;
    const s = makeSchedule({ trigger: { kind: 'interval', everyMs: 60_000 } });
    storage.clearRunningMarker(s.id);
    boot([s]);
    engine.runNow(s.id);
    await sleep(30);                                  // mid-run: this is what a crash would leave

    const persisted: Schedule[] = JSON.parse(readFileSync(path.join(DATA_DIR, 'schedules.json'), 'utf-8'));
    const rec = persisted.find((p) => p.id === s.id)!;
    expect(rec.lastRun!.status).toBe('running');
    expect(rec.lastRun!.sessionId).toBe(started[0]!.sessionId);
    expect(rec.lastRun!.sessionId).not.toBe('');
    await sleep(350);
  });
});
