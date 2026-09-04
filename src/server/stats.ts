// Shared machine-stats sampler: ONE interval samples the host (CPU/mem/load) for the
// whole server and broadcasts each point to all clients. Clients never poll the box —
// they seed from getStats() and then receive live points over WS. N users = 1 sampler.
import os from 'node:os';
import { readFileSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface StatSample {
  t: number;   // epoch ms
  cpu: number; // 0-100, host CPU utilization since last sample
  mem: number; // 0-100, used / total memory
  load: number; // 1-min load average
  disk: number; // 0-100, used of the root filesystem (cached, refreshed slowly — see refreshDisk)
}

export class StatsSamplerOptions {
  intervalMs = 5000;
  window = 120; // ring-buffer length (120 × 5s = 10 min trend)
  // Disk moves in minutes, not seconds, and statfs() stats the whole filesystem — no reason to pay
  // for it on every 5s tick. Refreshed on its own slow cadence into a cache the sample just reads.
  diskIntervalMs = 60_000;
}

// Percent-USED thresholds for the disk meter. Kept identical to the box's Slack alerting
// (tools/ec2/box-disk-watchdog.sh in shraga-circles, BOX_DISK_WARN_PCT/BOX_DISK_CRIT_PCT) so the
// widget and the pager agree on what "in trouble" means — 92% is where that box's pushes started
// timing out. Change one, change the other.
export const DISK_WARN_PCT = 92;
export const DISK_CRIT_PCT = 96;

export class StatsSampler {
  public options: StatsSamplerOptions;
  private buffer: StatSample[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private prevCpu = cpuTotals();
  // Cached memory %, refreshed asynchronously each tick. NEVER read the OS memory synchronously in the
  // sample path: on macOS that meant `execSync('memory_pressure')`, which blocks the event loop for
  // ~1-2s (longer under load) every 5s — stalling /api/version long enough to trip the health watchdog
  // into false-restarting a live server. Seed from the cheap os.freemem fallback until the first refresh.
  private memPct = 100 * (1 - os.freemem() / os.totalmem());
  // Cached disk %, refreshed on the slow diskIntervalMs cadence. -1 until the first refresh lands, so
  // an unread disk renders as "unknown" rather than a confident 0% (an empty disk) — and a failed
  // refresh keeps the LAST known value rather than resetting it.
  private diskPct = -1;
  private diskTimer: ReturnType<typeof setInterval> | null = null;

  public constructor(options?: Partial<StatsSamplerOptions>) {
    this.options = { ...new StatsSamplerOptions(), ...options };
  }

  start(broadcast: (data: object) => void) {
    if (this.timer) return; // singleton — already running
    void this.refreshMem(); // prime the cache; each tick refreshes it async for the NEXT sample
    void this.refreshDisk();
    this.diskTimer = setInterval(() => { void this.refreshDisk(); }, this.options.diskIntervalMs);
    if (typeof this.diskTimer.unref === 'function') this.diskTimer.unref();
    this.timer = setInterval(() => {
      void this.refreshMem(); // async, non-blocking — updates this.memPct without stalling the loop
      const sample = this.sample();
      this.buffer.push(sample);
      if (this.buffer.length > this.options.window) this.buffer.shift();
      broadcast({ type: 'stats', sample });
    }, this.options.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    console.log(`[stats] sampling host every ${this.options.intervalMs}ms (window ${this.options.window})`);
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.diskTimer) { clearInterval(this.diskTimer); this.diskTimer = null; }
  }

  getStats(): StatSample[] {
    return this.buffer;
  }

  private sample(): StatSample {
    const now = cpuTotals();
    const idleDelta = now.idle - this.prevCpu.idle;
    const totalDelta = now.total - this.prevCpu.total;
    this.prevCpu = now;
    const cpu = totalDelta > 0 ? Math.max(0, Math.min(100, 100 * (1 - idleDelta / totalDelta))) : 0;
    return {
      t: Date.now(),
      cpu: Math.round(cpu),
      mem: Math.round(this.memPct), // cached; refreshed async each tick (never blocks the loop)
      load: Math.round(os.loadavg()[0] * 100) / 100,
      disk: this.diskPct < 0 ? -1 : Math.round(this.diskPct), // cached; refreshed every diskIntervalMs
    };
  }

  // Refresh the cached memory %. os.freemem() counts reclaimable memory (page cache on Linux,
  // inactive/purgeable pages on macOS) as "used", so it reads ~95-99% even when healthy — use each OS's
  // notion of *available* (free + reclaimable) instead. Async + bounded so it can NEVER stall the loop.
  // Refresh the cached disk %. statfs() is the node-native stat — no `df` subprocess, same call on
  // macOS and Linux. Any failure (unreadable mount, permission) leaves the previous value in place.
  private async refreshDisk(): Promise<void> {
    try {
      const pct = diskUsedPct(await statfs('/'), process.platform);
      if (pct != null) this.diskPct = pct;
    } catch (err) {
      // Keep the last known value — a stale number beats a wrong 0. Never swallow silently.
      console.warn('[stats] disk refresh failed, keeping last value', err);
    }
  }

  private async refreshMem(): Promise<void> {
    try {
      if (process.platform === 'linux') {
        const info = readFileSync('/proc/meminfo', 'utf8'); // tiny virtual file — negligible read
        const total = +(info.match(/MemTotal:\s+(\d+)/)?.[1] ?? 0);
        const avail = info.match(/MemAvailable:\s+(\d+)/)?.[1];
        if (total > 0 && avail != null) { this.memPct = 100 * (1 - +avail / total); return; }
      } else if (process.platform === 'darwin') {
        // macOS pressure-aware "free percentage". Was execSync — which blocked the event loop for
        // seconds every tick and tripped the health watchdog. Async with a hard timeout; killed and
        // fell back if it stalls, so a slow/hung `memory_pressure` never touches the loop.
        const { stdout } = await execFileAsync('memory_pressure', [], { encoding: 'utf8', timeout: 3000 });
        const freePct = stdout.match(/free percentage:\s+(\d+)%/)?.[1];
        if (freePct != null) { this.memPct = 100 - +freePct; return; }
      }
    } catch { /* fall through to os.freemem */ }
    this.memPct = 100 * (1 - os.freemem() / os.totalmem());
  }
}

/** Percent USED of a filesystem, from a statfs() result. Exported (and platform passed in) so BOTH
 *  branches are testable from either OS — the Linux one cannot otherwise be exercised in dev.
 *  Per-platform on purpose, like refreshMem: each OS's honest notion of "how full is it".
 *  Linux — exactly `df`'s formula, used/(used+available), so this meter and the box's df-parsing
 *  watchdog report the same number (both exclude the root-reserved margin from both sides).
 *  macOS — APFS volumes SHARE one container, so `df /`'s per-volume "used" reads ~25% on a disk that
 *  is genuinely 92% full; only free-against-container-total tells the truth there.
 *  Returns null for a nonsense stat, so the caller keeps its last known value. */
export function diskUsedPct(fs: { blocks: bigint | number; bfree: bigint | number; bavail: bigint | number }, platform: string): number | null {
  const blocks = Number(fs.blocks), bfree = Number(fs.bfree), bavail = Number(fs.bavail);
  if (!(blocks > 0)) return null;
  const pct = platform === 'darwin'
    ? 100 * (1 - bavail / blocks)
    : 100 * ((blocks - bfree) / Math.max(1, blocks - bfree + bavail));
  return Math.max(0, Math.min(100, pct));
}

function cpuTotals() {
  let idle = 0, total = 0;
  for (const c of os.cpus()) {
    for (const v of Object.values(c.times)) total += v;
    idle += c.times.idle;
  }
  return { idle, total };
}

export const statsSampler = new StatsSampler();
