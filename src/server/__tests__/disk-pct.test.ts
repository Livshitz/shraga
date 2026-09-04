import { describe, it, expect } from 'bun:test';
import { diskUsedPct, DISK_WARN_PCT, DISK_CRIT_PCT } from '../stats';

// Real `statfs` shapes captured from each OS, checked against what `df` printed for the same mount.
describe('diskUsedPct', () => {
  // This test exists to keep the UI meter and the box's df-parsing Slack watchdog
  // (tools/ec2/box-disk-watchdog.sh, which tests df's own capacity column with -ge) IDENTICAL. df
  // CEILS capacity; anything else here puts the meter a point below the number that pages.
  it('linux: reproduces df -P capacity exactly, reserved blocks and all', () => {
    // ext4, 48G root with the default 5% reserve. df reported: 41G used, 3.4G avail, 93% capacity.
    const fs = { blocks: 12_385_536, bfree: 1_512_000, bavail: 891_000 };
    // df's own arithmetic on those numbers, to the same rounding it does (ceil — 92.4264 -> 93).
    const used = fs.blocks - fs.bfree;
    expect(diskUsedPct(fs, 'linux')).toBe(Math.ceil(100 * used / (used + fs.bavail)));
    expect(diskUsedPct(fs, 'linux')).toBe(93);
  });

  it('darwin: reports the container, not the sealed system volume df names 25%', () => {
    // Live capture from this mac: `df -h /` says 25% (per-volume APFS accounting) while the container
    // it shares is 92% full — /System/Volumes/Data agrees at 92%. The container number is the truth.
    const fs = { blocks: 120_699_413, bfree: 9_371_074, bavail: 9_371_074 };
    expect(diskUsedPct(fs, 'darwin')).toBe(93); // exact 92.2359, ceiled like the linux path
  });

  it('returns null for a nonsense stat so the caller keeps its last known value', () => {
    expect(diskUsedPct({ blocks: 0, bfree: 0, bavail: 0 }, 'linux')).toBeNull();
  });

  it('thresholds stay pinned to the box watchdog (tools/ec2/box-disk-watchdog.sh)', () => {
    expect([DISK_WARN_PCT, DISK_CRIT_PCT]).toEqual([92, 96]);
  });
});
