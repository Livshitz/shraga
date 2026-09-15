/**
 * Opt-in SDK session resume for the claude-code engine — the pure half (decision + prompt building),
 * kept free of SDK/IO wiring so every fallback reason is unit-testable.
 *
 * Fresh turn (today's path): ONE user message = contextBlock + <conversation_history> + new message, so
 * the whole history is re-written to prompt cache every turn. Resume turn: `resume: <claudeSessionId>`
 * and send only the new message; the stable context went in once on the session's fresh query, and
 * whatever CHANGED since (context sections, messages other channels appended) plus the current speaker's
 * `user` section rides AFTER the user text so the cached transcript prefix stays byte-identical. Only one
 * speaker's turns ever share a CC session (speaker-change).
 *
 * Flag: `directives.resume` (per conversation: `[resume:on]` or PUT /api/sessions/:id/directives) over
 * `agent-config.json` `sdkResume` (global, re-read every turn). Default OFF.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ConvMessage } from '../sessions.ts';
import type { Directives } from '../directives.ts';
import type { AgentSettings } from '../shraga-config.ts';

/** Persisted on SessionMeta.claudeResume — the facts needed to decide whether the stored CC session
 *  may be resumed. Hashes, not content: this lives in the 9 MB sessions index. */
export interface ClaudeResumeState {
  /** Claude Code session id (SDK init/result `session_id`); resume keeps it stable across turns. */
  claudeSessionId: string;
  /** Hash of the CLAUDE_CONFIG_DIR the transcript was written under (per-user login or box default). */
  configDirHash: string;
  /** speakerKey() of the person whose turns this CC session holds. Another speaker never resumes it: the
   *  transcript carries this speaker's private user context (learnings/corrections). */
  speaker?: string;
  /** Model the last turn resolved (informational — CC resumes across models; only the cache is per-model). */
  model?: string;
  /** When this CC session was started (first fresh query). */
  startedAt: number;
  /** Id of the last conversation message at the start of the last turn; messages after it are what CC hasn't seen. */
  markId?: string;
  /** Identity of the newest shraga summary / compact marker when the state was saved. */
  summaryKey: string;
  /** Section name → hash of the context CC has already been given. */
  sections: Record<string, string>;
  /** Set by the core when another engine ran a turn on this session (its turns aren't in the CC transcript). */
  interruptedBy?: string;
}

export type TurnPath = 'resume' | 'fresh' | `fallback:${string}`;

/** Unseen out-of-band text above this size means resume would re-send a history anyway — go fresh. */
export const MAX_UNSEEN_CHARS = 30_000;

export function isResumeEnabled(directives: Directives, config: AgentSettings): boolean {
  // The per-session directives endpoint stores passthrough values opaquely, so accept string forms too.
  const v = (directives.resume ?? config.sdkResume) as unknown;
  return v === true || v === 'on' || v === 'true';
}

export function shortHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** Who is speaking, as a hash (the sessions index must not gain raw emails). */
export function speakerKey(uid: string, email?: string): string {
  return shortHash(`${uid}\n${email?.trim().toLowerCase() ?? ''}`);
}

/** Errors that mean THIS resume can't run (the stored transcript is gone/unreadable) — worth one fresh retry.
 *  Anything else (quota, auth, API, process crash) would fail a fresh query the same way: surface it as-is. */
export function isResumeFailure(text: string): boolean {
  return /No conversation found|\b(session|transcript)\b.{0,60}\b(not found|missing|corrupt|invalid)\b/i.test(text);
}

/** Where the CLI keeps transcripts for a run: the routed per-user login, else the process's config dir. */
export function claudeConfigDir(accountDir: string | null | undefined): string {
  return accountDir || process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(homedir(), '.claude');
}

/** `<configDir>/projects/<cwd-slug>/<id>.jsonl`, found by scan rather than by re-deriving the CLI's slug
 *  rule (a wrong guess would silently turn every resume into a fallback). */
export function findClaudeTranscript(sessionId: string, configDir: string): string | null {
  const projects = path.join(configDir, 'projects');
  if (!existsSync(projects)) return null;
  for (const dir of readdirSync(projects, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const file = path.join(projects, dir.name, `${sessionId}.jsonl`);
    if (existsSync(file)) return file;
  }
  return null;
}

/** One conversation message as history text — shared by the fresh history prompt and the resume tail. */
export function renderConvMessage(m: ConvMessage): string | null {
  const texts = m.blocks
    .filter((b) => b.type === 'text' || b.type === 'context')
    .map((b) => (b.type === 'context' ? `[${b.label}]: ${b.text}` : (b as { text: string }).text))
    .filter(Boolean);
  return texts.length ? `${m.role === 'user' ? 'User' : 'Assistant'}: ${texts.join('\n')}` : null;
}

/** Changes whenever maybeCompact writes a summary or /compact adds a marker (applyCompactMarkers
 *  turns the latter into a synthetic leading message). */
export function conversationSummaryKey(conv: ConvMessage[]): string {
  for (let i = conv.length - 1; i >= 0; i--) {
    const s = conv[i].blocks.find((b) => b.type === 'summary') as { compactedCount: number } | undefined;
    if (s) return `summary:${s.compactedCount}`;
  }
  const first = conv[0];
  if (first?.id === 'compact-summary') return `marker:${shortHash(renderConvMessage(first) ?? '')}`;
  return '';
}

/**
 * Messages CC has not seen: everything after the mark, minus the previous turn's own reply (the first
 * message, when it is the assistant's) and this turn's prompt (the last, when it is a user message —
 * every channel appends it before streaming). null = the mark is gone (history was rewritten).
 */
export function unseenMessages(conv: ConvMessage[], markId: string | undefined): ConvMessage[] | null {
  if (!markId) return null;
  const idx = conv.findLastIndex((m) => m.id === markId);
  if (idx < 0) return null;
  const after = conv.slice(idx + 1);
  if (after[0]?.role === 'assistant') after.shift();
  if (after.at(-1)?.role === 'user') after.pop();
  return after;
}

export interface TurnDecisionInput {
  enabled: boolean;
  state?: ClaudeResumeState;
  conversation: ConvMessage[];
  configDirHash: string;
  speaker: string;
  /** A CLI process from an earlier run on this session is still alive (e.g. the run a steer took over). */
  cliAlive?: boolean;
  conversationReset?: boolean;
  hasTranscript: (claudeSessionId: string) => boolean;
}

export function decideClaudeTurn(i: TurnDecisionInput): { path: TurnPath; unseen: ConvMessage[] } {
  const fallback = (reason: string) => ({ path: `fallback:${reason}` as TurnPath, unseen: [] });
  if (!i.enabled) return { path: 'fresh', unseen: [] };
  const s = i.state;
  if (!s?.claudeSessionId) return fallback('no-session');
  // Two CLI processes appending to one transcript can interleave it; the takeover turn starts its own.
  if (i.cliAlive) return fallback('concurrent-run');
  if (s.speaker !== i.speaker) return fallback('speaker-change');
  if (s.interruptedBy) return fallback('engine-switch');
  if (s.configDirHash !== i.configDirHash) return fallback('account-change');
  if (i.conversationReset) return fallback('reset');
  if (s.summaryKey !== conversationSummaryKey(i.conversation)) return fallback('summary');
  const unseen = unseenMessages(i.conversation, s.markId);
  if (!unseen) return fallback('history-diverged');
  if (unseen.reduce((n, m) => n + (renderConvMessage(m)?.length ?? 0), 0) > MAX_UNSEEN_CHARS) return fallback('drift');
  // Checked last (filesystem): the CLI's periodic cleanup (cleanupPeriodDays) or a moved config dir
  // deletes transcripts under sessions we still hold — catch it before spawning a doomed resume.
  if (!i.hasTranscript(s.claudeSessionId)) return fallback('transcript-missing');
  return { path: 'resume', unseen };
}

export function sectionHashes(sections: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(sections)) if (v) out[k] = shortHash(v);
  return out;
}

/** Re-sent on every resume turn regardless of hashes: who is speaking (identity + role) must never depend on
 *  bookkeeping about what an earlier, possibly cancelled, turn managed to deliver. Small. */
export const ALWAYS_SENT_SECTIONS = ['user'];

/** Hash marking a section whose delivery is unknown — never equals a real hash, so the next turn re-sends it. */
const UNKNOWN = '?';

/**
 * Section hashes to store the moment a resume prompt is SUBMITTED. The CLI writes the prompt to the
 * transcript before any output, so a turn cancelled early may or may not have delivered its delta. Unchanged
 * sections are known either way; changed, new and removed ones are marked unknown and re-sent next turn.
 */
export function sectionsAfterSubmit(prev: Record<string, string>, next: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of new Set([...Object.keys(prev), ...Object.keys(next)])) out[k] = prev[k] === next[k] ? prev[k] : UNKNOWN;
  return out;
}

/** The context sections that changed since CC last saw them (new or edited) plus ALWAYS_SENT_SECTIONS, and a
 *  note for sections that no longer apply. '' when there is nothing to send. */
export function buildContextDelta(prev: Record<string, string>, sections: Record<string, string>): string {
  const changed = Object.entries(sections).filter(([k, v]) => v && (ALWAYS_SENT_SECTIONS.includes(k) || prev[k] !== shortHash(v)));
  const removed = Object.keys(prev).filter((k) => !sections[k]);
  if (!changed.length && !removed.length) return '';
  return [
    '<context_update>',
    'Current context for this turn. Each section below replaces its earlier version.',
    ...changed.map(([k, v]) => `<section name="${k}">\n${v}\n</section>`),
    ...(removed.length ? [`No longer applicable: ${removed.join(', ')}`] : []),
    '</context_update>',
  ].join('\n');
}

export function buildResumePrompt(prompt: string, unseen: ConvMessage[], delta: string): string {
  const lines = unseen.map(renderConvMessage).filter(Boolean);
  const unseenBlock = lines.length
    ? `<messages_since_last_turn>\nAdded to this conversation since your last reply (other participants, channel context, notices):\n${lines.join('\n\n')}\n</messages_since_last_turn>`
    : '';
  return [prompt, unseenBlock, delta].filter(Boolean).join('\n\n');
}
