/** Human "time until reset", derived from a resets_at timestamp only — never from a window's kind
 *  name. Rounded to whole minutes FIRST so a value handed in as exactly 4h does not render "3h 59m"
 *  because a few milliseconds elapsed between building it and reading the clock.
 *  Compact "time until" an ISO timestamp. null when absent, unparseable, or already past. */
export function untilLabel(iso: string | null, now = Date.now()): string | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const min = Math.round(ms / 60_000);
  if (min < 1) return '1m';
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60), m = min % 60;
  if (h < 48) return m ? `${h}h ${m}m` : `${h}h`;
  const d = Math.floor(h / 24), rh = h % 24;
  return rh ? `${d}d ${rh}h` : `${d}d`;
}

// The vendor renders the rate-limit reset as a bare wall-clock time in UTC ("resets 1pm (UTC)"),
// which is unreadable at a glance from any other timezone and says nothing about how long is left.
const RESETS_RE = /resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*\(UTC\)/i;

/** Rewrite a UTC reset stamp in an error message into the viewer's local time plus a countdown.
 *  `anchorMs` (the message's own timestamp) picks the DAY — so a week-old failure doesn't roll its
 *  reset forward to tomorrow — while `now` drives the countdown, which is dropped once it's past. */
export function annotateLimitReset(text: string, anchorMs = Date.now(), now = Date.now()): string {
  const m = text.match(RESETS_RE);
  if (!m) return text;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ap = m[3]?.toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return text;

  const a = new Date(anchorMs);
  const reset = new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate(), h, min));
  if (reset.getTime() <= anchorMs) reset.setUTCDate(reset.getUTCDate() + 1);

  const local = reset.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const left = untilLabel(reset.toISOString(), now);
  return text.replace(m[0], `resets ${local}${left ? ` (in ${left})` : ''}`);
}
