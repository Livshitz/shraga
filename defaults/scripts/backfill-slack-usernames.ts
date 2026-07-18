#!/usr/bin/env bun
/**
 * One-shot backfill: resolve missing userName on DM slack sessions.
 * Reads slack-sessions.json to find DM channels, calls Slack API to get the user.
 * Run: bun run scripts/backfill-slack-usernames.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dataPath } from '../src/server/paths.ts';

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || '';
if (!SLACK_BOT_TOKEN) { console.error('SLACK_BOT_TOKEN required'); process.exit(1); }

async function slackGet(method: string, params: Record<string, string>): Promise<any> {
  const url = new URL(`https://slack.com/api/${method}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` } });
  return res.json();
}

async function getUserName(userId: string): Promise<string | null> {
  const data = await slackGet('users.info', { user: userId });
  return data.user?.profile?.display_name || data.user?.real_name || data.user?.name || null;
}

const sessionsPath = dataPath('sessions.json');
const slackMappingPath = dataPath('slack-sessions.json');

const sessions = JSON.parse(readFileSync(sessionsPath, 'utf-8'));
const slackMapping: Record<string, { sessionId: string; channel: string }> = JSON.parse(readFileSync(slackMappingPath, 'utf-8'));

const dmChannelToSession = new Map<string, any>();
for (const s of sessions) {
  if (s.slackContext?.type === 'dm' && !s.slackContext.userName) {
    for (const [, v] of Object.entries(slackMapping)) {
      const entry = v as { sessionId: string; channel: string };
      if (entry.sessionId === s.sessionId && entry.channel.startsWith('D')) {
        dmChannelToSession.set(entry.channel, s);
        break;
      }
    }
  }
}

// Also find slack- sessions with no slackContext at all (legacy)
for (const s of sessions) {
  if (s.sessionId.startsWith('slack-') && !s.slackContext) {
    for (const [, v] of Object.entries(slackMapping)) {
      const entry = v as { sessionId: string; channel: string };
      if (entry.sessionId === s.sessionId) {
        if (entry.channel.startsWith('D')) {
          s.slackContext = { type: 'dm' };
          dmChannelToSession.set(entry.channel, s);
        } else {
          s.slackContext = { type: 'channel' };
        }
        break;
      }
    }
  }
}

console.log(`Found ${dmChannelToSession.size} DM sessions to backfill`);

const botAuth = await slackGet('auth.test', {});
const botUserId = botAuth.user_id;

for (const [channel, session] of dmChannelToSession) {
  const history = await slackGet('conversations.history', { channel, limit: '5' });
  if (!history.ok) { console.log(`  skip ${channel}: ${history.error}`); continue; }

  const userMsg = (history.messages || []).find((m: any) => m.user && m.user !== botUserId && !m.bot_id);
  if (!userMsg) { console.log(`  skip ${channel}: no user message found`); continue; }

  const name = await getUserName(userMsg.user);
  if (name) {
    session.slackContext.userName = name;
    console.log(`  ${session.sessionId.slice(0, 20)}... → ${name}`);
  }
}

writeFileSync(sessionsPath, JSON.stringify(sessions, null, 2));
console.log('Done. sessions.json updated.');
