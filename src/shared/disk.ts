// Disk-meter values that BOTH halves need. Dependency-free on purpose (no node:*, no react) so the
// server can import it and vite can bundle it into the client — the only way a threshold change is
// physically one edit instead of two that can drift.

// Percent-USED thresholds for the disk meter. Kept identical to the box's Slack alerting
// (tools/ec2/box-disk-watchdog.sh in shraga-circles, BOX_DISK_WARN_PCT/BOX_DISK_CRIT_PCT) so the
// widget and the pager agree on what "in trouble" means — 92% is where that box's pushes started
// timing out. This file is the single source: the server re-exports it, the client imports it.
export const DISK_WARN_PCT = 92;
export const DISK_CRIT_PCT = 96;

/**
 * Human byte size for the tooltip. Dependency-free and deliberately identical in both halves so the
 * hover text and any server-side log read the same. Binary units, because that is what `df -h`
 * prints and the whole point of this meter is agreeing with `df`.
 */
export function formatBytes(n: number): string {
	if (!Number.isFinite(n) || n < 0) return '?';
	const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
	let i = 0;
	while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
	return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}
