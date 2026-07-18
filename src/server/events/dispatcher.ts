// Routes bus events to the scheduler. Subscribes once; for each event, dedupes by
// id (retried webhooks) then asks the scheduler to fire matching `event`-trigger
// schedules. Actual execution + active-instance gating lives in scheduler.fireEvent.
import { subscribeEvents } from './bus.ts';
import * as scheduler from '../scheduler/index.ts';

const DEDUPE_TTL_MS = 5 * 60_000;
const DEDUPE_MAX = 1000;
/** id → first-seen timestamp. Bounded; old entries pruned on insert. */
const seen = new Map<string, number>();

function isDuplicate(id: string): boolean {
  const now = Date.now();
  // Prune expired (and cap size) before checking.
  if (seen.size >= DEDUPE_MAX) {
    for (const [k, ts] of seen) {
      if (now - ts > DEDUPE_TTL_MS) seen.delete(k);
    }
    // Still over cap → drop oldest insertion (Map preserves insertion order).
    while (seen.size >= DEDUPE_MAX) {
      const oldest = seen.keys().next().value;
      if (oldest === undefined) break;
      seen.delete(oldest);
    }
  }
  const prev = seen.get(id);
  if (prev !== undefined && now - prev <= DEDUPE_TTL_MS) return true;
  seen.set(id, now);
  return false;
}

let started = false;

export function startEventDispatcher(): void {
  if (started) return; // idempotent — a double subscribe would double-fire every event
  started = true;
  subscribeEvents((evt) => {
    if (evt.id && isDuplicate(evt.id)) {
      console.log(`[events] duplicate ${evt.source}#${evt.id} — ignored`);
      return;
    }
    const fired = scheduler.fireEvent(evt.source, evt.payload);
    if (fired.length) {
      console.log(`[events] "${evt.source}" → fired ${fired.length} trigger(s): ${fired.join(', ')}`);
    }
  });
  console.log('[events] dispatcher started');
}
