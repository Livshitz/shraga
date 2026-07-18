import { loadSchedules, saveSchedules, readCompletionMarker, writeCompletionMarker, readRunningMarker, isProcessAlive, loadThrottleState, saveThrottleState } from './storage.ts';
import { computeNextRun, computePrevRun, validateTrigger } from './timing.ts';
import { runSchedule, type ResumeOptions, type EventContext } from './runner.ts';
import { backfillScope, ensureBuiltinSchedules } from './builtins.ts';
import { emitEvent } from '../events/bus.ts';
import type { Schedule } from './types.ts';

type Broadcast = (data: object) => void;

/** A pending fire awaiting its turn in a schedule's serial queue. */
interface QueuedFire {
  firedAt: number;
  override?: string;
  eventCtx?: EventContext;
}

interface RuntimeState {
  schedules: Schedule[];
  timer: ReturnType<typeof setTimeout> | null;
  /** Per-schedule queue of pending fires (FIFO, capped). */
  queues: Map<string, QueuedFire[]>;
  /** Schedules currently running (id → AbortController for the live run). */
  running: Map<string, AbortController>;
  broadcast: Broadcast;
}

const QUEUE_CAP = 5;
/** Max setTimeout delay (2^31-1 ms ≈ 24.8 days); longer delays overflow and fire immediately. */
const MAX_TIMER_MS = 2_147_483_647;
/** Only the designated instance fires schedules (DATA_SYNC_SCHEDULER_ACTIVE=true).
 *  Inactive instances still load/serve/edit schedules — they just never fire them.
 *  Never flip persisted `enabled` flags here: a later save (toggle/upsert/run) would
 *  cement the disablement into schedules.json and data-sync would spread it. */
let schedulerActive = false;
const state: RuntimeState = {
  schedules: [],
  timer: null,
  queues: new Map(),
  running: new Map(),
  broadcast: () => {},
};

// ── Public API ──────────────────────────────────────────────────────────────

export function start(broadcast: Broadcast): void {
  state.broadcast = broadcast;
  const loaded = loadSchedules();
  backfillScope(loaded);
  state.schedules = ensureBuiltinSchedules(loaded);
  schedulerActive = process.env.DATA_SYNC_SCHEDULER_ACTIVE === 'true';
  if (!schedulerActive) {
    console.log(`[scheduler] inactive (DATA_SYNC_SCHEDULER_ACTIVE not set) — ${state.schedules.length} schedule(s) loaded but will not fire on this instance`);
    return;
  }
  // Initialize nextRun for enabled schedules, skip stale `once` triggers
  for (const s of state.schedules) {
    // Force-idle any schedule that claims to be "running" — after restart nothing is actually running
    if (s.lastRun?.status === 'running') {
      console.log(`[scheduler] clearing stale 'running' status for ${s.id}`);
      s.lastRun.status = 'error';
      s.lastRun.error = 'interrupted by server restart';
    }
    if (!s.enabled) { s.nextRun = undefined; continue; }
    const next = computeNextRun(s.trigger);
    if (next === null) {
      if (s.trigger.kind === 'once') s.enabled = false;
      s.nextRun = undefined;
    } else {
      s.nextRun = next;
    }
  }
  // Catch up missed cron fires (e.g. process was down when cron should have fired)
  const catchUps: string[] = [];
  for (const s of state.schedules) {
    if (!s.enabled || s.trigger.kind !== 'cron') continue;
    const prev = computePrevRun(s.trigger);
    if (prev === null) continue;
    const lastAt = s.lastRun?.at;
    if (lastAt === undefined) continue; // never ran — nothing to catch up
    if (lastAt < prev) {
      const marker = readCompletionMarker(s.id);
      if (marker && marker.completedAt >= prev) {
        console.log(`[scheduler] skipping catch-up for ${s.id} — already completed at ${new Date(marker.completedAt).toISOString()} by ${marker.triggeredBy}`);
        continue;
      }
      const running = readRunningMarker(s.id);
      if (running && isProcessAlive(running.pid)) {
        console.log(`[scheduler] skipping catch-up for ${s.id} — still running (pid ${running.pid}, started ${new Date(running.startedAt).toISOString()})`);
        continue;
      }
      catchUps.push(s.id);
    }
  }
  if (catchUps.length) {
    console.log(`[scheduler] catch-up: ${catchUps.join(', ')} (delayed 10s for MCP init)`);
    setTimeout(() => {
      for (const id of catchUps) {
        const s = getSchedule(id);
        if (s?.enabled) {
          console.log(`[scheduler] catch-up: firing ${id}`);
          runNow(id);
        }
      }
    }, 10_000);
  }

  saveSchedules(state.schedules);
  replan();
  console.log(`[scheduler] started with ${state.schedules.length} schedule(s)`);
}

export function listSchedules(): Schedule[] {
  return [...state.schedules].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getRunningIds(): string[] {
  return [...state.running.keys()];
}

export function getSchedule(id: string): Schedule | undefined {
  return state.schedules.find((s) => s.id === id);
}

export function upsertSchedule(s: Schedule): { ok: true; schedule: Schedule } | { ok: false; error: string } {
  const err = validateTrigger(s.trigger);
  if (err) return { ok: false, error: err };

  s.updatedAt = Date.now();
  if (s.enabled) {
    const next = computeNextRun(s.trigger);
    if (next === null && s.trigger.kind === 'once') s.enabled = false;
    s.nextRun = next ?? undefined;
  } else {
    s.nextRun = undefined;
  }

  const idx = state.schedules.findIndex((x) => x.id === s.id);
  if (idx >= 0) state.schedules[idx] = s;
  else state.schedules.push(s);

  saveSchedules(state.schedules);
  replan();
  state.broadcast({ type: 'schedule:updated', schedule: s });
  return { ok: true, schedule: s };
}

export function deleteSchedule(id: string): boolean {
  const idx = state.schedules.findIndex((s) => s.id === id);
  if (idx < 0) return false;
  state.schedules.splice(idx, 1);
  state.queues.delete(id);
  const ac = state.running.get(id);
  if (ac) ac.abort();
  saveSchedules(state.schedules);
  replan();
  state.broadcast({ type: 'schedule:deleted', id });
  return true;
}

export function toggleSchedule(id: string, enabled: boolean): Schedule | null {
  const s = getSchedule(id);
  if (!s) return null;
  s.enabled = enabled;
  s.updatedAt = Date.now();
  if (enabled) {
    const next = computeNextRun(s.trigger);
    if (next === null && s.trigger.kind === 'once') s.enabled = false;
    s.nextRun = next ?? undefined;
    // Stamp lastRun.at so catch-up doesn't treat past cron windows as missed
    if (s.trigger.kind === 'cron') {
      s.lastRun = { at: Date.now(), sessionId: s.lastRun?.sessionId ?? '', status: s.lastRun?.status ?? 'ok' };
    }
  } else {
    s.nextRun = undefined;
  }
  saveSchedules(state.schedules);
  replan();
  state.broadcast({ type: 'schedule:updated', schedule: s });
  return s;
}

export function runNow(id: string, override?: string): string | null {
  const s = getSchedule(id);
  if (!s) return null;
  return enqueueFire(s, Date.now(), override, true);
}

/**
 * Fire all enabled `event`-trigger schedules whose `source` matches and whose
 * optional `match` filter fits the payload. Returns the ids that fired.
 * Gated by `schedulerActive` so only the designated instance executes (mirrors the
 * timer path) — prevents blue-green double-firing. Unlike `runNow`, never manual.
 */
export function fireEvent(source: string, payload: unknown): string[] {
  if (!schedulerActive) return [];
  const fired: string[] = [];
  for (const s of state.schedules) {
    if (!s.enabled || s.trigger.kind !== 'event') continue;
    if (s.trigger.source !== source) continue;
    if (!matchesEvent(s.trigger.match, payload)) continue;
    if (!throttleAllows(s, payload)) {
      console.log(`[scheduler] throttled event fire for ${s.id} (duplicate within window)`);
      continue;
    }
    enqueueFire(s, Date.now(), undefined, false, { source, payload });
    fired.push(s.id);
  }
  return fired;
}

/** Normalize a payload value for throttle keys: lowercase, digits→`#`, collapse
 *  whitespace, cap length — so values differing only by timestamps/ids collapse. */
function normalizeThrottleField(v: string): string {
  return v.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 120);
}

/** Returns false if this event fire is a duplicate within the trigger's throttle window
 *  (and should be suppressed). Records the fire timestamp when it's allowed. Triggers
 *  without `throttle` always pass. State is persisted + self-pruned in trigger-throttle.json. */
function throttleAllows(s: Schedule, payload: unknown): boolean {
  const throttle = s.trigger.kind === 'event' ? s.trigger.throttle : undefined;
  if (!throttle || throttle.windowSec <= 0) return true;
  const flat = flattenPayload(payload);
  const sig = (throttle.byFields ?? []).map((f) => normalizeThrottleField(flat[f] ?? '')).join('|');
  const key = `${s.id}::${sig}`;
  const windowMs = throttle.windowSec * 1000;
  const now = Date.now();

  const state = loadThrottleState();
  for (const k of Object.keys(state)) if (now - state[k] > windowMs) delete state[k]; // self-prune
  const last = state[key];
  const suppress = last !== undefined && now - last < windowMs;
  if (!suppress) state[key] = now;
  saveThrottleState(state); // persist record or prune
  return !suppress;
}

/** Shallow match: every `key=value` in `match` must equal the flattened payload's
 *  dot-path value (case-insensitive). Empty/absent match → fires on any payload. */
function matchesEvent(match: Record<string, string> | undefined, payload: unknown): boolean {
  if (!match || Object.keys(match).length === 0) return true;
  const flat = flattenPayload(payload);
  return Object.entries(match).every(([k, v]) => {
    const actual = flat[k];
    return actual !== undefined && actual.toLowerCase() === String(v).toLowerCase();
  });
}

function flattenPayload(obj: unknown, prefix = '', out: Record<string, string> = {}): Record<string, string> {
  if (obj === null || obj === undefined) return out;
  if (typeof obj !== 'object') { if (prefix) out[prefix] = String(obj); return out; }
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => flattenPayload(v, prefix ? `${prefix}.${i}` : String(i), out));
    return out;
  }
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object') flattenPayload(v, key, out);
    else out[key] = String(v);
  }
  return out;
}

export function cancelRun(id: string): boolean {
  const ac = state.running.get(id);
  if (!ac) return false;
  ac.abort();
  return true;
}

/**
 * Resume an interrupted scheduler run in-place on its existing session, instead of
 * letting startup catch-up spawn a brand-new conversation (which produced duplicate
 * side-effects, e.g. a second Slack post). Mirrors the web/slack restart-resume path.
 * No-op if the schedule is unknown or already running.
 */
export function resumeRun(scheduleId: string, sessionId: string, prompt: string): string | null {
  const s = getSchedule(scheduleId);
  if (!s) {
    console.warn(`[scheduler] resumeRun: unknown schedule ${scheduleId}`);
    return null;
  }
  if (state.running.has(scheduleId)) {
    console.log(`[scheduler] resumeRun: ${scheduleId} already running — skipping resume`);
    return null;
  }
  console.log(`[scheduler] resuming ${scheduleId} in-place on session ${sessionId.slice(0, 30)}…`);
  return startRun(s, Date.now(), undefined, { sessionId, prompt });
}

// ── Internals ───────────────────────────────────────────────────────────────

function replan(): void {
  if (!schedulerActive) return;
  if (state.timer) { clearTimeout(state.timer); state.timer = null; }

  const now = Date.now();
  let soonest: { s: Schedule; at: number } | null = null;
  for (const s of state.schedules) {
    if (!s.enabled || s.nextRun === undefined) continue;
    if (!soonest || s.nextRun < soonest.at) soonest = { s, at: s.nextRun };
  }
  if (!soonest) return;

  // setTimeout overflows past 2^31-1 ms (~24.8 days) → fires immediately. Cap the
  // delay; for a far-future fire (monthly/yearly cron) the timer wakes early,
  // fireDue() finds nothing due (nextRun still ahead) and re-arms via its own replan().
  const delay = Math.min(Math.max(0, soonest.at - now), MAX_TIMER_MS);
  state.timer = setTimeout(() => {
    state.timer = null;
    fireDue();
  }, delay);
}

function fireDue(): void {
  const now = Date.now();
  for (const s of state.schedules) {
    if (!s.enabled || s.nextRun === undefined) continue;
    if (s.nextRun <= now) enqueueFire(s, s.nextRun);
  }
  // Advance nextRun for recurring triggers; disable fired `once` triggers
  for (const s of state.schedules) {
    if (!s.enabled) continue;
    if (s.nextRun !== undefined && s.nextRun <= now) {
      if (s.trigger.kind === 'once') {
        s.enabled = false;
        s.nextRun = undefined;
      } else {
        const next = computeNextRun(s.trigger, now);
        s.nextRun = next ?? undefined;
      }
    }
  }
  saveSchedules(state.schedules);
  replan();
}

function enqueueFire(s: Schedule, firedAt: number, override?: string, manual = false, eventCtx?: EventContext): string | null {
  // Skip if this cron period was already completed or still running from a prior server instance.
  // Manual runs (runNow from UI/API) always proceed.
  if (!manual && s.trigger.kind === 'cron') {
    const prev = computePrevRun(s.trigger, firedAt + 1);
    if (prev !== null) {
      const marker = readCompletionMarker(s.id);
      if (marker && marker.completedAt >= prev) {
        console.log(`[scheduler] skipping fire for ${s.id} — already completed this period (at ${new Date(marker.completedAt).toISOString()})`);
        return null;
      }
      const running = readRunningMarker(s.id);
      if (running && isProcessAlive(running.pid)) {
        console.log(`[scheduler] skipping fire for ${s.id} — still running (pid ${running.pid})`);
        return null;
      }
    }
  }

  const q = state.queues.get(s.id) ?? [];

  // If not currently running, start immediately
  if (!state.running.has(s.id)) {
    return startRun(s, firedAt, override, undefined, eventCtx);
  }

  // Running — enqueue, dropping oldest if over cap (prefer freshest)
  q.push({ firedAt, override, eventCtx });
  while (q.length > QUEUE_CAP) {
    const dropped = q.shift();
    console.warn(`[scheduler] queue overflow for ${s.id} (cap=${QUEUE_CAP}), dropped fire @ ${dropped?.firedAt}`);
  }
  state.queues.set(s.id, q);
  return null;
}

function startRun(s: Schedule, _firedAt: number, override?: string, resume?: ResumeOptions, eventCtx?: EventContext): string | null {
  // Deep-copy task so edits mid-run don't affect the in-flight execution
  const snapshot: Schedule = JSON.parse(JSON.stringify(s));
  let sessionId: string | null = null;
  const onEvent = (ev: object) => state.broadcast(ev);
  const register = (sid: string, ac: AbortController) => {
    sessionId = sid;
    state.running.set(s.id, ac);
  };

  state.broadcast({ type: 'schedule:fired', scheduleId: s.id });

  runSchedule(snapshot, onEvent, register, override, resume, eventCtx)
    .then((summary) => {
      const live = getSchedule(s.id);
      if (live) {
        live.lastRun = summary;
        live.runCount = (live.runCount ?? 0) + 1;
        saveSchedules(state.schedules);
        state.broadcast({ type: 'schedule:updated', schedule: live });
      }
      if (summary.status === 'ok') {
        writeCompletionMarker({ completedAt: summary.at, triggeredBy: 'scheduler', scheduleId: s.id });
        if (live && live.trigger.kind === 'once') {
          console.log(`[scheduler] auto-deleting completed once-schedule ${s.id}`);
          deleteSchedule(s.id);
        }
      }
      // Lifecycle event: announce completion on the bus so other automations can react
      // (e.g. "after the nightly reconcile → run smoke tests", "any schedule errors → notify").
      // Suppressed for event-triggered runs — otherwise an event-fired run would emit a
      // `schedule.finished` that could re-fire the same listener, looping. (CC-hooks-style
      // lifecycle source; see the scheduler skill.)
      if (!eventCtx) {
        emitEvent('schedule.finished', {
          scheduleId: s.id,
          name: s.name,
          status: summary.status,
          sessionId: summary.sessionId,
          error: summary.error,
        }, { id: summary.sessionId });
      }
    })
    .catch((err) => {
      console.error(`[scheduler] unexpected run failure for ${s.id}:`, err);
    })
    .finally(() => {
      state.running.delete(s.id);
      const q = state.queues.get(s.id);
      if (q && q.length > 0) {
        const next = q.shift()!;
        state.queues.set(s.id, q);
        const live = getSchedule(s.id);
        if (live) startRun(live, next.firedAt, next.override, undefined, next.eventCtx);
      }
    });

  return sessionId;
}
