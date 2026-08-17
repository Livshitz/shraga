/** Scheduled task definitions — see scheduler/engine.ts for the runtime. */

export type Trigger =
  | { kind: 'once'; at: number /* epoch ms */ }
  | { kind: 'interval'; everyMs: number }
  | { kind: 'cron'; expr: string; tz: string }
  /** Event-driven: fires when an external event with matching `source` (and optional
   *  `match` filter on the event payload) arrives on the event bus. Never timer-fired.
   *  Optional `throttle` suppresses duplicate fires (same dedup key) BEFORE a run is
   *  spawned — see EventThrottle. */
  | { kind: 'event'; source: string; match?: Record<string, string>; throttle?: EventThrottle };

/** Per-trigger dedup: a fire is suppressed if an identical key fired within `windowSec`.
 *  The key is built from the named payload fields (dot-paths into the event payload),
 *  string-normalized (lowercased, digits→`#`, whitespace-collapsed) so values that differ
 *  only by timestamps/ids collapse together. Empty `byFields` keys on the source alone. */
export interface EventThrottle {
  byFields: string[];
  windowSec: number;
}

export type Task =
  | { kind: 'prompt'; prompt?: string; promptFile?: string; model?: string }
  | { kind: 'bash'; command: string; model?: string }
  | { kind: 'job'; command: string };

/** Visibility: 'system' schedules + their sessions are shared with all whitelisted users; 'user' is private to createdBy. */
export type Scope = 'system' | 'user';

export interface ScheduleRunSummary {
  at: number;
  sessionId: string;
  status: 'running' | 'ok' | 'error' | 'aborted';
  error?: string;
  /** Set on an errored run that produced NO output at all (no tool_use, no text, no thinking) —
   *  the same side-effect boundary the in-process retry uses. It means the window's work provably
   *  did not start, so the window has not really been spent and re-running cannot double-apply
   *  anything. The engine uses it to re-arm the window instead of burning it. */
  sideEffectFree?: boolean;
}

/** What the scheduler did about a window it found already elapsed at boot.
 *  - `run`   replay it (today's behaviour, and the default — see engine.ts).
 *  - `skip`  never replay; the window is simply lost.
 *  - `offer` don't auto-fire, but record it on the schedule (`missedRun`) so a human can
 *            see it was missed and run it on demand. */
export type MissedPolicy = 'run' | 'skip' | 'offer';

/** A window that elapsed while nothing was running and was NOT replayed.
 *  Persisted on the schedule and returned verbatim by `GET /api/schedules[/:id]` — that read
 *  path IS the affordance `offer` promises: a human (or the agent, via the scheduler skill) sees
 *  the missed window and can `POST /api/schedules/:id/run` it on demand. */
export interface MissedRun {
  /** The window (fire time) that was missed. */
  at: number;
  reason: 'skip' | 'offer' | 'stale';
  /** When the scheduler noticed — i.e. boot time. Read by whoever acts on the miss: `at` alone
   *  can't tell "missed 20m ago, still worth running" from "found on a boot two days later". */
  noticedAt: number;
}

/** Why a start request did not start a run. */
export type RunRefusal =
  | 'unknown-schedule'
  | 'already-running'
  | 'already-completed'
  | 'already-attempted'
  | 'policy-skip'
  | 'policy-offer'
  | 'stale'
  | 'locked';

/**
 * Result of asking the engine to start a run (timer fire, catch-up, manual, event, resume).
 * A refusal carries WHY, so the caller can record a truthful error and map a real HTTP status
 * instead of collapsing every outcome into "null".
 */
export type RunOutcome =
  | { ok: true; sessionId: string | null; queued?: boolean }
  | { ok: false; reason: RunRefusal; message: string };

/**
 * Per-schedule attempt/completion ledger. `completedAt` records the last SUCCESSFUL run;
 * `lastAttemptAt`/`attemptWindow` record the last run that STARTED, whether or not it finished.
 * Both are needed: completion drives "this period is done", attempt drives "this period was
 * already tried, don't replay it after a crash".
 */
export interface CompletionMarker {
  /** Last successful completion; 0 when the schedule has never completed. */
  completedAt: number;
  triggeredBy: 'scheduler' | 'ssh' | 'api' | 'manual';
  scheduleId: string;
  /** Wall-clock time the last attempt began. */
  lastAttemptAt?: number;
  /** The window (fire time) that attempt was covering. */
  attemptWindow?: number;
  /** Terminal state of the last attempt; `started` means it never reported back (crash). */
  status?: 'started' | 'ok' | 'error' | 'aborted';
}

/**
 * The run lock: at most one live run per scheduleId, across process restarts.
 * Written by `acquireRunLock` before a run starts, removed when it reaches a terminal state.
 * A lock whose `pid` is dead (crash / power loss) is reclaimable — see `acquireRunLock`.
 */
export interface RunningMarker {
  pid: number;
  startedAt: number;
  scheduleId: string;
  /** The window (fire time) this run covers — lets a claimer see WHAT is held, not just that
   *  something is. */
  window?: number;
}

export interface Schedule {
  id: string;
  name: string;
  enabled: boolean;
  trigger: Trigger;
  task: Task;
  scope: Scope;
  createdBy: { uid: string; email: string };
  createdAt: number;
  updatedAt: number;
  nextRun?: number;
  lastRun?: ScheduleRunSummary;
  runCount: number;
  /** What to do with a window that elapsed while the process was down. Absent ⇒ 'run'. */
  onMissed?: MissedPolicy;
  /** Last window that elapsed and was deliberately not replayed (policy or staleness). */
  missedRun?: MissedRun;
  /** Set when a data-plane module owns this schedule (module name). Module reconcile
   *  updates trigger/task; enable/disable snapshots live in the module's state entry. */
  managedBy?: string;
}
