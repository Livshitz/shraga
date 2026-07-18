import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { dataPath } from './paths.ts';

const KEYS_PATH = dataPath('api-keys.json');

export interface ApiKey {
  id: string;
  key: string;
  label: string;
  uid: string;
  email: string;
  createdAt: number;
}

function load(): ApiKey[] {
  if (!existsSync(KEYS_PATH)) return [];
  try { return JSON.parse(readFileSync(KEYS_PATH, 'utf-8')); } catch { return []; }
}

function save(keys: ApiKey[]) {
  mkdirSync(dataPath(''), { recursive: true });
  writeFileSync(KEYS_PATH, JSON.stringify(keys, null, 2));
}

export function createApiKey(uid: string, email: string, label: string): ApiKey {
  const keys = load();
  const entry: ApiKey = {
    id: randomBytes(8).toString('hex'),
    key: `uck_${randomBytes(32).toString('hex')}`,
    label,
    uid,
    email,
    createdAt: Date.now(),
  };
  keys.push(entry);
  save(keys);
  return entry;
}

export function deleteApiKey(id: string, callerUid: string, isOwner: boolean): 'ok' | 'not_found' | 'forbidden' {
  const keys = load();
  const idx = keys.findIndex(k => k.id === id);
  if (idx < 0) return 'not_found';
  if (keys[idx].uid !== callerUid && !isOwner) return 'forbidden';
  keys.splice(idx, 1);
  save(keys);
  return 'ok';
}

export function listApiKeys() {
  return load().map(({ key, ...rest }) => ({ ...rest, keyPreview: `${key.slice(0, 8)}…` }));
}

export function validateApiKey(key: string): { uid: string; email: string } | null {
  const keys = load();
  for (const k of keys) {
    if (k.key.length === key.length && timingSafeEqual(Buffer.from(k.key), Buffer.from(key))) {
      return { uid: k.uid, email: k.email };
    }
  }
  return null;
}
