/**
 * Tiny indirection so server modules (e.g. an add-on's background duplex engine) can push WS events to a session
 * OUTSIDE a request turn — without importing index.ts (which would be a cycle). index.ts registers the
 * real `broadcast` at boot via setBroadcaster(); callers use emitToSession().
 */
type Broadcaster = (data: object) => void;

let _broadcast: Broadcaster | null = null;

export function setBroadcaster(fn: Broadcaster): void {
  _broadcast = fn;
}

/** Push an event to all clients (carrying sessionId); no-op if the bus isn't wired yet. */
export function emitToSession(sessionId: string, data: object): void {
  if (!_broadcast) return;
  _broadcast({ ...data, sessionId });
}
