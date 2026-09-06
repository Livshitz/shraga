/**
 * A replacement process must WAIT OUT its draining predecessor rather than exit into the service
 * manager's respawn loop — see listen-retry.ts for the measured storm this prevents.
 */
import { describe, test, expect } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { listenWithRetry } from '../listen-retry.ts';

const close = (s: Server) => new Promise<void>((r) => s.close(() => r()));
/** An ephemeral port we then release, so the test never guesses a free number. */
async function takePort(): Promise<{ port: number; holder: Server }> {
  const holder = createServer();
  await new Promise<void>((r) => holder.listen(0, () => r()));
  return { port: (holder.address() as { port: number }).port, holder };
}

describe('listenWithRetry', () => {
  test('binds immediately when the port is free', async () => {
    const { port, holder } = await takePort();
    await close(holder);
    const s = createServer();
    await listenWithRetry(s, port, { waitMs: 5_000, intervalMs: 10 });
    expect(s.listening).toBe(true);
    await close(s);
  }, 15_000);

  test('waits out a predecessor that is still holding the port, then binds', async () => {
    const { port, holder } = await takePort();
    const s = createServer();
    let announcedWith = 0;
    const p = listenWithRetry(s, port, { waitMs: 10_000, intervalMs: 20, onWaiting: (ms) => { announcedWith = ms; } });
    // The predecessor drains a moment later — exactly the `kickstart -k` overlap.
    setTimeout(() => { void close(holder); }, 300);
    await p;
    expect(s.listening).toBe(true);
    expect(announcedWith).toBe(10_000); // the wait was announced once, with its budget
    await close(s);
  }, 15_000);

  test('gives up with the real error when the port never frees', async () => {
    const { port, holder } = await takePort();
    const s = createServer();
    await expect(listenWithRetry(s, port, { waitMs: 150, intervalMs: 20 }))
      .rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(s.listening).toBe(false);
    await close(holder);
  }, 15_000);

  test('an error that waiting cannot fix is raised at once', async () => {
    // A fake listener, so the "not EADDRINUSE" branch is exercised deterministically rather than by
    // hoping the host refuses a real bind (a CI box running as root would not).
    let attempts = 0;
    const fake = {
      once(_ev: string, cb: (e: NodeJS.ErrnoException) => void) { this._err = cb; return this; },
      off() { return this; },
      listen() { attempts++; setImmediate(() => this._err?.(Object.assign(new Error('denied'), { code: 'EACCES' }))); return this; },
      _err: undefined as ((e: NodeJS.ErrnoException) => void) | undefined,
    };
    await expect(listenWithRetry(fake as never, 1, { waitMs: 10_000, intervalMs: 50 }))
      .rejects.toMatchObject({ code: 'EACCES' });
    expect(attempts).toBe(1); // raised on the first try, never retried
  }, 15_000);
});
