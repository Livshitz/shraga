import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, statSync, renameSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { DATA_DIR, dataPath } from './paths.ts';
import type { Directives } from './directives.ts';

const SESSIONS_PATH = dataPath('sessions.json');

export interface SessionMeta {
  sessionId: string;
  title: string;
  userEmail: string;
  userName: string;
  uid: string;
  createdAt: number;
  lastModified: number;
  autoApprove?: boolean;
  /** Visibility: 'system' is shared across whitelisted users; 'user' (default) is private to `uid`. */
  scope?: 'system' | 'user';
  /** 'terminal' = a PTY-only session (created to host a standalone/terminal-first shell); hidden from
   * the conversation list until it receives a real prompt (then it graduates to a normal conversation). */
  kind?: 'terminal';
  scheduleId?: string;
  scheduleRunAt?: number;
  scheduleRunStatus?: 'running' | 'ok' | 'error' | 'aborted';
  slackContext?: { type: 'dm' | 'channel' | 'mention'; channelName?: string; userName?: string };
  /** Slack message ts values already merged into this session's context (dedup for thread sync). */
  seenSlackTs?: string[];
  /** Skill names trigger-matched earlier in this session — re-injected on every subsequent turn. */
  triggeredSkills?: string[];
  /** Emails allowed to see this session (lowercase). Checked in addition to uid/scope. */
  visibleTo?: string[];
  runStatus?: 'running' | 'idle';
  runOrigin?: 'web' | 'slack' | 'scheduler' | 'gmail';
  lastStopReason?: 'max_turns_reached' | 'error' | 'aborted';
  runRetryCount?: number;
  directives?: Directives;
  /** Actual model the engine resolved at runtime (from the SDK init message) — ground truth, unlike directives.model which is the request. */
  lastModel?: string;
  /** Engine that actually ran the last turn — ground truth beside `lastModel`, so the UI can report
   *  what executed instead of inferring the engine from the model id's shape. */
  lastEngine?: string;
  forkedFrom?: string;
}

// ── Index cache ──────────────────────────────────────────────────────────────
// The index is ~9 MB / 12.8k records on the Circles box. Every mutation used to readFileSync +
// JSON.parse the whole file and then stringify + write it back, SYNCHRONOUSLY (~260 ms per
// mutation on a 2-vCPU host, and a turn does several), so the event loop stalled on bookkeeping.
//
// Single-writer, deliberately: the HTTP server, its scheduler and the MCP surface all run in ONE
// bun process (`src/server/index.ts` → boot.ts, which mounts the MCP in-process; the only spawned
// children are vendor MCP sidecars and background-job shells, none of which import this module).
// data-sync cannot touch it either — `sessions.json` is in the data repo's canonical .gitignore,
// so its pull/reset/stash never sees the file. The one out-of-band writer is the manual
// `defaults/scripts/backfill-slack-usernames.ts`, and this cache does NOT make that safe:
//
//   The mtime guard below only runs when the cache is CLEAN. `loadIndex()` short-circuits on
//   `if (dirty) return cache` first, so while a flush is pending the server neither sees an
//   external edit nor survives it — the next flushIndex() writes the whole in-memory cache over
//   the file, and the backfill's work is gone. The guard buys exactly one thing over the old
//   read-every-time behaviour: an external edit made while nothing is pending IS picked up.
//   Fixing the pending-flush case needs a merge or a lock, i.e. a multi-process protocol, which
//   this file deliberately does not have. flushIndex() detects the clobber and logs it loudly
//   instead of losing it silently — run the backfill with the server stopped.
let cache: SessionMeta[] | null = null;
let cacheMtimeMs = -1;
let dirty = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Coalescing window for the 9 MB write.
 *
 * Durability trade, stated explicitly: a crash can lose at most this much session BOOKKEEPING —
 * runStatus, lastModified, seenSlackTs, triggeredSkills. Conversation content is not in this file
 * (it lives in `data/conversations/`), so no user-visible message can be lost here. Every exit
 * path we control flushes synchronously (`process.on('exit')` — reached by the SIGTERM/SIGINT
 * graceful shutdown, which ends in process.exit — plus setShuttingDown() at the top of the drain),
 * so the exposure is a SIGKILL or power loss inside a 250 ms window. Taken over the alternative:
 * a ~260 ms sync stall on every single mutation.
 */
const FLUSH_DEBOUNCE_MS = 250;

function loadIndex(): SessionMeta[] {
  if (cache) {
    if (dirty) return cache; // memory is ahead of disk — we are the authority
    try {
      if (statSync(SESSIONS_PATH).mtimeMs === cacheMtimeMs) return cache;
    } catch {
      return cache; // file vanished mid-run; keep serving what we have
    }
  }
  if (!existsSync(SESSIONS_PATH)) return (cache = []);
  try {
    cache = JSON.parse(readFileSync(SESSIONS_PATH, 'utf-8'));
    cacheMtimeMs = statSync(SESSIONS_PATH).mtimeMs;
  } catch (err) {
    console.error('[sessions] index unreadable, serving an empty list:', (err as Error).message);
    cache = [];
  }
  return cache!;
}

function saveIndex(sessions: SessionMeta[]): void {
  cache = sessions;
  dirty = true;
  if (!flushTimer) scheduleFlush();
}

function scheduleFlush(): void {
  const t = setTimeout(flushIndex, FLUSH_DEBOUNCE_MS);
  (t as { unref?: () => void }).unref?.(); // never hold the process open for bookkeeping
  flushTimer = t;
}

/**
 * Write the index to disk now. Atomic (tmp + rename): the old truncate-in-place write left a
 * half-written 9 MB file if it was interrupted, and loadIndex's catch turned that into an EMPTY
 * session list — a silent total loss of the index.
 */
export function flushIndex(): void {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (!dirty || !cache) return;
  dirty = false;
  const tmp = `${SESSIONS_PATH}.tmp`;
  try {
    // Someone wrote the file behind us while this flush was pending (see the cache note above).
    // We cannot merge without a multi-process protocol, so at least never lose it silently.
    try {
      const onDisk = statSync(SESSIONS_PATH).mtimeMs;
      if (cacheMtimeMs >= 0 && onDisk !== cacheMtimeMs) {
        console.error(`[sessions] index changed on disk (mtime ${onDisk} != ${cacheMtimeMs}) while a flush was pending — overwriting that external edit`);
      }
    } catch { /* file absent: nothing to clobber */ }
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(tmp, JSON.stringify(cache)); // no pretty-print: 9 MB nobody reads by hand
    renameSync(tmp, SESSIONS_PATH);
    cacheMtimeMs = statSync(SESSIONS_PATH).mtimeMs;
  } catch (err) {
    console.error('[sessions] index flush failed, retrying on the next tick:', (err as Error).message);
    dirty = true;
    scheduleFlush();
  }
}

// Covers the graceful-shutdown paths (SIGTERM/SIGINT end in process.exit) and any normal exit,
// without adding signal listeners that would change the process's default signal semantics.
process.on('exit', () => flushIndex());

/**
 * The subset of SessionMeta the conversation list actually renders. `triggeredSkills` (381 KB) and
 * `seenSlackTs` (174 KB) are server bookkeeping and must never be shipped to a browser; the full
 * record is still available per-session from /api/sessions/:id/meta.
 */
export interface SessionListItem {
  sessionId: string;
  title: string;
  userName: string;
  lastModified: number;
  slackContext?: SessionMeta['slackContext'];
  runStatus?: SessionMeta['runStatus'];
  lastStopReason?: SessionMeta['lastStopReason'];
  scheduleRunStatus?: SessionMeta['scheduleRunStatus'];
  /** Owned by (or explicitly shared with) the caller. Stamped per-request: the trimmed row drops
   *  `uid`/`visibleTo`, so without it the client cannot scope anything by "mine". */
  mine?: boolean;
}

/** The `mine` predicate, shared by the list filter and the per-row stamp so they cannot drift. */
export function isOwnSession(s: SessionMeta, uid: string, email: string): boolean {
  return s.uid === uid || !!s.visibleTo?.includes(email);
}

export function toListItem(s: SessionMeta, mine?: boolean): SessionListItem {
  return {
    sessionId: s.sessionId,
    title: s.title,
    userName: s.userName,
    lastModified: s.lastModified,
    ...(s.slackContext ? { slackContext: s.slackContext } : {}),
    ...(s.runStatus ? { runStatus: s.runStatus } : {}),
    ...(s.lastStopReason ? { lastStopReason: s.lastStopReason } : {}),
    ...(s.scheduleRunStatus ? { scheduleRunStatus: s.scheduleRunStatus } : {}),
    ...(mine === undefined ? {} : { mine }),
  };
}

function summarize(prompt: string): string {
  const cleaned = prompt.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= 80) return cleaned;
  return cleaned.slice(0, 77) + '…';
}

export function upsertSession(sessionId: string, firstPrompt: string, user: { uid: string; email: string; name?: string }, scope?: 'system' | 'user', kind?: 'terminal'): void {
  const sessions = loadIndex();
  const existing = sessions.find((s) => s.sessionId === sessionId);
  const now = Date.now();

  if (existing) {
    existing.lastModified = now;
    if (!existing.title || existing.title === 'New session') {
      existing.title = summarize(firstPrompt);
    }
    // A terminal-only session that now receives a real prompt graduates to a normal conversation.
    if (existing.kind === 'terminal' && kind !== 'terminal') delete existing.kind;
  } else {
    sessions.unshift({
      sessionId,
      title: summarize(firstPrompt),
      userEmail: user.email,
      userName: user.name || user.email.split('@')[0],
      uid: user.uid,
      createdAt: now,
      lastModified: now,
      ...(scope ? { scope } : {}),
      ...(kind ? { kind } : {}),
    });
  }

  saveIndex(sessions);
}

export function setSlackContext(sessionId: string, ctx: NonNullable<SessionMeta['slackContext']>): void {
  const sessions = loadIndex();
  const s = sessions.find((s) => s.sessionId === sessionId);
  if (s) {
    s.slackContext = ctx;
    saveIndex(sessions);
  }
}

/** Record Slack ts values as merged into this session's context (dedup for thread sync). */
export function recordSeenSlackTs(sessionId: string, ts: string[]): void {
  if (!ts.length) return;
  const sessions = loadIndex();
  const s = sessions.find((s) => s.sessionId === sessionId);
  if (!s) return;
  const set = new Set(s.seenSlackTs ?? []);
  for (const t of ts) set.add(t);
  s.seenSlackTs = [...set];
  saveIndex(sessions);
}

/** Persist trigger-matched skill names so they stay injected for the rest of the session. */
export function addTriggeredSkills(sessionId: string, names: string[]): void {
  if (!names.length) return;
  const sessions = loadIndex();
  const s = sessions.find((s) => s.sessionId === sessionId);
  if (!s) return;
  const merged = [...new Set([...(s.triggeredSkills ?? []), ...names])];
  if (merged.length === (s.triggeredSkills?.length ?? 0)) return;
  s.triggeredSkills = merged;
  saveIndex(sessions);
}

/**
 * Stable pagination cursor: lastModified alone is not unique across 12k sessions, and a paging
 * cursor that only carries the timestamp drops or repeats every record in a tie.
 */
export function sessionCursor(s: SessionMeta | SessionListItem): string {
  return `${String(s.lastModified).padStart(16, '0')}.${s.sessionId}`;
}

/**
 * One page of an already-sorted (getAllSessions order) list, newest first. `before` is the cursor
 * from the previous page's `nextCursor`; it is composite (lastModified + sessionId) because
 * lastModified alone is not unique and a timestamp-only cursor drops or repeats records on a tie.
 */
export function pageSessions(list: SessionMeta[], opts: { limit: number; before?: string; mine?: (s: SessionMeta) => boolean }): { sessions: SessionListItem[]; nextCursor: string | null } {
  const rest = opts.before ? list.filter((s) => sessionCursor(s) < opts.before!) : list;
  const page = rest.slice(0, opts.limit);
  return {
    sessions: page.map((s) => toListItem(s, opts.mine?.(s))),
    nextCursor: rest.length > page.length ? sessionCursor(page[page.length - 1]) : null,
  };
}

export function getAllSessions(): SessionMeta[] {
  // Copy before sorting: loadIndex() now returns the live cache array, and an in-place sort here
  // would silently reorder the store for every other caller. Sorted by the same composite key the
  // pagination cursor uses, so `cursor < before` is exactly consistent with this order.
  return [...loadIndex()].sort((a, b) => b.lastModified - a.lastModified || (a.sessionId < b.sessionId ? 1 : a.sessionId > b.sessionId ? -1 : 0));
}

export function isSessionVisibleTo(s: SessionMeta, uid: string, isOwner = false, email?: string): boolean {
  if (isOwner) return true;
  if (s.scope === 'system') return true;
  if (s.visibleTo && email && s.visibleTo.includes(email.toLowerCase())) return true;
  return s.uid === uid;
}

export function getSessionsVisibleTo(uid: string, isOwner = false, email?: string): SessionMeta[] {
  return getAllSessions().filter((s) => isSessionVisibleTo(s, uid, isOwner, email));
}

export function setVisibleTo(sessionId: string, emails: string[]): void {
  const sessions = loadIndex();
  const s = sessions.find((s) => s.sessionId === sessionId);
  if (s) {
    s.visibleTo = emails.map((e) => e.toLowerCase());
    saveIndex(sessions);
  }
}

export function getSession(sessionId: string): SessionMeta | undefined {
  return loadIndex().find((s) => s.sessionId === sessionId);
}

export function updateSessionTitle(sessionId: string, title: string): void {
  const sessions = loadIndex();
  const s = sessions.find((s) => s.sessionId === sessionId);
  if (s) {
    s.title = title;
    saveIndex(sessions);
  }
}

export async function generateSessionTitle(sessionId: string, userPrompt: string, assistantText: string): Promise<string | null> {
  try {
    const { runTextQuery } = await import('./sdk-utils.ts');
    const title = await runTextQuery({
      prompt: `Generate a very short title (3-6 words, no quotes) for this conversation:\n\nUser: ${userPrompt.slice(0, 300)}\nAssistant: ${assistantText.slice(0, 500)}`,
      systemPrompt: 'You generate concise conversation titles. Reply with ONLY the title, nothing else. No quotes, no punctuation at the end.',
    });
    const cleaned = title.trim().replace(/^["']|["']$/g, '').replace(/\.+$/, '');
    if (!cleaned) return null;
    updateSessionTitle(sessionId, cleaned);
    return cleaned;
  } catch (err: any) {
    console.error(`[sessions] Title generation failed for ${sessionId.slice(0, 8)}:`, err.message);
    return null;
  }
}

export function setSessionDirectives(sessionId: string, directives: NonNullable<SessionMeta['directives']>): void {
  const sessions = loadIndex();
  const s = sessions.find((s) => s.sessionId === sessionId);
  if (s) {
    // COPY, don't alias. streamChat() stores its working `directives` object here and then keeps
    // mutating it for the rest of the turn (the per-skill turn budget is gap-filled afterwards).
    // While the index was re-parsed from disk on every read that leak was invisible; against an
    // in-memory store it would silently PIN a skill's 250-turn budget onto the session forever.
    s.directives = { ...directives };
    saveIndex(sessions);
  }
}

// Resolved model per running session (set by the engine from the SDK init message).
// appendMessage stamps assistant messages from this map so every channel records it.
const liveModels = new Map<string, string>();
const liveEngines = new Map<string, string>();

/** Last resolved model for a session (live map first, then persisted lastModel). */
export function getSessionModel(sessionId: string): string | undefined {
  return liveModels.get(sessionId) ?? loadIndex().find((s) => s.sessionId === sessionId)?.lastModel;
}

/** Record the runtime ground truth for a turn. `engine` is the engine that actually ran it — the
 *  pair is what the header reports, so neither half may be inferred from the other. */
export function setSessionModel(sessionId: string, model: string, engine?: string): void {
  if (liveModels.get(sessionId) === model && (!engine || liveEngines.get(sessionId) === engine)) return;
  liveModels.set(sessionId, model);
  if (engine) liveEngines.set(sessionId, engine);
  const sessions = loadIndex();
  const s = sessions.find((s) => s.sessionId === sessionId);
  if (s && (s.lastModel !== model || (engine && s.lastEngine !== engine))) {
    s.lastModel = model;
    if (engine) s.lastEngine = engine;
    saveIndex(sessions);
  }
}

export function getSessionsByScheduleId(scheduleId: string): SessionMeta[] {
  return loadIndex()
    .filter((s) => s.scheduleId === scheduleId)
    .sort((a, b) => b.lastModified - a.lastModified);
}

export function createScheduledSession(sessionId: string, scheduleId: string, title: string, createdBy: { uid: string; email: string }, scope: 'system' | 'user' = 'user'): void {
  const sessions = loadIndex();
  if (sessions.find((s) => s.sessionId === sessionId)) return;
  const now = Date.now();
  sessions.unshift({
    sessionId,
    title,
    userEmail: createdBy.email,
    userName: createdBy.email.split('@')[0],
    uid: createdBy.uid,
    createdAt: now,
    lastModified: now,
    scope,
    scheduleId,
    scheduleRunAt: now,
    scheduleRunStatus: 'running',
  });
  saveIndex(sessions);
}

export function updateScheduledSessionStatus(sessionId: string, status: 'ok' | 'error' | 'aborted'): void {
  const sessions = loadIndex();
  const s = sessions.find((x) => x.sessionId === sessionId);
  if (!s) return;
  s.scheduleRunStatus = status;
  s.lastModified = Date.now();
  saveIndex(sessions);
}

export function getAutoApprove(uid: string): boolean {
  const sessions = loadIndex();
  const userSession = sessions.find((s) => s.uid === uid);
  return userSession?.autoApprove ?? false;
}

export function setAutoApprove(uid: string, value: boolean): void {
  const sessions = loadIndex();
  // Set on all sessions for this user
  let found = false;
  for (const s of sessions) {
    if (s.uid === uid) {
      s.autoApprove = value;
      found = true;
    }
  }
  if (found) saveIndex(sessions);
}

let _shuttingDown = false;
export function setShuttingDown(): void { _shuttingDown = true; flushIndex(); }

export function setRunStatus(sessionId: string, status: 'running' | 'idle', origin?: 'web' | 'slack' | 'scheduler' | 'gmail', stopReason?: SessionMeta['lastStopReason']): void {
  if (_shuttingDown && status === 'idle') return;
  const sessions = loadIndex();
  const s = sessions.find((x) => x.sessionId === sessionId);
  if (!s) return;
  s.runStatus = status;
  if (origin) s.runOrigin = origin;
  if (status === 'idle') {
    s.lastStopReason = stopReason;
    // runRetryCount caps crash-resume loops (interrupt → resume → interrupt). Reaching 'idle' at all
    // proves this turn was NOT killed by a restart — the guard above drops idle writes during a
    // drain, and a hard kill never gets here — so the loop is broken and the count starts over.
    // It used to be reset only on the web path, so Slack and scheduler sessions accumulated it
    // forever: after two interruptions in their whole life they permanently lost auto-resume and
    // every later restart ended at "please send a message to continue".
    s.runRetryCount = 0;
  }
  s.lastModified = Date.now();
  saveIndex(sessions);
}

export function incrementRetryCount(sessionId: string): void {
  const sessions = loadIndex();
  const s = sessions.find((x) => x.sessionId === sessionId);
  if (!s) return;
  s.runRetryCount = (s.runRetryCount ?? 0) + 1;
  saveIndex(sessions);
}

export function resetRetryCount(sessionId: string): void {
  const sessions = loadIndex();
  const s = sessions.find((x) => x.sessionId === sessionId);
  if (!s || !s.runRetryCount) return;
  s.runRetryCount = 0;
  saveIndex(sessions);
}

export function getRunningSessions(): SessionMeta[] {
  return loadIndex().filter((s) => s.runStatus === 'running');
}

// ── Global session lock ─────────────────────────────────────────────────────
// Single source of truth for "is a session currently running a query?"
// All paths (WebSocket, Slack, REST API, scheduler) must acquire before streaming.

interface SessionLock {
  origin: 'web' | 'slack' | 'scheduler' | 'api';
  abortController: AbortController;
  startedAt: number;
}

const globalSessionLocks = new Map<string, SessionLock>();

export function acquireSessionLock(sessionId: string, origin: SessionLock['origin'], abortController: AbortController): boolean {
  if (globalSessionLocks.has(sessionId)) return false;
  globalSessionLocks.set(sessionId, { origin, abortController, startedAt: Date.now() });
  return true;
}

export function releaseSessionLock(sessionId: string, owner?: AbortController): boolean {
  if (owner) {
    const lock = globalSessionLocks.get(sessionId);
    if (lock && lock.abortController !== owner) return false;
  }
  globalSessionLocks.delete(sessionId);
  return true;
}

export function isSessionLocked(sessionId: string): boolean {
  return globalSessionLocks.has(sessionId);
}

/** Count of queries streaming in THIS process right now. The drain loop must use this, not the
 *  persisted index: setRunStatus freezes `running` at shutdown as the crash-recovery marker, so
 *  index entries can't go idle mid-drain (and stale entries from a prior crash would stall the
 *  drain for sessions that aren't streaming at all). */
export function getActiveLockCount(): number {
  return globalSessionLocks.size;
}

export function replaceSessionLock(sessionId: string, origin: SessionLock['origin'], abortController: AbortController): void {
  globalSessionLocks.set(sessionId, { origin, abortController, startedAt: Date.now() });
}

export function getSessionAbortController(sessionId: string): AbortController | undefined {
  return globalSessionLocks.get(sessionId)?.abortController;
}

const CLAUDE_PROJECTS_DIR = path.join(homedir(), '.claude', 'projects');

function findSessionFile(sessionId: string): string | null {
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return null;
  for (const dir of readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const file = path.join(CLAUDE_PROJECTS_DIR, dir.name, `${sessionId}.jsonl`);
    if (existsSync(file)) return file;
  }
  return null;
}

// ── Our own conversation store ───────────────────────────────────────────────

export type ConvBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; src: string }
  | { type: 'file'; src: string; name: string; mimeType: string }
  | { type: 'context'; label: string; text: string }
  | { type: 'tool_use'; tool: string; toolUseId: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; output: string }
  | { type: 'thinking'; text: string }
  // A run that failed at the engine/adapter level. Persisted so the transcript records the failure
  // durably — otherwise a dead session (esp. an unattended scheduled one) is indistinguishable from
  // one still thinking, with the cause only in stderr.
  | { type: 'error'; text: string }
  // Persisted block written by an add-on engine's background worker (e.g. EE's duplex voice brain).
  // The core stores/renders it but owns none of its semantics; name kept for stored-history back-compat.
  | { type: 'duplex_result'; label?: string; tier?: string; text?: string }
  | { type: 'summary'; text: string; compactedCount: number }
  | { type: 'compact_marker'; summary: string; compactedCount: number };

export interface ConvMessage {
  id: string;
  // 'system' is written for out-of-band notices persisted into the thread (e.g. a playback
  // interruption). History builders treat any non-'user' role as assistant-side.
  role: 'user' | 'assistant' | 'system';
  blocks: ConvBlock[];
  channel?: string;
  ts?: number;
  senderName?: string;
  /** Model that produced this assistant message (stamped from the engine's resolved model). */
  model?: string;
}

const CONV_DIR = dataPath('conversations');

export function loadConversation(sessionId: string): ConvMessage[] {
  const file = path.join(CONV_DIR, `${sessionId}.jsonl`);
  if (!existsSync(file)) return [];
  const messages: ConvMessage[] = [];
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    if (!line) continue;
    try { messages.push(JSON.parse(line)); } catch {
      console.warn(`[sessions] skipping bad JSONL line in ${sessionId.slice(0, 8)}`);
    }
  }
  return messages;
}

export function saveConversation(sessionId: string, messages: ConvMessage[]): void {
  mkdirSync(CONV_DIR, { recursive: true });
  const content = messages.length > 0
    ? messages.map((m) => JSON.stringify(m)).join('\n') + '\n'
    : '';
  writeFileSync(path.join(CONV_DIR, `${sessionId}.jsonl`), content);
}

export function appendMessage(sessionId: string, message: ConvMessage): void {
  if (!message.ts) message.ts = Date.now();
  if (message.role === 'assistant' && !message.model) {
    const model = liveModels.get(sessionId);
    if (model) message.model = model;
  }
  mkdirSync(CONV_DIR, { recursive: true });
  const file = path.join(CONV_DIR, `${sessionId}.jsonl`);
  const line = JSON.stringify(message) + '\n';
  appendFileSync(file, line);
}

// ── Live partial registry (in-memory, for real-time reads) ───────────────────

const livePartialCollectors = new Map<string, () => ConvBlock[]>();

export function registerLivePartial(sessionId: string, collector: () => ConvBlock[]): void {
  livePartialCollectors.set(sessionId, collector);
}

export function unregisterLivePartial(sessionId: string): void {
  livePartialCollectors.delete(sessionId);
}

export function readLivePartial(sessionId: string): ConvBlock[] | null {
  const collector = livePartialCollectors.get(sessionId);
  if (!collector) return null;
  const blocks = collector();
  return blocks.length ? blocks : null;
}

// ── Partial flush (survives crashes) ─────────────────────────────────────────

export function writePartial(sessionId: string, blocks: ConvBlock[]): void {
  if (!blocks.length) return;
  mkdirSync(CONV_DIR, { recursive: true });
  writeFileSync(path.join(CONV_DIR, `${sessionId}.partial.json`), JSON.stringify({ blocks, ts: Date.now() }));
}

export function readPartial(sessionId: string): ConvBlock[] | null {
  const file = path.join(CONV_DIR, `${sessionId}.partial.json`);
  if (!existsSync(file)) return null;
  try {
    const data = JSON.parse(readFileSync(file, 'utf-8'));
    return data.blocks ?? null;
  } catch {
    return null;
  }
}

export function clearPartial(sessionId: string): void {
  const file = path.join(CONV_DIR, `${sessionId}.partial.json`);
  try { unlinkSync(file); } catch {}
}

// ── Claude JSONL fallback ────────────────────────────────────────────────────

export async function getSessionHistory(sessionId: string): Promise<any[]> {
  const file = findSessionFile(sessionId);
  if (!file) {
    console.log(`[sessions] no JSONL file found for ${sessionId.slice(0, 8)}`);
    return [];
  }

  try {
    const content = await readFile(file, 'utf-8');
    const messages: any[] = [];
    for (const line of content.split('\n')) {
      if (!line) continue;
      const obj = JSON.parse(line);
      if (obj.type === 'user' || obj.type === 'assistant') {
        messages.push(obj);
      }
    }
    console.log(`[sessions] loaded ${messages.length} messages for ${sessionId.slice(0, 8)} from ${path.basename(path.dirname(file))}`);
    return messages;
  } catch (err: any) {
    console.warn(`[sessions] failed to read ${sessionId.slice(0, 8)}:`, err.message);
    return [];
  }
}

// ── One-time backfill: set visibleTo/scope on legacy bot sessions ───────────

export function forkSession(sourceId: string, user: { uid: string; email: string; name?: string }, truncateAtIndex?: number): string | null {
  const source = getSession(sourceId);
  if (!source) return null;

  const messages = loadConversation(sourceId);
  if (!messages.length) return null;

  const newId = crypto.randomUUID();
  const forkedMessages = truncateAtIndex != null ? messages.slice(0, truncateAtIndex + 1) : messages;
  saveConversation(newId, forkedMessages);

  const sessions = loadIndex();
  const now = Date.now();
  sessions.unshift({
    sessionId: newId,
    title: `Fork: ${source.title}`,
    userEmail: user.email,
    userName: user.name || user.email.split('@')[0],
    uid: user.uid,
    createdAt: now,
    lastModified: now,
    forkedFrom: sourceId,
    ...(source.directives ? { directives: source.directives } : {}),
  });
  saveIndex(sessions);

  return newId;
}

export function backfillSessionVisibility(findContact: (opts: { name?: string }) => { emails: string[] } | null): void {
  const sessions = loadIndex();
  let patched = 0;

  for (const s of sessions) {
    if (s.visibleTo) continue;

    if (s.uid === 'slack-bot') {
      if (s.slackContext?.type === 'dm') {
        s.scope = 'user';
        if (s.slackContext.userName) {
          const contact = findContact({ name: s.slackContext.userName });
          if (contact?.emails.length) {
            s.visibleTo = contact.emails.map((e) => e.toLowerCase());
            patched++;
          }
        }
      } else if (!s.scope || s.scope !== 'system') {
        s.scope = 'system';
        patched++;
      }
    }

    if (s.uid === 'gmail-bot') {
      const conv = loadConversation(s.sessionId);
      const ctxBlock = conv[0]?.blocks?.find((b: any) => b.type === 'context');
      if (ctxBlock && 'text' in ctxBlock) {
        const emails: string[] = [];
        for (const line of (ctxBlock as any).text.split('\n')) {
          if (/^(From|To|Cc):/i.test(line)) {
            for (const m of line.matchAll(/[\w.+-]+@[\w.-]+\.\w+/g)) emails.push(m[0].toLowerCase());
          }
        }
        const botEmail = (process.env.GMAIL_USER_EMAIL || '').toLowerCase();
        const filtered = [...new Set(emails)].filter((e) => e !== botEmail);
        if (filtered.length) {
          s.visibleTo = filtered;
          patched++;
        }
      }
    }
  }

  if (patched > 0) {
    saveIndex(sessions);
    console.log(`[sessions] backfill: patched visibility on ${patched} sessions`);
  }
}
