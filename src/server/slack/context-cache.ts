import { getChannelHistory, getBotUserId, getAgentUserId, getUserName } from './api.ts';
import { summarizeText } from '../summarize.ts';

interface CacheEntry {
  summary: string;
  expiresAt: number;
}

const TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, CacheEntry>();

type SlackMessage = { user?: string; bot_id?: string; text?: string };
/** SECURITY_ENFORCE ingestion floor: only content by authors ranked ≥ `minRank` (the invoking principal's) is kept. */
export interface AuthorTrust {
  minRank: number;
  /** Rank of a Slack user. Rejects/undefined = unresolvable: the message is excluded (never lowers the floor). */
  rankOf: (user: string) => Promise<number | undefined>;
}

/** Keep our own bot/agent output and messages whose human author ranks ≥ `minRank`. Bot/webhook posts and unresolvable
 *  authors are dropped, not tainted: untrusted content never reaches the model, so the invoker keeps their tools. */
export async function trustedMessages<M extends SlackMessage>(messages: M[], ownIds: (string | null | undefined)[], trust: AuthorTrust): Promise<M[]> {
  const own = new Set(ownIds.filter(Boolean));
  const ranks = new Map<string, Promise<number | undefined>>();
  const rank = (u: string) => ranks.get(u) ?? ranks.set(u, trust.rankOf(u).catch((err: any) => {
    console.error(`[slack-context] rank lookup failed for ${u} — excluding their messages:`, err?.message ?? err);
    return undefined;
  })).get(u)!;
  const keep = await Promise.all(messages.map(async (m) => {
    if (m.user && own.has(m.user)) return true;
    if (m.bot_id || !m.user) return false;
    const r = await rank(m.user);
    return r !== undefined && r >= trust.minRank;
  }));
  const kept = messages.filter((_, i) => keep[i]);
  if (kept.length < messages.length && /(^|,)\s*(\*|SlackContext)\s*(,|$)/.test(process.env.DEBUG ?? '')) {
    console.log(`[slack-context] dropped ${messages.length - kept.length}/${messages.length} messages (author rank < ${trust.minRank}, bot, or unresolved)`);
  }
  return kept;
}

/** Channel summary of the last 20 messages; with `trust`, summarized from trusted messages only (cached per floor). */
export async function getChannelContext(channel: string, trust?: AuthorTrust): Promise<string | null> {
  const key = trust ? `${channel}|${trust.minRank}` : channel;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.summary;

  const history = await getChannelHistory(channel, 20).catch(() => []);
  const botId = await getBotUserId();
  const agentUid = await getAgentUserId();
  const messages = trust ? await trustedMessages(history, [botId, agentUid], trust) : history;
  if (!messages.length) return null;

  const lines: string[] = [];
  for (const msg of messages) {
    const isBot = !!msg.bot_id || msg.user === botId || (agentUid && msg.user === agentUid);
    const name = isBot ? 'Bot' : (msg.user ? await getUserName(msg.user).catch(() => null) ?? 'User' : 'User');
    const text = (msg.text || '').replace(/<@[A-Z0-9]+>/g, '@user').trim();
    if (text) lines.push(`${name}: ${text}`);
  }
  if (!lines.length) return null;

  const summary = await summarizeText(
    lines.join('\n'),
    'Summarize this Slack channel conversation in 2-4 sentences. Capture the key topics, questions, and any pending action items. Be concise.'
  );
  if (!summary) return null;

  cache.set(key, { summary, expiresAt: Date.now() + TTL_MS });
  return summary;
}

export function invalidateChannelContext(channel: string): void {
  for (const key of cache.keys()) if (key === channel || key.startsWith(`${channel}|`)) cache.delete(key);
}
