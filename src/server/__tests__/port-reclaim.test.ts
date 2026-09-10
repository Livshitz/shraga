/**
 * Reclaim is allowed to kill exactly one thing: an ORPHANED copy of this deployment holding our
 * port. Widening it to holders that are no longer LISTENing (a production deployment 2026-09-06: an orphan closed its
 * listener inside a drain it never finished, kept the socket, and blocked every replacement) makes
 * that blast radius the only thing standing between us and killing a bystander — so pin it.
 */
import { describe, test, expect } from 'bun:test';
import { createServer, type Server } from 'node:net';
import { reclaimStalePort } from '../port-reclaim.ts';

const close = (s: Server) => new Promise<void>((r) => s.close(() => r()));

describe('reclaimStalePort', () => {
  test('leaves a port alone when nobody holds it', () => {
    const s = createServer();
    // A port we know is free: take one, release it, then ask about it.
    return new Promise<void>((done) => {
      s.listen(0, async () => {
        const port = (s.address() as { port: number }).port;
        await close(s);
        expect(reclaimStalePort(port)).toBe(false);
        done();
      });
    });
  }, 15_000);

  test('never touches a holder that is not an orphan of this deployment', async () => {
    // Held by THIS process: not ppid 1, so not ours to kill however the port looks.
    const holder = createServer();
    await new Promise<void>((r) => holder.listen(0, () => r()));
    const port = (holder.address() as { port: number }).port;
    expect(reclaimStalePort(port)).toBe(false);
    expect(holder.listening).toBe(true); // still serving — untouched
    await close(holder);
  }, 15_000);
});
