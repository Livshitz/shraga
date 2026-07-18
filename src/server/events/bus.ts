// Tiny in-process event bus — the driving port for event-based triggers.
//
// Sources (the generic /api/events route, data-side extensions, internal watchers)
// call emitEvent(); the dispatcher subscribes and routes matching events to the
// scheduler's execution path. Deliberately minimal: no plugin registry, no
// lifecycle — just emit + subscribe. Adding a source = one emitEvent() call.
//
// TYPING: `ShragaEventMap` (types.ts) maps a source → its payload type. A source
// listed there gets a checked payload; anything else falls back to `unknown`, so
// ad-hoc emitters keep compiling. Add-ons register their source via declaration
// merging (see types.ts).
import type { ShragaEvent, PayloadOf } from './types.ts';

type Listener = (evt: ShragaEvent) => void;

const listeners = new Set<Listener>();

/** Clear all subscribers. For tests: `listeners` is a process-global, so a test file that boots a
 *  server (or its on() subscribers) leaks listeners into a later file's emit. Reset between files
 *  that share bus state to stay hermetic — bun's cross-file order is not stable across platforms.
 *  Mirrors clearTurnContext()/`__resetExtensionsForTest()`. Test-only. */
export function __resetEventBusForTest(): void {
  listeners.clear();
}

/** Subscribe to ALL events. Returns an unsubscribe fn. The dispatcher uses this. */
export function subscribeEvents(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Subscribe to a SINGLE source with a typed payload. Thin filter over
 *  subscribeEvents — convenience + typing for the common "I only care about X" case. */
export function subscribeEvent<K extends string>(
  source: K,
  handler: (payload: PayloadOf<K>, evt: ShragaEvent<K>) => void,
): () => void {
  return subscribeEvents((evt) => {
    if (evt.source === source) handler(evt.payload as PayloadOf<K>, evt as ShragaEvent<K>);
  });
}

/** Publish an event. Listeners are invoked synchronously; a throwing listener is
 *  logged and skipped so one bad subscriber can't sink the emit. */
export function emitEvent<K extends string>(source: K, payload: PayloadOf<K>, opts?: { id?: string }): ShragaEvent<K> {
  const evt: ShragaEvent<K> = { source, payload, id: opts?.id, at: Date.now() };
  for (const fn of listeners) {
    try { fn(evt as ShragaEvent); } catch (err) {
      console.error(`[events] listener threw for source "${source}":`, err);
    }
  }
  return evt;
}
