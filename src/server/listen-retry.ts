/**
 * Bind the HTTP port, waiting out a predecessor that is still draining.
 *
 * `kickstart -k` starts the replacement while the old process drains (up to 90s), so the new one
 * meets EADDRINUSE. Exiting immediately hands the problem to the service manager — which respawns
 * on a ~10s throttle, meets the same still-draining owner, and exits again. MEASURED 2026-09-06 on
 * the feedox box: one watchdog kick produced ~20 start/exit cycles over five minutes, every one of
 * them `port already in use`, and every scheduled run in that window died with it. The manager was
 * doing exactly what it was asked to; the retry it was standing in for just belonged here, where
 * the wait is one process holding still instead of N processes racing.
 *
 * So: retry the bind on a fixed cadence for a bounded window. A drain finishes and we bind; a
 * genuinely occupied port still ends in a non-zero exit, just once instead of twenty times.
 */

import type { Server } from 'node:http';

export interface ListenRetryOptions {
  /** Total time to keep retrying EADDRINUSE before giving up. Sized over the ~90s drain ceiling. */
  waitMs?: number;
  /** Gap between attempts. */
  intervalMs?: number;
  /** Called once, on the first EADDRINUSE, so a wait is never silent. */
  onWaiting?: (waitMs: number) => void;
  /** Called on EVERY EADDRINUSE, before the wait — a caller may use it to reclaim an orphan holder. */
  onBusy?: () => void;
  /** Injectable clock for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Resolves when `server` is listening on `port`. Rejects with the underlying error if the port is
 * held for the whole window, or immediately for any error that waiting cannot fix.
 */
export function listenWithRetry(server: Server, port: number, opts: ListenRetryOptions = {}): Promise<void> {
  const waitMs = opts.waitMs ?? (Number(process.env.SHRAGA_BIND_WAIT_MS) || 120_000);
  const intervalMs = opts.intervalMs ?? 2_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const deadline = now() + waitMs;
  let announced = false;

  return new Promise<void>((resolve, reject) => {
    const attempt = (): void => {
      const onError = (err: NodeJS.ErrnoException): void => {
        // Only a busy port is worth waiting on: a bad address, EACCES, or anything else is as true
        // in two minutes as it is now, and retrying it would only delay the operator's error.
        if (err.code !== 'EADDRINUSE' || now() >= deadline) { reject(err); return; }
        try { opts.onBusy?.(); } catch { /* a caller's reclaim attempt must not abort the wait */ }
        if (!announced) { announced = true; opts.onWaiting?.(waitMs); }
        void sleep(intervalMs).then(attempt);
      };
      server.once('error', onError);
      server.listen(port, () => { server.off('error', onError); resolve(); });
    };
    attempt();
  });
}
