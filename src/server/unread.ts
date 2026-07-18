import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dataPath } from './paths.ts';
import { getSession } from './sessions.ts';

export interface UnreadEntry {
  count: number;
  preview: string;
  since: number;
  lastAt: number;
  source: 'response' | 'proactive' | 'schedule';
  title?: string;
}

export interface UserUnreads {
  sessions: Record<string, UnreadEntry>;
}

const UNREAD_DIR = dataPath('unread');

function filePath(uid: string): string {
  return `${UNREAD_DIR}/${uid}.json`;
}

function load(uid: string): UserUnreads {
  const file = filePath(uid);
  if (!existsSync(file)) return { sessions: {} };
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return { sessions: {} };
  }
}

function save(uid: string, data: UserUnreads): void {
  mkdirSync(UNREAD_DIR, { recursive: true });
  writeFileSync(filePath(uid), JSON.stringify(data, null, 2));
}

export function addUnread(
  uid: string,
  sessionId: string,
  preview: string,
  source: UnreadEntry['source'],
  title?: string,
): UnreadEntry {
  const data = load(uid);
  const existing = data.sessions[sessionId];
  const now = Date.now();
  const entry: UnreadEntry = {
    count: (existing?.count ?? 0) + 1,
    preview,
    since: existing?.since ?? now,
    lastAt: now,
    source,
    ...(title ? { title } : existing?.title ? { title: existing.title } : {}),
  };
  data.sessions[sessionId] = entry;
  save(uid, data);
  return entry;
}

export function markRead(uid: string, sessionId: string): void {
  const data = load(uid);
  if (!data.sessions[sessionId]) return;
  delete data.sessions[sessionId];
  save(uid, data);
}

export function getUnreads(uid: string): UserUnreads {
  const data = load(uid);
  const sids = Object.keys(data.sessions);
  const orphans = sids.filter(sid => !getSession(sid));
  if (orphans.length > 0) {
    for (const sid of orphans) delete data.sessions[sid];
    save(uid, data);
  }
  return data;
}

