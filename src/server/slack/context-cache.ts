import { getChannelHistory, getBotUserId, getAgentUserId, getUserName } from './api.ts';
import { summarizeText } from '../summarize.ts';

interface CacheEntry {
  summary: string;
  expiresAt: number;
}

const TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, CacheEntry>();

export async function getChannelContext(channel: string): Promise<string | null> {
  const cached = cache.get(channel);
  if (cached && cached.expiresAt > Date.now()) return cached.summary;

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

  cache.set(channel, { summary, expiresAt: Date.now() + TTL_MS });
  return summary;
}

export function invalidateChannelContext(channel: string): void {
  cache.delete(channel);
}
