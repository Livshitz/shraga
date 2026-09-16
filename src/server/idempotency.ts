// In-memory idempotency for chat turns. Maps a caller-supplied request id to the
// sessionId that first handled it, so a retried submit (e.g. after an MCP client
// timeout) reuses the running session instead of spawning a duplicate.
// TTL-scoped: keys expire after the window, so the same id is reusable later.

const TTL_MS = 15 * 60 * 1000; // 15 min

type Entry = { sessionId: string; ts: number };
const store = new Map<string, Entry>();

const mapKey = (uid: string, key: string) => `${uid}::${key}`;

/** Returns the sessionId previously bound to (uid, key) if still within TTL, else null. */
export function lookupIdempotent(uid: string, key: string): string | null {
  const k = mapKey(uid, key);
  const e = store.get(k);
  if (!e) return null;
  if (Date.now() - e.ts > TTL_MS) { store.delete(k); return null; }
  return e.sessionId;
}

/** Binds (uid, key) → sessionId for the TTL window. */
export function rememberIdempotent(uid: string, key: string, sessionId: string): void {
  store.set(mapKey(uid, key), { sessionId, ts: Date.now() });
}
