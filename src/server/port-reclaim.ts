import { execFileSync } from 'node:child_process';

/** Reclaim the listen port from a STALE COPY OF OURSELVES.
 *
 * The EADDRINUSE handler's assumption — "the old instance is draining, it will free the port, the
 * service manager restarts us" — holds only while something still owns that old process. It doesn't
 * when the server's launchd/systemd parent dies first: the server reparents to pid 1, nothing will
 * ever signal it, and it holds the port FOREVER. The replacement then dies on every respawn while
 * the orphan keeps serving the OLD code, so `kickstart -k` looks successful and changes nothing
 * (observed on feedox 2026-08-28: a deploy "restarted" the service four times, and the process
 * answering :3032 was three hours and one version old).
 *
 * Reclaiming is deliberately narrow — an over-broad "kill whatever holds my port" is how a deploy
 * takes down an unrelated service. Every condition must hold: the holder is orphaned (ppid 1, so no
 * manager owns it), it runs THIS deployment's entrypoint from THIS working directory, and it isn't
 * us. Anything else (a sibling deployment, a manager-owned process mid-drain, an unrelated server)
 * is left alone and the caller keeps today's exit-and-let-the-manager-retry behavior. */
export function reclaimStalePort(port: number, opts: { entrypoint?: string; cwd?: string; termGraceMs?: number } = {}): boolean {
  const entrypoint = opts.entrypoint ?? 'src/main.ts';
  const cwd = opts.cwd ?? process.cwd();
  const grace = opts.termGraceMs ?? 5000;

  const holders = listeners(port).filter((pid) => pid !== process.pid && isStaleSelf(pid, entrypoint, cwd));
  if (!holders.length) return false;

  for (const pid of holders) {
    console.warn(`[server] port ${port} held by ORPHANED stale instance pid=${pid} (ppid 1, same cwd + entrypoint) — reclaiming`);
    signal(pid, 'SIGTERM');
    if (!waitGone(pid, grace)) {
      console.warn(`[server] pid=${pid} ignored SIGTERM for ${grace}ms — SIGKILL`);
      signal(pid, 'SIGKILL');
      waitGone(pid, 2000);
    }
  }
  const free = listeners(port).filter((pid) => pid !== process.pid).length === 0;
  console.warn(`[server] port ${port} ${free ? 'reclaimed' : 'STILL held after reclaim'}`);
  return free;
}

function listeners(port: number): number[] {
  return sh('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'])
    .split('\n').map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0);
}

/** Orphaned (ppid 1) + our entrypoint + our cwd. All three, or it is not ours to kill. */
function isStaleSelf(pid: number, entrypoint: string, cwd: string): boolean {
  if (sh('ps', ['-o', 'ppid=', '-p', String(pid)]).trim() !== '1') return false;
  if (!sh('ps', ['-o', 'command=', '-p', String(pid)]).includes(entrypoint)) return false;
  // `lsof -d cwd -Fn` prints the cwd on an `n`-prefixed line.
  const holderCwd = sh('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])
    .split('\n').find((l) => l.startsWith('n'))?.slice(1).trim();
  return !!holderCwd && holderCwd === cwd;
}

function signal(pid: number, sig: NodeJS.Signals): void {
  try { process.kill(pid, sig); } catch (err: any) { console.warn(`[server] ${sig} pid=${pid} failed: ${err?.message ?? err}`); }
}

function waitGone(pid: number, ms: number): boolean {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return true; }
    // Synchronous on purpose: this runs inside the listen-error path, before the event loop is
    // serving anything, and the caller must decide bind-or-exit before returning.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  try { process.kill(pid, 0); return false; } catch { return true; }
}

function sh(cmd: string, args: string[]): string {
  try { return execFileSync(cmd, args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return ''; } // non-zero exit = no match (lsof) or no such pid (ps) — both mean "nothing there"
}
