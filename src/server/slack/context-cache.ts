import { getChannelHistory, getBotUserId, getAgentUserId, getUserName } from './api.ts';
import { summarizeText } from '../summarize.ts';

/** A channel summary plus who wrote what it summarizes (`undefined` = author unknown), for session taint. */
export interface ChannelContext {
  summary: string;
  authors: (string | undefined)[];
}

interface CacheEntry extends ChannelContext {
  expiresAt: number;
}

const TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, CacheEntry>();

/** Authors of messages whose content is included, minus our own bot/agent (the agent's own output). A message with no
 *  `user` (e.g. a webhook/integration post) yields `undefined`: unknown author. Deduped. */
export function contentAuthors(messages: { user?: string; text?: string }[], ownIds: (string | null | undefined)[]): (string | undefined)[] {
  const own = new Set(ownIds.filter(Boolean));
  return [...new Set(messages.filter(m => (m.text || '').trim() && !(m.user && own.has(m.user))).map(m => m.user))];
}

export async function getChannelContext(channel: string): Promise<ChannelContext | null> {
  const cached = cache.get(channel);
  if (cached && cached.expiresAt > Date.now()) return cached;

  const messages = await getChannelHistory(channel, 20).catch(() => []);
  if (!messages.length) return null;

  const botId = await getBotUserId();
  const agentUid = await getAgentUserId();
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

  const entry = { summary, authors: contentAuthors(messages, [botId, agentUid]), expiresAt: Date.now() + TTL_MS };
  cache.set(channel, entry);
  return entry;
}

export function invalidateChannelContext(channel: string): void {
  cache.delete(channel);
}
