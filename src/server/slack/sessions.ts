import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dataPath } from '../paths.ts';
import { upsertSession } from '../sessions.ts';

interface SlackSession {
  sessionId: string;
  channel: string;
  lastActivity: number;
  lastMessageTs?: string;
  useUserToken?: boolean;
  flat?: boolean;
}

const MAPPING_FILE = dataPath('slack-sessions.json');
const PROACTIVE_FILE = dataPath('slack-proactive.json');
const SLACK_BOT_EMAIL = 'slack-bot@shraga.local';
/**
 * Placeholder emails that mean "no real user" — NOT an address to attribute a turn to.
 * `slack-bot@unclaw.local` is the legacy value and is still persisted in existing
 * `slack-sessions.json` files, so it must keep being recognised.
 */
const SLACK_BOT_EMAILS: readonly string[] = [SLACK_BOT_EMAIL, 'slack-bot@unclaw.local'];

export function isSlackBotPlaceholderEmail(email: string | undefined): boolean {
  return !!email && SLACK_BOT_EMAILS.includes(email);
}

const SLACK_USER = { uid: 'slack-bot', email: SLACK_BOT_EMAIL, name: 'Slack Bot' };

let mapping: Record<string, SlackSession> = {};

function loadMapping() {
  if (existsSync(MAPPING_FILE)) {
    try { mapping = JSON.parse(readFileSync(MAPPING_FILE, 'utf-8')); } catch { mapping = {}; }
  }
}

function saveMapping() {
  writeFileSync(MAPPING_FILE, JSON.stringify(mapping, null, 2));
}

export function threadKey(channel: string, threadTs: string): string {
  return `${channel}:${threadTs}`;
}

/** Register an additional thread key pointing to an existing session (e.g. bot reply ts). */
export function registerThreadAlias(channel: string, threadTs: string, sessionId: string): void {
  loadMapping();
  const key = threadKey(channel, threadTs);
  if (mapping[key]) return;
  mapping[key] = { sessionId, channel, lastActivity: Date.now() };
  saveMapping();
}

export function getOrCreateSession(channel: string, threadTs: string, firstPrompt: string, flat?: boolean, scope: 'system' | 'user' = 'system', user?: { uid: string; email: string; name?: string }): { sessionId: string; isNew: boolean } {
  loadMapping();
  const key = threadKey(channel, threadTs);
  if (mapping[key]) {
    mapping[key].lastActivity = Date.now();
    saveMapping();
    return { sessionId: mapping[key].sessionId, isNew: false };
  }

  const sessionId = crypto.randomUUID();
  // Attribute the session to the resolved human (for nightly reconcile user-scope writes).
  // Unknown Slack users fall through to the synthetic SLACK_USER — runs, but won't mis-attribute.
  upsertSession(sessionId, firstPrompt, user ?? SLACK_USER, scope);
  mapping[key] = { sessionId, channel, lastActivity: Date.now(), ...(flat ? { flat: true } : {}) };
  saveMapping();
  return { sessionId, isNew: true };
}

/** True if an agent session already exists for this thread (read-only; does not create). */
export function hasSessionForThread(channel: string, threadTs: string): boolean {
  loadMapping();
  return !!mapping[threadKey(channel, threadTs)];
}

export function setLastMessageTs(channel: string, threadTs: string, ts: string): void {
  loadMapping();
  const key = threadKey(channel, threadTs);
  if (mapping[key]) {
    mapping[key].lastMessageTs = ts;
    saveMapping();
  }
}

export function setFlat(channel: string, threadTs: string, flat: boolean): void {
  loadMapping();
  const key = threadKey(channel, threadTs);
  if (mapping[key]) {
    mapping[key].flat = flat;
    saveMapping();
  }
}

export function setUseUserToken(channel: string, threadTs: string, useUserToken: boolean): void {
  loadMapping();
  const key = threadKey(channel, threadTs);
  if (mapping[key]) {
    mapping[key].useUserToken = useUserToken;
    saveMapping();
  }
}

// --- Proactive message registry ---
interface ProactiveMessage { sessionId: string; sessionTitle: string; sentAt: number; }
let proactiveMap: Record<string, ProactiveMessage> = {};

function loadProactive() {
  if (existsSync(PROACTIVE_FILE)) {
    try { proactiveMap = JSON.parse(readFileSync(PROACTIVE_FILE, 'utf-8')); } catch { proactiveMap = {}; }
  }
}
function saveProactive() { writeFileSync(PROACTIVE_FILE, JSON.stringify(proactiveMap, null, 2)); }

export function registerProactiveMessage(channel: string, ts: string, sessionId: string, sessionTitle: string): void {
  loadProactive();
  const key = threadKey(channel, ts);
  proactiveMap[key] = { sessionId, sessionTitle, sentAt: Date.now() };
  saveProactive();
  console.log(`[slack] Registered proactive message: ${key} → session ${sessionId}`);
}

export function getProactiveOrigin(channel: string, ts: string): ProactiveMessage | null {
  loadProactive();
  return proactiveMap[threadKey(channel, ts)] || null;
}

export function findSlackSessionBySessionId(sessionId: string): { channel: string; threadTs: string; lastMessageTs?: string; useUserToken?: boolean; flat?: boolean } | null {
  loadMapping();
  for (const [key, entry] of Object.entries(mapping)) {
    if (entry.sessionId === sessionId) {
      const sepIdx = key.indexOf(':');
      return { channel: key.slice(0, sepIdx), threadTs: key.slice(sepIdx + 1), lastMessageTs: entry.lastMessageTs, useUserToken: entry.useUserToken, flat: entry.flat };
    }
  }
  return null;
}
