/**
 * Downtime recovery — "what happened while I was down?"
 *
 * This box is deliberately NOT always-on. When it comes back, the honest question is not "what
 * should I replay?" but "what did I miss, and what do you want me to do about it?". Phase 1
 * (scheduler run lock + `onMissed`) already stopped the blind replay that finished an 08:00 job at
 * 22:00; this module supplies the other half — the ledger and the on-demand report.
 *
 * Deliberately inert: nothing here starts a run, answers a Slack message, or mutates a schedule.
 * The only writers are the heartbeat, the gap ledger (boot gap + late-tick/suspend gap), and the
 * Slack last-seen cursor.
 * Acting on a finding is always an explicit follow-up (`POST /api/schedules/:id/run`).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dataPath } from './paths.ts';
import { loadSchedules } from './scheduler/storage.ts';
import type { MissedRun } from './scheduler/types.ts';

const HEARTBEAT_FILE = dataPath('state/heartbeat.json');
const DOWNTIME_FILE = dataPath('state/downtime.json');
const SLACK_CURSORS_FILE = dataPath('state/slack-cursors.json');

/** How often liveness is stamped to disk. */
export const HEARTBEAT_INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS ?? 60_000);

/**
 * Gap above which an absence counts as downtime — 3 heartbeat intervals (3m by default).
 *
 * The worst case for a CLEAN restart is: the last heartbeat landed a tick before shutdown (up to
 * 1 interval stale) + the process restart itself. One interval is therefore already "normal", and
 * two leaves no margin for a slow boot, a loaded box, or clock/write skew — either would log
 * phantom downtime on every deploy, which is worse than useless (it would drown the real outage).
 * Three intervals is comfortably above every clean-restart case and still far below anything a
 * human would call an outage: a real power cut is minutes-to-hours, not 3 minutes.
 */
export const DOWNTIME_THRESHOLD_MS = Number(process.env.DOWNTIME_THRESHOLD_MS ?? 3 * HEARTBEAT_INTERVAL_MS);

/**
 * Bounded history: the last 20 outages. This is a "what did I miss" aid, not an uptime archive —
 * the report only ever reads the recent tail, and the joins that make an entry actionable
 * (`missedRun`, Slack history) age out long before 20 outages do. 20 keeps the file trivially
 * small while still covering many months on a box that is off occasionally.
 */
export const DOWNTIME_HISTORY_MAX = 20;

/**
 * How long a `suspend` gap keeps colouring the report's `note`.
 *
 * A suspend is never retroactively scanned — no restart happens, so no catch-up ever covers it, and
 * a later `boot` entry does not make it honest. The warning therefore cannot be tied to "is the
 * newest entry a suspend?"; it has to age out on its own. 24h is the horizon of the manual check
 * the note asks for ("which schedule windows fell in the gap?"): nearly every schedule here is
 * daily or tighter, so after a day the same window has come round again and run normally, and the
 * gap is no longer the thing to look at.
 */
export const SUSPEND_NOTE_MAX_AGE_MS = Number(process.env.SUSPEND_NOTE_MAX_AGE_MS ?? 24 * 60 * 60 * 1000);

export interface DowntimeEntry {
  /** Last proven-alive moment (the final heartbeat before the gap). */
  from: number;
  /** When the process came back. */
  to: number;
  ms: number;
  /**
   * How the gap was noticed. `boot` = the process died (crash, power cut, deploy) and the gap was
   * measured at startup. `suspend` = the process never died — the host slept (lid closed, standby)
   * and a heartbeat tick came back late by more than the threshold. Both are real outages; the
   * distinction matters to the reader, because a `suspend` gap means the process was FROZEN, so
   * nothing at all ran at boot afterwards (no scheduler catch-up scan — see `missedSchedules`).
   * Absent on entries written before this field existed.
   */
  cause?: 'boot' | 'suspend';
  /**
   * channelId → last Slack ts we had seen when this outage was recorded. Present on `boot` entries
   * ONLY, where it is snapshotted before any live traffic can move the cursors (`recordBootGap()`
   * runs before the Slack ingress mounts — see boot.ts). The live cursor is a tail pointer: one
   * normal message after recovery pushes it past the entire backlog, so a snapshot taken after
   * traffic resumed would hide the outage rather than bound it.
   *
   * Absent on `suspend` entries by design: that gap is recorded from a heartbeat tick, up to
   * HEARTBEAT_INTERVAL_MS after the wake — exactly when the reconnected socket delivers the
   * backlog — so the cursor is no longer provably pre-gap. With no snapshot the backfill floors at
   * the outage start (`from`), which can re-report a few already-seen messages but can never skip
   * unseen ones.
   */
  slackCursors?: Record<string, string>;
}

interface DowntimeFile { entries: DowntimeEntry[] }

// ── storage (same conventions as scheduler/storage.ts: tmp file + rename) ──────────────────────

function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8'));
    return parsed && typeof parsed === 'object' ? (parsed as T) : fallback;
  } catch (err) {
    console.error(`[downtime] failed to parse ${file}, starting fresh:`, err);
    return fallback;
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(dataPath('state'), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}

// ── heartbeat ─────────────────────────────────────────────────────────────────────────────────

export function readHeartbeat(): number | null {
  const hb = readJson<{ at?: number }>(HEARTBEAT_FILE, {});
  return Number.isFinite(hb.at) ? (hb.at as number) : null;
}

export function writeHeartbeat(at = Date.now()): void {
  writeJsonAtomic(HEARTBEAT_FILE, { at, pid: process.pid });
}

/**
 * Stamp liveness every interval, and NOTICE when a tick comes back late.
 *
 * A boot-time check only catches an outage that killed the process. The common failure on this box
 * is the opposite: a MacBook that sleeps with the lid closed. The process is frozen, not killed —
 * it never restarts, so `recordBootGap()` never runs, and a 2.5h outage was completely invisible.
 * A late tick is the one signal that survives a suspend, because the timer resumes on wake and the
 * wall clock has moved on. Unref'd — a heartbeat must never hold the process open.
 */
export function startHeartbeat(intervalMs = HEARTBEAT_INTERVAL_MS): () => void {
  writeHeartbeat();
  const timer = setInterval(() => {
    try { recordTickGap(); } catch (err) { console.error('[downtime] heartbeat write failed:', err); }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

// ── downtime ledger ───────────────────────────────────────────────────────────────────────────

export function listDowntime(): DowntimeEntry[] {
  return readJson<DowntimeFile>(DOWNTIME_FILE, { entries: [] }).entries ?? [];
}

/**
 * The one gap-recording path, shared by the boot check and the late-tick check.
 *
 * Both ask the same question — "the last proven-alive moment is `last`, it is now `now`, is that a
 * hole?" — so they share the same threshold, the same bounds, and the same Slack-cursor snapshot.
 * Writing the heartbeat forward is the caller's job and happens either way (this process is alive
 * NOW regardless of the verdict), which is also what makes an outage record exactly ONCE: the next
 * comparison starts from `now`, not from the stale pre-gap stamp.
 *
 * Never fires anything. It appends a row to a JSON file and logs — that is the whole contract.
 */
function recordGap(last: number, now: number, cause: 'boot' | 'suspend'): DowntimeEntry | null {
  const ms = now - last;
  // `<=` also covers a backwards clock jump (negative ms): degrade to "no outage", never invent one.
  if (ms <= DOWNTIME_THRESHOLD_MS) return null;

  // Freeze the Slack cursors into the entry — but only on the boot path, where they are still
  // provably pre-gap (recordBootGap runs before the Slack ingress mounts). On the suspend path the
  // socket has been back for up to a heartbeat interval and may already have pushed the cursor past
  // the whole backlog; recording that would be worse than recording nothing, so the entry carries
  // no snapshot and the backfill floors at the gap start instead. See DowntimeEntry.slackCursors.
  const snapshot: Record<string, string> = {};
  if (cause === 'boot') for (const [channel, cursor] of Object.entries(listSlackCursors())) snapshot[channel] = cursor.ts;

  const entry: DowntimeEntry = { from: last, to: now, ms, cause, ...(Object.keys(snapshot).length ? { slackCursors: snapshot } : {}) };
  const entries = [...listDowntime(), entry].slice(-DOWNTIME_HISTORY_MAX);
  writeJsonAtomic(DOWNTIME_FILE, { entries } satisfies DowntimeFile);
  console.log(`[downtime] ${cause} gap of ${Math.round(ms / 60_000)}m recorded — down from ${new Date(last).toISOString()} to ${new Date(now).toISOString()}`);
  return entry;
}

/**
 * Compare the last heartbeat against boot time and, if the gap is real, record it. Returns the
 * entry it recorded, or null — a clean restart (and a first-ever boot, which has no heartbeat to
 * measure from) records NOTHING, so the ledger only ever contains genuine outages.
 */
export function recordBootGap(bootTime = Date.now()): DowntimeEntry | null {
  const last = readHeartbeat();
  // Write the new heartbeat regardless: whatever we conclude, this process is alive now.
  writeHeartbeat(bootTime);
  if (last === null) return null;
  return recordGap(last, bootTime, 'boot');
}

/**
 * One heartbeat tick: stamp liveness, and record an outage if the tick is late past the threshold.
 *
 * The reference point is the PERSISTED heartbeat — the same value `recordBootGap()` measures from,
 * so boot and suspend can never disagree about where the last proven-alive moment was, and can
 * never double-record one outage: whichever check sees the gap first advances the stamp, and the
 * other then measures from the new one.
 *
 * A long suspend yields ONE entry, not one per missed interval, because a frozen process fires no
 * timers while it sleeps — `setInterval` does not accumulate a backlog of missed ticks — and even
 * if it did, this writes the heartbeat forward before the next tick can compare.
 */
export function recordTickGap(now = Date.now()): DowntimeEntry | null {
  const last = readHeartbeat();
  writeHeartbeat(now);
  if (last === null) return null;
  return recordGap(last, now, 'suspend');
}

// ── Slack last-seen cursors ───────────────────────────────────────────────────────────────────

/** channelId → { ts: last message ts we observed, at: when we observed it }. */
export interface SlackCursor { ts: string; at: number }
type SlackCursors = Record<string, SlackCursor>;

export function listSlackCursors(): SlackCursors {
  return readJson<SlackCursors>(SLACK_CURSORS_FILE, {});
}

/**
 * Record that we saw `ts` in `channel`. Called for every inbound Slack message the ingress hands
 * us (whether or not the agent chose to answer it) — it is a LIVE TAIL pointer: it says where the
 * stream is now, not what was handled, and after a recovery it runs ahead of the outage backlog
 * within one message (which is why an outage snapshots it, see `DowntimeEntry.slackCursors`).
 * Monotonic: an out-of-order event can't rewind the cursor and cause a re-fetch of already-seen
 * history. Slack ts values carry 16 significant digits, so they are compared as STRINGS — `Number`
 * rounds them to a double and makes same-second messages compare equal.
 */
export function noteSlackSeen(channel: string, ts: string): void {
  if (!channel || !ts) return;
  try {
    const cursors = listSlackCursors();
    const prev = cursors[channel];
    if (prev && prev.ts >= ts) return;
    cursors[channel] = { ts, at: Date.now() };
    writeJsonAtomic(SLACK_CURSORS_FILE, cursors);
  } catch (err) {
    console.error('[downtime] failed to record Slack cursor:', err);
  }
}

export interface BackfilledMessage {
  channel: string;
  ts: string;
  user?: string;
  botId?: string;
  text: string;
  clientMsgId?: string;
  /** True when the text mentions the agent (bot or user id) — the subset most likely to need action. */
  mentionsAgent: boolean;
}

export interface SlackBackfill {
  /** `truncated` = the page cap was hit with more still waiting, so the OLDEST part of the outage is missing. */
  channels: { channel: string; from: string; fetched: number; truncated?: boolean; error?: string }[];
  messages: BackfilledMessage[];
  skipped?: string;
}

/** Injected so tests (and any future caller) can drive the join without a live Slack workspace. */
export type SlackHistoryFn = (method: string, body: Record<string, unknown>) => Promise<any>;

export interface BackfillOptions {
  /** Defaults to the shared mcp-slack-use client (`slackPost`) — the app's ONE Slack seam. */
  history?: SlackHistoryFn;
  /** Agent ids to flag mentions against. */
  agentIds?: string[];
  /** Safety valve on a very long outage: pages of 200 per channel. */
  maxPages?: number;
  /**
   * channelId → last-seen ts AS OF the outage (`DowntimeEntry.slackCursors`). The live cursors are
   * deliberately NOT used as a floor: they advance with the stream and would skip the backlog.
   */
  cursors?: Record<string, string>;
}

/**
 * Fetch what arrived during `range` from each channel we know about, on demand.
 *
 * Why history and not event replay: Slack's Events API retries a failed delivery for only ~30
 * minutes and then drops the event PERMANENTLY — after a multi-hour outage there is nothing left
 * to redeliver. `conversations.history` keeps the same messages readable for days (retention), so
 * it, not the event stream, is the durable recovery source. This is also why it is on-demand only
 * and never runs at boot: it is a paid, rate-limited read of someone else's system, and its result
 * is a REPORT, not a work queue.
 */
export async function fetchSlackBackfill(range: { from: number; to?: number }, opts: BackfillOptions = {}): Promise<SlackBackfill> {
  // Which channels to ask about: the ones seen at the time of the outage, the ones seen since
  // (a channel that only became active during/after the outage still has missed history), and the
  // agent's own channel — which must be readable on a first deploy, before any traffic at all.
  const snapshot = opts.cursors ?? {};
  const channels = [...new Set([
    ...Object.keys(snapshot),
    ...Object.keys(listSlackCursors()),
    ...(process.env.SLACK_AGENT_CHANNEL ? [process.env.SLACK_AGENT_CHANNEL] : []),
  ])];
  if (!channels.length) return { channels: [], messages: [], skipped: 'no channels seen yet (no cursor recorded, no SLACK_AGENT_CHANNEL)' };

  let history = opts.history;
  let agentIds = (opts.agentIds ?? []).filter(Boolean);
  if (!history) {
    try {
      // The app's ONE Slack seam (slack/api.ts re-exports the mcp-slack-use client). No new HTTP
      // client, no second token-resolution path.
      const api = await import('./slack/api.ts');
      history = (method, body) => api.slackPost(method, body);
      if (!agentIds.length) {
        const ids = await Promise.all([api.getBotUserId().catch(() => null), api.getAgentUserId().catch(() => null)]);
        agentIds = ids.filter((id): id is string => !!id);
      }
    } catch (err) {
      return { channels: [], messages: [], skipped: `Slack client unavailable: ${(err as Error).message}` };
    }
  }

  const maxPages = opts.maxPages ?? 5;
  const out: SlackBackfill = { channels: [], messages: [] };
  const seen = new Set<string>();

  for (const channel of channels) {
    // Start at the outage start, raised only by a SNAPSHOT cursor that is later still (a channel
    // whose last-seen message post-dates `range.from` — we already saw those). Never raised by the
    // live cursor: that one has moved on with the stream and would hide the whole backlog.
    const oldest = Math.max(Number(snapshot[channel]) || 0, range.from / 1000);
    let fetched = 0;
    let pageCursor: string | undefined;
    let error: string | undefined;
    let truncated = false;
    try {
      for (let page = 0; page < maxPages; page++) {
        const body: Record<string, unknown> = { channel, oldest: String(oldest), limit: 200 };
        if (range.to) body.latest = String(range.to / 1000);
        if (pageCursor) body.cursor = pageCursor;
        const res = await history('conversations.history', body);
        if (!res?.ok) { error = String(res?.error ?? 'unknown Slack error'); break; }
        for (const m of (res.messages ?? []) as any[]) {
          // Dedupe on client_msg_id (Slack's own idempotency key), falling back to channel+ts for
          // messages that carry none (bot posts, joins). Paging overlap and a re-run of this
          // report must not double-report the same message.
          const key = m.client_msg_id ?? `${channel}:${m.ts}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const text = String(m.text ?? '');
          out.messages.push({
            channel,
            ts: String(m.ts),
            user: m.user,
            botId: m.bot_id,
            text,
            clientMsgId: m.client_msg_id,
            mentionsAgent: agentIds.some(id => text.includes(id)),
          });
          fetched++;
        }
        pageCursor = res.response_metadata?.next_cursor || undefined;
        if (!res.has_more || !pageCursor) break;
        // Still more waiting when the cap is reached: say so. conversations.history returns
        // NEWEST-first, so what we dropped is the START of the outage — the oldest and most likely
        // to have been missed. A silently short report would read as "that's everything".
        if (page === maxPages - 1) truncated = true;
      }
    } catch (err) {
      error = (err as Error).message;
    }
    out.channels.push({ channel, from: String(oldest), fetched, ...(truncated ? { truncated } : {}), ...(error ? { error } : {}) });
  }
  out.messages.sort((a, b) => Number(a.ts) - Number(b.ts));
  return out;
}

// ── the on-demand report ──────────────────────────────────────────────────────────────────────

export interface MissedScheduleReport {
  id: string;
  name: string;
  missedRun: MissedRun;
  /** The outage this window falls inside, if any. */
  downtime: DowntimeEntry | null;
  /** What the USER can choose to do. Nothing here runs it. */
  proposal: string;
}

export interface DowntimeReport {
  now: number;
  heartbeat: { at: number; ageMs: number } | null;
  downtime: DowntimeEntry[];
  lastDowntime: DowntimeEntry | null;
  missedSchedules: MissedScheduleReport[];
  slack?: SlackBackfill;
  note: string;
}

/**
 * Join phase 1's `missedRun` records to the outage that covers them.
 *
 * It does NOT recompute which windows were missed — the scheduler owns that decision (policy +
 * staleness ceiling) and re-deriving it here would be a second, silently-diverging opinion.
 *
 * Read from schedules.json rather than the engine's in-memory list: the engine `saveSchedules()`
 * on every mutation (incl. `noteMissed`), so disk is current, and reading it keeps this module
 * independent of whether the engine has been started — which matters because a passive twin and
 * this report both need the answer without owning the scheduler.
 */
export function missedSchedules(entries = listDowntime()): MissedScheduleReport[] {
  return loadSchedules()
    .filter((s): s is typeof s & { missedRun: MissedRun } => !!s.missedRun)
    .map((s) => ({
      id: s.id,
      name: s.name,
      missedRun: s.missedRun,
      downtime: entries.find(e => s.missedRun.at >= e.from && s.missedRun.at <= e.to) ?? null,
      proposal: `POST /api/schedules/${s.id}/run to run this window now (nothing has run it)`,
    }));
}

/**
 * Build the "what did I miss?" answer. Read-only apart from the Slack fetch, which is a read of
 * Slack. Callers pass `slack: false` to skip the network entirely.
 */
export async function buildReport(opts: { slack?: boolean; backfill?: BackfillOptions } = {}): Promise<DowntimeReport> {
  const now = Date.now();
  const entries = listDowntime();
  const last = entries[entries.length - 1] ?? null;
  const hb = readHeartbeat();
  const report: DowntimeReport = {
    now,
    heartbeat: hb === null ? null : { at: hb, ageMs: now - hb },
    downtime: entries,
    lastDowntime: last,
    missedSchedules: missedSchedules(entries),
    note: 'Report only — nothing here has been run, answered, or replayed. Act on an item explicitly.',
  };
  // A suspend gap froze the process instead of killing it, so the scheduler's boot-time catch-up
  // scan never ran. The late timer fire on wake DOES record the windows it refuses, so the list is
  // not empty — it is INCOMPLETE: it holds only what that fire judged. Say that, and say it for
  // every recent suspend, not just the newest entry: a restart afterwards appends a `boot` entry
  // but scans nothing retroactively, so gating on `last` would silently drop the warning.
  const suspends = entries.filter(e => e.cause === 'suspend' && now - e.to <= SUSPEND_NOTE_MAX_AGE_MS);
  if (suspends.length) {
    const when = suspends.map(e => `${new Date(e.from).toISOString()}→${new Date(e.to).toISOString()}`).join(', ');
    report.note += ` NOTE: a recent outage was a host SUSPEND (the process was frozen, not restarted: ${when}), so no scheduler catch-up scan ran. missedSchedules is INCOMPLETE for that gap — it lists only the windows the late timer fire itself judged on wake; any other window that elapsed inside the gap left no record at all. Check schedules whose window falls in the gap by hand.`;
  }
  if (opts.slack !== false) {
    report.slack = last
      // The snapshot frozen at boot, not the live cursors — see DowntimeEntry.slackCursors.
      ? await fetchSlackBackfill({ from: last.from }, { cursors: last.slackCursors, ...opts.backfill })
      : { channels: [], messages: [], skipped: 'no recorded downtime to backfill' };
    const cut = report.slack.channels.filter(c => c.truncated).map(c => c.channel);
    if (cut.length) report.note += ` INCOMPLETE: hit the page cap on ${cut.join(', ')} — the OLDEST part of the outage is missing from this report.`;
  }
  return report;
}
