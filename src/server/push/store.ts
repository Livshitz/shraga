// Flat-file device-token store for remote push — no DB (house rule).
// `data/push-tokens.json`, keyed by uid → [{ token, platform, topic, addedAt, lastSeen }].
// Re-registering the same token is an upsert (refreshes lastSeen / platform / topic).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { dataPath } from '../paths.ts';

export type PushPlatform = 'apns' | 'fcm';

export interface PushToken {
  token: string;
  platform: PushPlatform;
  topic?: string;
  addedAt: number;
  lastSeen: number;
}

type Store = Record<string, PushToken[]>;

const FILE = dataPath('push-tokens.json');

function load(): Store {
  if (!existsSync(FILE)) return {};
  try {
    return JSON.parse(readFileSync(FILE, 'utf-8')) as Store;
  } catch (err) {
    console.error('[push] token store read failed, starting empty:', err);
    return {};
  }
}

function save(store: Store): void {
  mkdirSync(path.dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(store, null, 2));
}

/** Insert or refresh a token for a user. A token can only belong to one uid; if it
 *  re-appears under a new uid (device handed over) it migrates to the latest owner. */
export function upsertToken(uid: string, token: string, platform: PushPlatform, topic?: string): void {
  const store = load();
  // Drop this token from any other uid so it isn't double-delivered.
  for (const [otherUid, list] of Object.entries(store)) {
    if (otherUid === uid) continue;
    const filtered = list.filter((t) => t.token !== token);
    if (filtered.length !== list.length) store[otherUid] = filtered;
  }
  const list = store[uid] ?? [];
  const now = Date.now();
  const existing = list.find((t) => t.token === token);
  if (existing) {
    existing.platform = platform;
    existing.topic = topic;
    existing.lastSeen = now;
  } else {
    list.push({ token, platform, topic, addedAt: now, lastSeen: now });
  }
  store[uid] = list;
  save(store);
}

/** Remove a token for a user (unregister, or pruning a dead token). */
export function removeToken(uid: string, token: string): void {
  const store = load();
  const list = store[uid];
  if (!list) return;
  const filtered = list.filter((t) => t.token !== token);
  if (filtered.length === list.length) return;
  if (filtered.length) store[uid] = filtered;
  else delete store[uid];
  save(store);
}

/** Mark a token as recently delivered-to (housekeeping; cheap). */
export function touchToken(uid: string, token: string): void {
  const store = load();
  const entry = store[uid]?.find((t) => t.token === token);
  if (!entry) return;
  entry.lastSeen = Date.now();
  save(store);
}

export function listForUid(uid: string): PushToken[] {
  return load()[uid] ?? [];
}
