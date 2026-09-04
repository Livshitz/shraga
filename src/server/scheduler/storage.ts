import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { DATA_DIR, dataPath } from '../paths.ts';
import type { Schedule, CompletionMarker, RunningMarker } from './types.ts';
import { dataSync } from '../data-sync.ts';

const FILE = dataPath('schedules.json');
const COMPLETIONS_DIR = dataPath('scheduler/completions');
const RUNNING_DIR = dataPath('scheduler/running');
const THROTTLE_FILE = dataPath('state/trigger-throttle.json');

/** Per-trigger event throttle ledger: dedup-key → last-fired epoch ms. */
export function loadThrottleState(): Record<string, number> {
  if (!existsSync(THROTTLE_FILE)) return {};
  try {
    const parsed = JSON.parse(readFileSync(THROTTLE_FILE, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    console.error('[scheduler] failed to parse trigger-throttle.json, starting fresh:', err);
    return {};
  }
}

export function saveThrottleState(state: Record<string, number>): void {
  mkdirSync(dataPath('state'), { recursive: true });
  const tmp = `${THROTTLE_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, THROTTLE_FILE);
}

/**
 * Schedules persisted before `task.kind` existed carry only the payload fields. Everything
 * downstream branches on the discriminant, so infer it from the shape once, on load — a task
 * missing its kind silently skipped the outcome contract and reported every run as `ok`.
 * Only `prompt` is inferable: `bash` and `job` are both `{ command }`, and guessing between them
 * would hand a run the wrong permission handler, so a kindless command task is left alone.
 */
function normalizeTask(task: Record<string, unknown>): void {
  if (task.kind) return;
  if (typeof task.prompt === 'string' || typeof task.promptFile === 'string') task.kind = 'prompt';
}

function normalizeSchedule(s: Schedule): Schedule {
  if (s.task && typeof s.task === 'object') normalizeTask(s.task as unknown as Record<string, unknown>);
  return s;
}

export function loadSchedules(): Schedule[] {
  if (!existsSync(FILE)) return [];
  try {
    const parsed = JSON.parse(readFileSync(FILE, 'utf-8'));
    return Array.isArray(parsed) ? parsed.map((s) => normalizeSchedule(s as Schedule)) : [];
  } catch (err) {
    console.error('[scheduler] failed to parse schedules.json:', err);
    return [];
  }
}

export function saveSchedules(schedules: Schedule[]): void {
  mkdirSync(DATA_DIR, { recursive: true });
  // Guard: if existing file has significantly more schedules, back up before overwriting
  if (existsSync(FILE)) {
    try {
      const existing = JSON.parse(readFileSync(FILE, 'utf-8'));
      if (Array.isArray(existing) && existing.length > schedules.length + 2) {
        const bak = `${FILE}.bak`;
        writeFileSync(bak, JSON.stringify(existing, null, 2));
        console.warn(`[scheduler] ⚠️ saving ${schedules.length} schedules over ${existing.length} on disk — backup at schedules.json.bak`);
      }
    } catch { /* parse error — overwrite is fine */ }
  }
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(schedules, null, 2));
  renameSync(tmp, FILE);
  dataSync.trackWrite('schedules.json');
}

export function readCompletionMarker(scheduleId: string): CompletionMarker | null {
  const file = `${COMPLETIONS_DIR}/${scheduleId}.json`;
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch (err) {
    console.error(`[scheduler] failed to read completion marker for ${scheduleId}:`, err);
    return null;
  }
}

export function writeCompletionMarker(marker: CompletionMarker): void {
  mkdirSync(COMPLETIONS_DIR, { recursive: true });
  const file = `${COMPLETIONS_DIR}/${marker.scheduleId}.json`;
  writeFileSync(file, JSON.stringify(marker, null, 2));
}

export function writeRunningMarker(marker: RunningMarker): void {
  mkdirSync(RUNNING_DIR, { recursive: true });
  writeFileSync(`${RUNNING_DIR}/${marker.scheduleId}.json`, JSON.stringify(marker, null, 2));
}

export function readRunningMarker(scheduleId: string): RunningMarker | null {
  const file = `${RUNNING_DIR}/${scheduleId}.json`;
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

export function clearRunningMarker(scheduleId: string): void {
  try { unlinkSync(`${RUNNING_DIR}/${scheduleId}.json`); } catch { /* best-effort */ }
}

export function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** How long a held run lock is believed, before it is treated as abandoned regardless of whether
 *  its pid answers. Bounds the blast radius of pid reuse: after a power cut the OS restarts pid
 *  allocation low, so a persisted pid can plausibly be live again under the same uid — and a
 *  liveness check alone would then wedge the schedule forever. Generous vs any real run (agent
 *  runs are minutes, not hours) while capping the wedge at one window's worth of a daily job. */
const runLockMaxAgeMs = () => Number(process.env.SCHEDULER_RUN_LOCK_MAX_AGE_MS ?? 6 * 60 * 60 * 1000);

/**
 * Claim the single live-run slot for a schedule.
 *
 * The lock IS the running marker — same file, same conventions — so it survives a process
 * restart: after a crash the marker is still on disk but its pid is dead, and a dead pid is
 * reclaimable (otherwise a power cut would wedge the schedule forever). A LIVE pid, ours or
 * another instance's, means someone is already running this schedule: the caller must back off —
 * UNLESS the claim is older than `runLockMaxAgeMs`, which is the escape hatch for a lock wedged
 * by pid reuse. A live, in-ceiling claim is never stolen, not even by a manual run: on this
 * single-active-instance design that pid is a real run (an agent session, or a spawned job the
 * lock was re-pointed at), and starting a second one is the duplicate-fire we are preventing.
 *
 * Single-writer by design (only the DATA_SYNC_SCHEDULER_ACTIVE instance fires), so this is a
 * read-then-write, not an atomic CAS.
 */
export function acquireRunLock(scheduleId: string, window: number): RunningMarker | null {
  const existing = readRunningMarker(scheduleId);
  if (existing) {
    const alive = isProcessAlive(existing.pid);
    const age = Date.now() - (Number.isFinite(existing.startedAt) ? existing.startedAt : 0);
    const maxAge = runLockMaxAgeMs();
    if (alive && age <= maxAge) return null;
    const why = !alive
      ? `dead pid ${existing.pid}`
      : `held ${Math.round(age / 60_000)}m by live pid ${existing.pid}, past the ${Math.round(maxAge / 60_000)}m lock ceiling — assuming pid reuse`;
    console.log(`[scheduler] reclaiming run lock for ${scheduleId} — ${why} (window ${new Date(existing.window ?? existing.startedAt).toISOString()})`);
  }
  const marker: RunningMarker = { pid: process.pid, startedAt: Date.now(), scheduleId, window };
  writeRunningMarker(marker);
  return marker;
}

/** Re-point a held lock at a spawned child process. Only ever touches a lock THIS process holds,
 *  and preserves `startedAt` so re-pointing can't refresh the age ceiling above. */
export function updateRunLockPid(scheduleId: string, pid: number): void {
  const existing = readRunningMarker(scheduleId);
  if (!existing) {
    console.warn(`[scheduler] updateRunLockPid(${scheduleId}): no lock held — not creating one`);
    return;
  }
  if (existing.pid !== process.pid) {
    console.warn(`[scheduler] updateRunLockPid(${scheduleId}): lock is held by pid ${existing.pid}, not us — leaving it alone`);
    return;
  }
  writeRunningMarker({ ...existing, scheduleId, pid });
}

/**
 * Record that a run STARTED for `window`, before it can succeed or fail.
 *
 * Without this a run that errors or is killed leaves no trace on disk, so the next boot sees an
 * un-completed window and replays it — the double-fire this ledger exists to prevent. The
 * successful-completion timestamp is preserved untouched so "started" stays distinguishable
 * from "completed ok".
 */
export function markRunStarted(scheduleId: string, window: number, triggeredBy: CompletionMarker['triggeredBy'] = 'scheduler'): void {
  const prev = readCompletionMarker(scheduleId);
  writeCompletionMarker({
    completedAt: prev?.completedAt ?? 0,
    triggeredBy,
    scheduleId,
    lastAttemptAt: Date.now(),
    attemptWindow: window,
    status: 'started',
  });
}

/** Undo the at-start attempt stamp for a window whose run turned out to have done nothing.
 *  `markRunStarted` records `attemptWindow` BEFORE the work happens — right for a crash (the run
 *  had its shot), wrong for a run that provably never started, because that stamp is precisely
 *  what makes a window un-replayable. `completedAt` is untouched: a period that genuinely
 *  completed must stay guarded no matter what a later attempt does. */
export function releaseAttemptWindow(scheduleId: string, window: number): void {
  const prev = readCompletionMarker(scheduleId);
  if (!prev || prev.attemptWindow !== window) return;
  writeCompletionMarker({
    completedAt: prev.completedAt,
    triggeredBy: prev.triggeredBy,
    scheduleId,
    lastAttemptAt: prev.lastAttemptAt,
    attemptWindow: undefined,
    status: prev.status,
  });
}
