import { loadSchedules, saveSchedules, readCompletionMarker, writeCompletionMarker, readRunningMarker, isProcessAlive, loadThrottleState, saveThrottleState, acquireRunLock, clearRunningMarker, markRunStarted } from './storage.ts';
import { computeNextRun, computePrevRun, validateTrigger } from './timing.ts';
import { runSchedule, type ResumeOptions, type EventContext } from './runner.ts';
import { backfillScope, ensureBuiltinSchedules } from './builtins.ts';
import { emitEvent } from '../events/bus.ts';
import { getSessionUrl } from '../shraga-config.ts';
import type { Schedule, MissedPolicy, RunOutcome, RunRefusal } from './types.ts';

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
/** Catch-up fires are delayed so MCP servers finish initializing first. Read per call so tests
 *  (and an operator) can shorten it. */
const catchupDelayMs = () => Number(process.env.SCHEDULER_CATCHUP_DELAY_MS ?? 10_000);
/** Hard ceiling on how late a missed window may still be replayed, regardless of `onMissed`.
 *  A missed window is never more than one period old, so a period-relative bound alone can never
 *  suppress anything — yet replaying an 08:00 report at 22:00 is not the job the schedule
 *  describes. This absolute cap is therefore the entire rule.
 *
 *  Deliberately NOT `min(period, cap)`: a cron missed window comes from `computePrevRun`, so its
 *  age is always strictly less than one period — a period-relative term can never suppress
 *  anything, and `min(period, cap)` is provably identical to `cap`. */
const maxMissedAgeMs = () => Number(process.env.SCHEDULER_MAX_MISSED_AGE_MS ?? 6 * 60 * 60 * 1000);
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
  const catchUps: { id: string; window: number }[] = [];
  for (const s of state.schedules) {
    if (!s.enabled || s.trigger.kind !== 'cron') continue;
    const prev = computePrevRun(s.trigger);
    if (prev === null) continue;
    const lastAt = s.lastRun?.at;
    if (lastAt === undefined) continue; // never ran — nothing to catch up
    if (lastAt >= prev) continue;

    const marker = readCompletionMarker(s.id);
    if (marker && marker.completedAt >= prev) {
      console.log(`[scheduler] skipping catch-up for ${s.id} — already completed at ${new Date(marker.completedAt).toISOString()} by ${marker.triggeredBy}`);
      continue;
    }
    // An ATTEMPT on this window counts too: a run that errored or was killed already had its
    // shot. Replaying it on the next boot is exactly the duplicate-fire this guards.
    if (marker?.attemptWindow !== undefined && marker.attemptWindow >= prev) {
      console.log(`[scheduler] skipping catch-up for ${s.id} — window ${new Date(prev).toISOString()} already attempted (${marker.status ?? 'started'})`);
      continue;
    }
    // Someone is already on it — either another instance, or (far more common) the recovery
    // path that resumed the interrupted run in-place moments ago.
    const running = readRunningMarker(s.id);
    if (running && isProcessAlive(running.pid)) {
      console.log(`[scheduler] skipping catch-up for ${s.id} — still running (pid ${running.pid}, started ${new Date(running.startedAt).toISOString()})`);
      continue;
    }

    const policy = missedPolicy(s);
    if (policy === 'skip') {
      console.log(`[scheduler] missed window ${new Date(prev).toISOString()} for ${s.id} — onMissed=skip, not replaying`);
      noteMissed(s, prev, 'skip');
      continue;
    }
    if (policy === 'offer') {
      console.log(`[scheduler] missed window ${new Date(prev).toISOString()} for ${s.id} — onMissed=offer, recorded for on-demand run`);
      noteMissed(s, prev, 'offer');
      continue;
    }
    const age = Date.now() - prev;
    const grace = maxMissedAgeMs();
    if (age > grace) {
      console.log(`[scheduler] missed window ${new Date(prev).toISOString()} for ${s.id} is ${Math.round(age / 60_000)}m stale (grace ${Math.round(grace / 60_000)}m) — not replaying`);
      noteMissed(s, prev, 'stale');
      continue;
    }
    catchUps.push({ id: s.id, window: prev });
  }
  if (catchUps.length) {
    console.log(`[scheduler] catch-up: ${catchUps.map((c) => c.id).join(', ')} (delayed ${catchupDelayMs()}ms for MCP init)`);
    setTimeout(() => {
      for (const { id, window } of catchUps) {
        const s = getSchedule(id);
        if (!s?.enabled) continue;
        console.log(`[scheduler] catch-up: firing ${id}`);
        // NOT runNow(): a catch-up is not a manual run. It must go through the same
        // completion/attempt/lock guards as any timer fire, so that whatever claimed this
        // window first (typically the in-place resume) makes this a no-op.
        enqueueFire(s, window);
      }
    }, catchupDelayMs());
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
  if (s.onMissed !== undefined && !MISSED_POLICIES.includes(s.onMissed)) {
    return { ok: false, error: `Invalid onMissed "${s.onMissed}" (expected ${MISSED_POLICIES.join(' | ')})` };
  }

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

export function runNow(id: string, override?: string): RunOutcome {
  const s = getSchedule(id);
  if (!s) return refuse('unknown-schedule', `No schedule ${id}`);
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
export function resumeRun(scheduleId: string, sessionId: string, prompt: string): RunOutcome {
  const s = getSchedule(scheduleId);
  if (!s) {
    console.warn(`[scheduler] resumeRun: unknown schedule ${scheduleId}`);
    return refuse('unknown-schedule', `No schedule ${scheduleId}`);
  }
  if (state.running.has(scheduleId)) {
    console.log(`[scheduler] resumeRun: ${scheduleId} already running — skipping resume`);
    return refuse('already-running', `${s.name} is already running`);
  }
  const window = interruptedWindow(s);
  // A resume continues an existing conversation rather than starting a fresh one, so it dodges
  // the duplicate-side-effect problem — but it does NOT dodge the "is this work still the work
  // the schedule asked for" problem. Finishing the 08:00 report at 22:00 is the incident. So the
  // resume path answers to the same onMissed policy and the same staleness ceiling as catch-up —
  // for EVERY trigger kind, not just cron (interval/once/event have no catch-up path at all, so
  // resume is their only gate).
  if (window !== null) {
    // Someone already finished this window — typically a catch-up that won the boot race and has
    // since completed, so the run lock it held is gone. Resuming now would redo work that is
    // already done: the duplicate fire, one step later. (An *attempt* on this window is NOT a
    // refusal — the interrupted run we are resuming recorded one itself.)
    const marker = readCompletionMarker(scheduleId);
    if (marker && marker.completedAt >= window) {
      const msg = `window ${new Date(window).toISOString()} already completed at ${new Date(marker.completedAt).toISOString()} by ${marker.triggeredBy}`;
      console.log(`[scheduler] not resuming ${scheduleId} — ${msg}`);
      return refuse('already-completed', msg);
    }
    const policy = missedPolicy(s);
    if (policy !== 'run') {
      const msg = `window ${new Date(window).toISOString()} was missed and onMissed=${policy}`;
      console.log(`[scheduler] not resuming ${scheduleId} — ${msg}`);
      noteMissed(s, window, policy);
      return refuse(policy === 'skip' ? 'policy-skip' : 'policy-offer', msg);
    }
    const age = Date.now() - window;
    const grace = maxMissedAgeMs();
    if (age > grace) {
      const msg = `window ${new Date(window).toISOString()} is ${Math.round(age / 60_000)}m stale (ceiling ${Math.round(grace / 60_000)}m)`;
      console.log(`[scheduler] not resuming ${scheduleId} — ${msg}`);
      noteMissed(s, window, 'stale');
      return refuse('stale', msg);
    }
  }
  console.log(`[scheduler] resuming ${scheduleId} in-place on session ${sessionId.slice(0, 30)}…`);
  return startRun(s, window ?? Date.now(), undefined, { sessionId, prompt });
}

// ── Internals ───────────────────────────────────────────────────────────────

const MISSED_POLICIES: MissedPolicy[] = ['run', 'skip', 'offer'];

function refuse(reason: RunRefusal, message: string): RunOutcome {
  return { ok: false, reason, message };
}

/**
 * The window the interrupted run was covering — what "how late is this?" is measured against.
 *
 * For `cron` the window is derivable from the expression itself (`computePrevRun`), and that is
 * preferred: it is correct even for legacy state written before markers recorded a window.
 *
 * `interval`/`once`/`event` have no schedule-derivable grid — but they are not therefore timeless.
 * An interval run interrupted 14h ago is exactly as stale as a cron one, and it has no catch-up
 * path to be caught by. So for those the window is the one the interrupted run ITSELF claimed,
 * read back off the markers already on disk: the run lock's `window` (stamped by `acquireRunLock`
 * at fire time), else its `startedAt`, else the attempt ledger, else the at-start `lastRun.at`.
 * Only a schedule with no trace of ever having started has no window — and nothing to resume.
 */
function interruptedWindow(s: Schedule): number | null {
  const prev = computePrevRun(s.trigger);
  if (prev !== null) return prev;
  const running = readRunningMarker(s.id);
  if (running?.window !== undefined) return running.window;
  if (running?.startedAt) return running.startedAt;
  const marker = readCompletionMarker(s.id);
  if (marker?.attemptWindow !== undefined) return marker.attemptWindow;
  if (marker?.lastAttemptAt) return marker.lastAttemptAt;
  return s.lastRun?.at ?? null;
}

/** Persist the terminal outcome of an attempt without touching the last SUCCESSFUL completion.
 *  Every non-ok exit — reported failure or unexpected throw — must land here, else the marker
 *  stays `started` forever and a crash is indistinguishable from a throw. */
function recordAttemptOutcome(scheduleId: string, firedAt: number, at: number, status: 'error' | 'aborted' | 'started'): void {
  const prev = readCompletionMarker(scheduleId);
  writeCompletionMarker({
    completedAt: prev?.completedAt ?? 0,
    triggeredBy: 'scheduler',
    scheduleId,
    lastAttemptAt: prev?.lastAttemptAt ?? at,
    attemptWindow: prev?.attemptWindow ?? firedAt,
    status,
  });
}

/** Default is `run`: it is what every existing schedule already does, and schedules.json has no
 *  `onMissed` field on any of them — defaulting to anything else would silently change the
 *  behaviour of live automations on upgrade. The unbounded-replay hazard that made `run`
 *  dangerous is fixed by the staleness ceiling below, which applies to `run` too. */
function missedPolicy(s: Schedule): MissedPolicy {
  return s.onMissed ?? 'run';
}

function noteMissed(s: Schedule, at: number, reason: 'skip' | 'offer' | 'stale'): void {
  s.missedRun = { at, reason, noticedAt: Date.now() };
  saveSchedules(state.schedules);
  state.broadcast({ type: 'schedule:updated', schedule: s });
}

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

function enqueueFire(s: Schedule, firedAt: number, override?: string, manual = false, eventCtx?: EventContext): RunOutcome {
  // Skip if this cron period was already completed/attempted. Manual runs (runNow from UI/API)
  // always proceed past the period guard — but never past the run lock in startRun().
  if (!manual && s.trigger.kind === 'cron') {
    const prev = computePrevRun(s.trigger, firedAt + 1);
    if (prev !== null) {
      const marker = readCompletionMarker(s.id);
      if (marker && marker.completedAt >= prev) {
        const msg = `already completed this period (at ${new Date(marker.completedAt).toISOString()})`;
        console.log(`[scheduler] skipping fire for ${s.id} — ${msg}`);
        return refuse('already-completed', msg);
      }
      if (marker?.attemptWindow !== undefined && marker.attemptWindow >= prev) {
        const msg = `this period was already attempted (${marker.status ?? 'started'})`;
        console.log(`[scheduler] skipping fire for ${s.id} — ${msg}`);
        return refuse('already-attempted', msg);
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
  return { ok: true, sessionId: null, queued: true };
}

/**
 * Start one run, holding the cross-restart run lock for its whole life.
 *
 * Every path that can start a run funnels through here — timer fire, catch-up, event, manual
 * runNow, and the in-place resume from crash recovery — so the lock is the single place that
 * enforces "one live run per schedule". It is also what makes catch-up and recovery mutually
 * exclusive: whichever reaches this first holds a live pid, and the other's acquire fails.
 */
function startRun(s: Schedule, firedAt: number, override?: string, resume?: ResumeOptions, eventCtx?: EventContext): RunOutcome {
  const lock = acquireRunLock(s.id, firedAt);
  if (!lock) {
    const held = readRunningMarker(s.id);
    const msg = `run lock held by pid ${held?.pid} since ${new Date(held?.startedAt ?? 0).toISOString()}`;
    console.log(`[scheduler] not starting ${s.id} — ${msg}`);
    return refuse('locked', msg);
  }
  // Record the attempt BEFORE running: a crash from here on must not look like "never tried".
  markRunStarted(s.id, firedAt);
  const pre = getSchedule(s.id);
  if (pre) {
    // Advance lastRun at start, not only on success. start() turns a leftover 'running' into
    // 'error' on the next boot, so the distinction survives while the timestamp still blocks a
    // replay of this window.
    pre.lastRun = { at: Date.now(), sessionId: resume?.sessionId ?? '', status: 'running' };
    pre.missedRun = undefined;
    saveSchedules(state.schedules);
  }
  // Deep-copy task so edits mid-run don't affect the in-flight execution
  const snapshot: Schedule = JSON.parse(JSON.stringify(s));
  let sessionId: string | null = null;
  const onEvent = (ev: object) => state.broadcast(ev);
  const register = (sid: string, ac: AbortController) => {
    sessionId = sid;
    state.running.set(s.id, ac);
    // Backfill the session link onto the at-start lastRun. Without this a crash mid-run persists
    // an errored run with sessionId '' — no way back to the conversation that was interrupted,
    // which is exactly what the recovery path needs.
    const live = getSchedule(s.id);
    if (live?.lastRun && live.lastRun.status === 'running' && !live.lastRun.sessionId) {
      live.lastRun.sessionId = sid;
      saveSchedules(state.schedules);
    }
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
      if (summary.status !== 'ok') {
        // Keep the attempt on record with its real outcome — the next boot must see that this
        // window was tried and failed, not that it never ran.
        recordAttemptOutcome(s.id, firedAt, summary.at, summary.status === 'running' ? 'started' : summary.status);
      }
      if (summary.status === 'ok') {
        writeCompletionMarker({ completedAt: summary.at, triggeredBy: 'scheduler', scheduleId: s.id, lastAttemptAt: summary.at, attemptWindow: firedAt, status: 'ok' });
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
          // Ready-made absolute link. Supplied here rather than left to the consuming prompt:
          // reconcile never syncs a builtin's stored `task.prompt`, so a prompt-only fix would
          // miss every deployment that already persisted the schedule. Omitted when no public
          // origin is configured — better no link than a localhost one.
          sessionUrl: getSessionUrl(summary.sessionId),
          error: summary.error,
        }, { id: summary.sessionId });
      }
    })
    .catch((err) => {
      console.error(`[scheduler] unexpected run failure for ${s.id}:`, err);
      // A rejection never reaches the .then above, so without this the attempt marker stays
      // 'started' forever and an unexpected throw is indistinguishable from a power cut.
      const at = Date.now();
      recordAttemptOutcome(s.id, firedAt, at, 'error');
      const live = getSchedule(s.id);
      if (live) {
        live.lastRun = { at, sessionId: live.lastRun?.sessionId ?? '', status: 'error', error: `unexpected run failure: ${err?.message ?? String(err)}` };
        saveSchedules(state.schedules);
        state.broadcast({ type: 'schedule:updated', schedule: live });
      }
    })
    .finally(() => {
      state.running.delete(s.id);
      // Release the lock on EVERY exit path — ok, error, abort, or an unexpected throw. The
      // runner already clears it on its own terminal states; this is idempotent and covers the
      // paths that never reach the runner's finally.
      clearRunningMarker(s.id);
      const q = state.queues.get(s.id);
      if (q && q.length > 0) {
        const next = q.shift()!;
        state.queues.set(s.id, q);
        const live = getSchedule(s.id);
        if (live) startRun(live, next.firedAt, next.override, undefined, next.eventCtx);
      }
    });

  return { ok: true, sessionId };
}
