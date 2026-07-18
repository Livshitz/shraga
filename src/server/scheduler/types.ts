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
}

export interface CompletionMarker {
  completedAt: number;
  triggeredBy: 'scheduler' | 'ssh' | 'api' | 'manual';
  scheduleId: string;
}

export interface RunningMarker {
  pid: number;
  startedAt: number;
  scheduleId: string;
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
}
