// Push triggers — wire "everything notable" → PushModule.send, mirroring the
// session-bus IoC pattern: index.ts calls initPushTriggers() at boot with the
// deps it owns (origin, foreground-presence check), then calls the small
// pushTurnDone/pushQuestion hooks from inside the request path. schedule.finished
// is consumed off the event bus. No import of index.ts → no cycle.
//
// Light dedup + per-(uid,kind,session) rate-limit so notable events don't spam.
import { PushModule } from './push.ts';
import { subscribeEvents } from '../events/bus.ts';
import { getSession } from '../sessions.ts';

export type PushKind = 'turn-done' | 'question' | 'schedule';

export interface PushTriggerDeps {
  /** This server's public origin, embedded in `data.instance` for device onTap routing. */
  origin: string;
  /** True if the user has a foreground client actively viewing this session. */
  isForeground: (uid: string, sessionId: string) => boolean;
}

const RATE_MS = 10_000;

let push: PushModule | null = null;
let deps: PushTriggerDeps | null = null;
const lastSent = new Map<string, number>();

export function initPushTriggers(d: PushTriggerDeps): void {
  deps = d;
  push = new PushModule();
  subscribeEvents((evt) => {
    if (evt.source === 'schedule.finished') onScheduleFinished(evt.payload);
  });
  console.log(`[push] triggers initialized (enabled=${push.enabled()}, origin=${d.origin || '<unset>'})`);
}

/** Dedup + rate-limit gate. Returns false if this (uid,kind,session) fired too recently. */
function gate(uid: string, kind: PushKind, sessionId: string): boolean {
  const key = `${uid}:${kind}:${sessionId}`;
  const now = Date.now();
  const last = lastSent.get(key);
  if (last && now - last < RATE_MS) return false;
  lastSent.set(key, now);
  if (lastSent.size > 1000) {
    for (const [k, ts] of lastSent) if (now - ts > RATE_MS * 6) lastSent.delete(k);
  }
  return true;
}

function data(sessionId: string, kind: PushKind): Record<string, unknown> {
  return { instance: deps?.origin || '', session: sessionId, kind };
}

function titleFor(sessionId: string, fallback: string): string {
  return getSession(sessionId)?.title?.trim() || fallback;
}

/** Turn finished (session_busy → false). Owner only; skip if they're looking at this session. */
export function pushTurnDone(uid: string, sessionId: string): void {
  if (!push?.enabled() || !deps) return;
  if (deps.isForeground(uid, sessionId)) return;
  if (!gate(uid, 'turn-done', sessionId)) return;
  void push.send(uid, {
    title: titleFor(sessionId, 'Shraga'),
    body: 'The agent finished responding.',
    data: data(sessionId, 'turn-done'),
  });
}

/** Agent is asking the user a question (AskUserQuestion) — always notable. */
export function pushQuestion(uid: string, sessionId: string): void {
  if (!push?.enabled()) return;
  if (!gate(uid, 'question', sessionId)) return;
  void push.send(uid, {
    title: titleFor(sessionId, 'Shraga'),
    body: 'The agent needs your input.',
    data: data(sessionId, 'question'),
  });
}

function onScheduleFinished(payload: unknown): void {
  if (!push?.enabled()) return;
  const p = (payload || {}) as { scheduleId?: string; name?: string; status?: string; sessionId?: string; error?: string };
  const sessionId = p.sessionId;
  if (!sessionId) return;
  const uid = getSession(sessionId)?.uid;
  if (!uid) return;
  if (!gate(uid, 'schedule', sessionId)) return;
  const body =
    p.status === 'ok'
      ? 'Schedule completed.'
      : p.status === 'aborted'
        ? 'Schedule aborted.'
        : `Schedule failed${p.error ? `: ${p.error.slice(0, 120)}` : '.'}`;
  void push.send(uid, {
    title: p.name || 'Scheduled task',
    body,
    data: data(sessionId, 'schedule'),
  });
}
