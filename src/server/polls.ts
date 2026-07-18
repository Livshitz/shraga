// Proactive Slack poll / directed-question state. The mcp-slack-use `post_slack_poll`
// tool posts the interactive message; shraga owns everything after: vote state, live
// tally updates (chat.update), closing on deadline/quorum/first-answer, and waking the
// originating agent session once with the result ("close then report").
//
// Decoupled from claude.ts via injected runners (see initPolls) to avoid an import cycle.
import { mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { dataPath } from './paths.ts';
import { appendMessage, getSession, type ConvBlock } from './sessions.ts';
import { addUnread } from './unread.ts';
import { postMessage, slackPost, getUserName, buildPollBlocks, type PollSpec } from './slack/api.ts';
import { findSlackSessionBySessionId } from './slack/sessions.ts';

const PREFIX = '[polls]';

export interface PollRecord extends PollSpec {
  channel: string;
  ts: string;
  useUserToken?: boolean;
  votes: Record<string, number[]>; // userId -> chosen option indices
  status: 'open' | 'closed';
  deadlineAt?: number;
  quorum?: number;
  sessionId: string; // originating session to report back to
  uid: string;
  userEmail?: string;
  createdAt: number;
}

// ── IoC: injected by index.ts at startup to avoid a claude.ts <-> polls.ts cycle ──
type TurnRunner = (args: { prompt: string; sessionId: string; uid: string; userEmail?: string }) => Promise<ConvBlock[]>;
let runTurn: TurnRunner | null = null;
let broadcastFn: ((ev: object) => void) | null = null;

export function initPolls(deps: { runTurn: TurnRunner; broadcast: (ev: object) => void }): void {
  runTurn = deps.runTurn;
  broadcastFn = deps.broadcast;
  setInterval(sweep, 60_000);
  console.log(`${PREFIX} sweeper started`);
}

const PRUNE_AFTER_MS = 7 * 24 * 60 * 60_000; // delete closed poll files after 7 days

/** Close polls past their deadline; prune long-closed poll files. */
function sweep(): void {
  const now = Date.now();
  let files: string[];
  try { files = readdirSync(dir()).filter((f) => f.endsWith('.json')); } catch { return; }
  for (const f of files) {
    let p: PollRecord | null = null;
    try { p = JSON.parse(readFileSync(path.join(dir(), f), 'utf-8')) as PollRecord; } catch { continue; }
    if (!p) continue;
    if (p.status === 'open' && p.deadlineAt && now >= p.deadlineAt) {
      closePoll(p.pollId, 'deadline').catch((e) => console.error(`${PREFIX} sweep close failed:`, (e as Error)?.message));
    } else if (p.status === 'closed' && now - p.createdAt > PRUNE_AFTER_MS) {
      try { rmSync(path.join(dir(), f)); } catch { /* ignore */ }
    }
  }
}

// ── Storage ───────────────────────────────────────────────────────────────────
const dir = (): string => { const d = dataPath('polls'); mkdirSync(d, { recursive: true }); return d; };
const file = (id: string): string => path.join(dir(), `${id}.json`);

export function loadPoll(id: string): PollRecord | null {
  try { return JSON.parse(readFileSync(file(id), 'utf-8')) as PollRecord; } catch { return null; }
}
function save(p: PollRecord): void { writeFileSync(file(p.pollId), JSON.stringify(p, null, 2)); }

const toSpec = (p: PollRecord): PollSpec => ({ pollId: p.pollId, title: p.title, options: p.options, kind: p.kind, multi: p.multi, targetUser: p.targetUser });
function tallies(p: PollRecord): number[] {
  const t = p.options.map(() => 0);
  for (const idxs of Object.values(p.votes)) for (const i of idxs) if (t[i] !== undefined) t[i]++;
  return t;
}
const voterCount = (p: PollRecord): number => Object.keys(p.votes).length;

async function rerender(p: PollRecord, closed = false): Promise<void> {
  await slackPost('chat.update', { channel: p.channel, ts: p.ts, text: p.title, blocks: buildPollBlocks(toSpec(p), tallies(p), voterCount(p), closed) }, p.useUserToken)
    .catch((e) => console.error(`${PREFIX} rerender failed:`, (e as Error)?.message));
}

// ── Registration (called from claude.ts on a post_slack_poll tool result) ───────
export interface RegisterPollInput {
  pollId: string; channel: string; ts: string; title: string;
  options: { label: string; description?: string }[];
  kind: 'poll' | 'question'; multi?: boolean; targetUser?: string;
  deadlineMinutes?: number; quorum?: number; useUserToken?: boolean;
  sessionId: string; uid: string; userEmail?: string;
}

export function registerPoll(i: RegisterPollInput): void {
  const p: PollRecord = {
    pollId: i.pollId, title: i.title, options: i.options, kind: i.kind, multi: i.multi, targetUser: i.targetUser,
    channel: i.channel, ts: i.ts, useUserToken: i.useUserToken,
    votes: {}, status: 'open', createdAt: Date.now(),
    deadlineAt: i.deadlineMinutes ? Date.now() + i.deadlineMinutes * 60_000 : undefined,
    quorum: i.quorum, sessionId: i.sessionId, uid: i.uid, userEmail: i.userEmail,
  };
  save(p);
  console.log(`${PREFIX} registered ${p.pollId} kind=${p.kind} ch=${p.channel} deadline=${i.deadlineMinutes ?? '-'}m quorum=${i.quorum ?? '-'}`);
}

// ── Interactivity (called from slack/questions.ts) ──────────────────────────────
export async function handlePollVote(pollId: string, userId: string, optIdx: number): Promise<void> {
  const p = loadPoll(pollId);
  if (!p || p.status === 'closed') return;
  // Directed question: only the addressed user may answer.
  if (p.kind === 'question' && p.targetUser && userId !== p.targetUser) return;

  const cur = new Set(p.votes[userId] ?? []);
  if (p.kind === 'question' || !p.multi) {
    if (cur.has(optIdx)) cur.delete(optIdx); else { cur.clear(); cur.add(optIdx); }
  } else {
    cur.has(optIdx) ? cur.delete(optIdx) : cur.add(optIdx);
  }
  if (cur.size) p.votes[userId] = [...cur]; else delete p.votes[userId];
  save(p);

  const complete = p.kind === 'question'
    ? (p.targetUser ? (p.votes[p.targetUser]?.length ?? 0) > 0 : voterCount(p) > 0)
    : (p.quorum ? voterCount(p) >= p.quorum : false);
  if (complete) await closePoll(pollId, 'quorum'); else await rerender(p, false);
}

export async function handlePollClose(pollId: string): Promise<void> {
  await closePoll(pollId, 'manual');
}

async function closePoll(pollId: string, reason: 'deadline' | 'quorum' | 'manual'): Promise<void> {
  const p = loadPoll(pollId);
  if (!p || p.status === 'closed') return;
  p.status = 'closed';
  save(p);
  await rerender(p, true);
  console.log(`${PREFIX} closed ${pollId} reason=${reason} voters=${voterCount(p)}`);
  await wakeAgent(p, reason).catch((e) => console.error(`${PREFIX} wake failed:`, (e as Error)?.message));
}

// ── Close then report: wake the originating session once with the tally ─────────
async function wakeAgent(p: PollRecord, reason: string): Promise<void> {
  if (!runTurn) { console.warn(`${PREFIX} no turn runner; skipping wake for ${p.pollId}`); return; }
  if (!getSession(p.sessionId)) { console.warn(`${PREFIX} session ${p.sessionId} gone; skipping wake`); return; }

  // Per-option voters, with Slack user ids resolved to display names (cached).
  const votersByOption: string[][] = p.options.map(() => []);
  for (const [userId, idxs] of Object.entries(p.votes)) for (const i of idxs) if (votersByOption[i]) votersByOption[i].push(userId);
  const nameCache = new Map<string, string>();
  const resolveName = async (uid: string): Promise<string> => {
    if (nameCache.has(uid)) return nameCache.get(uid)!;
    const n = (await getUserName(uid).catch(() => null)) || uid;
    nameCache.set(uid, n);
    return n;
  };
  const lines = (await Promise.all(p.options.map(async (o, i) => {
    const names = await Promise.all(votersByOption[i].map(resolveName));
    const c = votersByOption[i].length;
    return `- ${o.label}: ${c} vote${c === 1 ? '' : 's'}${names.length ? ` (${names.join(', ')})` : ''}`;
  }))).join('\n');
  const headline = p.kind === 'question' ? 'Your question was answered' : `Your poll closed (${reason})`;
  const prompt = `[Poll result] ${headline}. Title: "${p.title}". ${voterCount(p)} participant(s).\n${lines}\n\nFollow up appropriately (summarize, take the next action, or notify the relevant people). Do not re-post the poll.`;

  appendMessage(p.sessionId, { id: crypto.randomUUID(), role: 'user', blocks: [{ type: 'text', text: prompt }], channel: 'poll' });
  broadcastFn?.({ type: 'session_messages_changed', sessionId: p.sessionId });

  const blocks = await runTurn({ prompt, sessionId: p.sessionId, uid: p.uid, userEmail: p.userEmail });
  if (!blocks.length) return;
  appendMessage(p.sessionId, { id: crypto.randomUUID(), role: 'assistant', blocks });
  broadcastFn?.({ type: 'session_messages_changed', sessionId: p.sessionId });
  const text = blocks.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map((b) => b.text).join('\n\n').trim();
  addUnread(p.uid, p.sessionId, text.slice(0, 120) || 'Poll closed', 'proactive', p.title);
  const slack = findSlackSessionBySessionId(p.sessionId);
  if (slack && text) await postMessage(slack.channel, text, slack.threadTs, slack.useUserToken).catch((e) => console.error(`${PREFIX} slack deliver failed:`, (e as Error)?.message));
}
