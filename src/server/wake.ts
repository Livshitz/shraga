// Waking a session from out-of-band work — "something finished while nobody was in the turn,
// tell the user, wherever that session speaks".
//
// Every async subsystem that resolves after its turn is over needs the SAME tail: persist the
// trigger as a user-channel message, run one agent turn on it, persist + broadcast the reply,
// mark it unread, and relay to the Slack thread when the session has one. polls.ts grew it first
// ("close then report"); background-jobs.ts needs it verbatim, so it lives here instead of twice.
//
// Decoupled from claude.ts via injected runners (see initWake) — same IoC polls.ts used, for the
// same reason (claude.ts ← → subsystem import cycle).
import { appendMessage, getSession, type ConvBlock } from './sessions.ts';
import { addUnread } from './unread.ts';
import { postMessage } from './slack/api.ts';
import { findSlackSessionBySessionId } from './slack/sessions.ts';

const PREFIX = '[wake]';

export type TurnRunner = (args: { prompt: string; sessionId: string; uid: string; userEmail?: string }) => Promise<ConvBlock[]>;

let runTurn: TurnRunner | null = null;
let broadcastFn: ((ev: object) => void) | null = null;

export function initWake(deps: { runTurn: TurnRunner; broadcast: (ev: object) => void }): void {
  runTurn = deps.runTurn;
  broadcastFn = deps.broadcast;
}

/** True once boot has wired a turn runner. Callers that can degrade (deliver raw text instead of
 *  running a turn) check this rather than silently dropping their report. */
export function wakeReady(): boolean { return !!runTurn; }

export function broadcastSessionChanged(sessionId: string): void {
  broadcastFn?.({ type: 'session_messages_changed', sessionId });
}

/**
 * Put `text` into the session as an assistant message and push it to every surface that session
 * speaks on (web stream + unread badge, and the Slack thread when one is mapped).
 *
 * This is the delivery half on its own: used directly when we must report WITHOUT running a turn
 * (no runner wired, or the session stayed busy past the defer cap) so the outcome is still visible
 * rather than silently dropped.
 */
export async function deliverToSession(i: { sessionId: string; uid: string; text: string; title?: string }): Promise<void> {
  const text = i.text.trim();
  if (!text) return;
  appendMessage(i.sessionId, { id: crypto.randomUUID(), role: 'assistant', blocks: [{ type: 'text', text }] });
  broadcastSessionChanged(i.sessionId);
  addUnread(i.uid, i.sessionId, text.slice(0, 120), 'proactive', i.title);
  const slack = findSlackSessionBySessionId(i.sessionId);
  if (slack) await postMessage(slack.channel, text, slack.threadTs, slack.useUserToken)
    .catch((e) => console.error(`${PREFIX} slack deliver failed:`, (e as Error)?.message));
}

export type WakeOutcome = 'woke' | 'no-session' | 'not-ready' | 'no-output';

/**
 * Run one agent turn on `prompt` in an existing session and deliver whatever it says.
 *
 * The caller is responsible for NOT calling this while a turn is already streaming in that
 * session (see isSessionLocked) — two concurrent turns would interleave into one transcript.
 */
export async function wakeSession(i: {
  sessionId: string; uid: string; userEmail?: string;
  prompt: string;
  /** Message channel tag for the injected trigger (e.g. 'poll', 'job') — shows provenance in the thread. */
  channel: string;
  /** Unread-badge title. */
  title?: string;
  /** Badge text to use when the turn ran but produced no TEXT block. Without it such a turn is
   *  reported as 'no-output' and raises no badge — but a turn whose only block is `{type:'error'}`
   *  is precisely when the user most needs telling. Callers that can degrade some other way (jobs
   *  fall back to a raw report) leave this unset and handle 'no-output' themselves. */
  unreadFallback?: string;
}): Promise<WakeOutcome> {
  if (!runTurn) { console.warn(`${PREFIX} no turn runner; cannot wake ${i.sessionId}`); return 'not-ready'; }
  if (!getSession(i.sessionId)) { console.warn(`${PREFIX} session ${i.sessionId} gone; skipping wake`); return 'no-session'; }

  appendMessage(i.sessionId, { id: crypto.randomUUID(), role: 'user', blocks: [{ type: 'text', text: i.prompt }], channel: i.channel });
  broadcastSessionChanged(i.sessionId);

  const blocks = await runTurn({ prompt: i.prompt, sessionId: i.sessionId, uid: i.uid, userEmail: i.userEmail });
  if (!blocks.length) return 'no-output';
  appendMessage(i.sessionId, { id: crypto.randomUUID(), role: 'assistant', blocks });
  broadcastSessionChanged(i.sessionId);

  const text = blocks.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map((b) => b.text).join('\n\n').trim();
  if (!text && !i.unreadFallback) return 'no-output';
  addUnread(i.uid, i.sessionId, text.slice(0, 120) || i.unreadFallback!, 'proactive', i.title);
  const slack = findSlackSessionBySessionId(i.sessionId);
  // Nothing to say out loud when there is no text — but the badge above still went up.
  if (slack && text) await postMessage(slack.channel, text, slack.threadTs, slack.useUserToken)
    .catch((e) => console.error(`${PREFIX} slack deliver failed:`, (e as Error)?.message));
  return text ? 'woke' : 'no-output';
}
