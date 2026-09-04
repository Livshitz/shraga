import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentSocket, ServerEvent } from '@/lib/ws';
import { cn } from '@/lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { DISK_WARN_PCT, DISK_CRIT_PCT, formatBytes } from '../../shared/disk';

type Sample = Extract<ServerEvent, { type: 'stats' }>['sample'];

export interface UsageLimit {
  kind: string;
  group: string;
  percent: number;
  severity: string;
  resetsAt: string | null;
  scopeLabel?: string;
}
export interface Usage {
  subscriptionType: string | null;
  /** The Claude account whose quota this is (email, else display name). */
  account?: string | null;
  limits: UsageLimit[];
  /** When the server last actually read these numbers from upstream (ISO). */
  fetchedAt?: string;
  /** Server is serving its last known-good reading because the live attempt failed. */
  stale?: boolean;
}

const WINDOW = 120;
// The upstream usage endpoint rate-limits hard and the numbers move slowly, so poll lazily: every
// 5 min, and ONLY while this tab is visible. A wall of forgotten tabs was what kept the server in a
// permanent 429 penalty box.
const USAGE_POLL_MS = 300_000;

interface Props {
  socket: AgentSocket | null;
  getToken: () => Promise<string | null>;
}

// One shared sampler runs on the server; this just renders what it broadcasts.
export function MachineStats({ socket, getToken }: Props) {
  const [samples, setSamples] = useState<Sample[]>([]);

  // Seed from the cached server buffer once.
  useEffect(() => {
    getToken()
      .then(t => (t ? fetch('/api/stats', { headers: { Authorization: `Bearer ${t}` } }) : null))
      .then(r => r?.json())
      .then(d => d?.samples && setSamples(d.samples))
      .catch(err => console.warn('[MachineStats] seed failed', err));
  }, [getToken]);

  // Append live points over WS.
  useEffect(() => {
    if (!socket) return;
    const off = socket.on(ev => {
      if (ev.type === 'stats') {
        setSamples(prev => [...prev, ev.sample].slice(-WINDOW));
      }
    });
    return () => { off(); };
  }, [socket]);

  if (!samples.length) return null;
  const latest = samples[samples.length - 1];

  return (
    // Wraps: three metrics do not fit one row in the w-64 sidebar (~302px of content, ~223px of box),
    // and no amount of label/glyph trimming closes that gap without shrinking the CPU/MEM sparklines.
    // w-full pins the row to the container so a wrapped line still centres against the sidebar.
    <div className="w-full flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground/60">
      <Metric label="cpu" value={latest.cpu} series={samples.map(s => s.cpu)} />
      <Metric label="mem" value={latest.mem} series={samples.map(s => s.mem)} />
      {latest.disk >= 0 && (
        // Gauge, not sparkline: the server refreshes disk once a minute, so a 10-min trend line would
        // be a near-flat 10-point stair that reads as broken. A current-value bar is the honest shape.
        <Metric label="disk" value={latest.disk} severity={diskSeverity(latest.disk)}
                title={diskTip(latest)} />
      )}
      <ClaudeUsageMetric getToken={getToken} />
    </div>
  );
}

// Claude Code subscription usage. Absent entirely unless the server can PROVE this box is on a
// subscription — it answers 204 otherwise, and 204 (like any failure here) renders nothing.
function ClaudeUsageMetric({ getToken }: { getToken: () => Promise<string | null> }) {
  const [usage, setUsage] = useState<Usage | null>(null);

  useEffect(() => {
    let alive = true;
    let last = 0;
    const poll = async () => {
      try {
        const t = await getToken();
        if (!t) return;
        last = Date.now();
        const r = await fetch('/api/claude-usage', { headers: { Authorization: `Bearer ${t}` } });
        if (!alive) return;
        // 204 = this box was never proven to be on a subscription: render nothing. Any OTHER non-OK is
        // a transient failure — KEEP the reading on screen (labelled with its age) rather than making
        // the gauge blink out of existence, which is what made it look broken.
        if (r.status === 204) { setUsage(null); return; }
        if (r.status !== 200) return;
        const d: Usage = await r.json();
        if (!alive || !d?.limits?.length) return;
        setUsage(d);
      } catch (err) {
        console.warn('[MachineStats] claude usage poll failed', err);
      }
    };
    // A hidden tab is nobody watching: skip the tick entirely rather than paying an upstream call.
    const tick = () => { if (document.visibilityState === 'visible') void poll(); };
    // Coming back to the tab shows a stale gauge otherwise — refresh only if the interval was missed.
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - last >= USAGE_POLL_MS) void poll();
    };
    tick();
    const id = setInterval(tick, USAGE_POLL_MS);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [getToken]);

  return <UsageMetric usage={usage} />;
}

/** Pure render — null usage (204, or any failure) renders NOTHING. Split from the fetching shell so
 *  the gate and the labelling are testable without a network or a DOM. */
export function UsageMetric({ usage }: { usage: Usage | null }) {
  const top = usage && binding(usage.limits);
  const [state, setState] = useState<CardState>(CLOSED);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancel = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  const send = useCallback((ev: CardEvent, delayMs = 0) => {
    cancel();
    if (!delayMs) { setState(prev => nextCardState(prev, ev)); return; }
    timer.current = setTimeout(() => { timer.current = null; setState(prev => nextCardState(prev, ev)); }, delayMs);
  }, []);
  useEffect(() => cancel, []);

  if (!usage || !top) return null;

  // No `series`: usage has no server-side history to seed from, so it renders a GAUGE (full from the
  // first paint) instead of a sparkline that would plot tab-uptime and be empty for the first minutes.
  // No `title` either — the breakdown lives in the card below; a native tooltip on the same element
  // would race it, appear a second late, and repeat the card word for word.
  //
  // The trigger is a real <button>: it must be tappable (Radix HoverCard was pointer-only, so the
  // breakdown was flat-out unreachable on a phone) AND focusable, so Enter/Space opens it too.
  // Hover is layered on top of that so a desktop mouse still just points at it.
  return (
    <Popover open={state.open} onOpenChange={o => send(o ? { type: 'activate' } : { type: 'dismiss' })}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="claude usage breakdown"
          className="cursor-default rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onPointerEnter={e => send({ type: 'pointerenter', pointerType: e.pointerType }, HOVER_OPEN_MS)}
          onPointerLeave={e => send({ type: 'pointerleave', pointerType: e.pointerType }, HOVER_CLOSE_MS)}
        >
          <Metric label="usage" value={top.percent} severity={top.severity} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        // A hover-opened card must not steal focus — that would yank the caret out of the composer
        // just because the mouse crossed the strip. Escape still closes it: the dismissable layer
        // listens on the document, not on the content's own focus.
        onOpenAutoFocus={e => e.preventDefault()}
        onPointerEnter={() => cancel()}
        onPointerLeave={e => send({ type: 'pointerleave', pointerType: e.pointerType }, HOVER_CLOSE_MS)}
      >
        <UsageCard usage={usage} />
      </PopoverContent>
    </Popover>
  );
}

const HOVER_OPEN_MS = 120;
const HOVER_CLOSE_MS = 80;

export interface CardState { open: boolean; byHover: boolean }
export type CardEvent =
  | { type: 'pointerenter' | 'pointerleave'; pointerType: string }
  | { type: 'activate' }   // tap, click or Enter/Space on the trigger (Radix reports it as open)
  | { type: 'dismiss' };   // Escape, outside press, or a second activation

export const CLOSED: CardState = { open: false, byHover: false };

/** Who may open and close the card, as a pure function so both interaction modes are testable
 *  without a DOM. Two rules earn their keep:
 *   - hover is MOUSE-ONLY. A touch tap also emits pointerenter/pointerleave (pointerType 'touch'),
 *     and honouring those would open the card on touch-down and immediately close it again on lift.
 *   - a card opened deliberately (tap / click / keyboard) does NOT close when the pointer wanders
 *     off; only Escape, an outside press, or another activation dismisses it. */
export function nextCardState(state: CardState, ev: CardEvent): CardState {
  switch (ev.type) {
    case 'pointerenter':
      return isHoverPointer(ev.pointerType) ? { open: true, byHover: true } : state;
    case 'pointerleave':
      return isHoverPointer(ev.pointerType) && state.byHover ? CLOSED : state;
    case 'activate':
      return { open: true, byHover: false };
    case 'dismiss':
      return CLOSED;
  }
}

// '' covers synthetic/legacy events that carry no pointerType; a real touch always says 'touch'.
const isHoverPointer = (t: string) => t === 'mouse' || t === '';

/** The breakdown card: one row per reported window. Exported bare so the rows can be asserted
 *  without driving a real open (Radix only mounts the content once open). */
export function UsageCard({ usage }: { usage: Usage }) {
  const top = binding(usage.limits);
  return (
    <div className="text-[11px] leading-tight">
      <div className="flex items-baseline justify-between gap-2 pb-2 text-muted-foreground">
        <span className="uppercase tracking-wide">claude usage</span>
        {usage.subscriptionType && <span className="tabular-nums">{usage.subscriptionType} plan</span>}
      </div>
      <div className="-mt-1 flex items-baseline justify-between gap-2 pb-2 text-[10px] text-muted-foreground">
        {usage.account && <span className="truncate" title={usage.account}>{usage.account}</span>}
        <span className="shrink-0">{ageLabel(usage)}</span>
      </div>
      <div className="flex flex-col gap-3">
        {usage.limits.map((l, i) => {
          const until = untilLabel(l.resetsAt);
          const isTop = l === top;
          return (
            <div key={`${l.kind}-${i}`} data-headline={isTop || undefined} className={cn('flex flex-col gap-1', !isTop && 'opacity-60')}>
              <div className="flex items-baseline justify-between gap-2">
                <span className={cn('truncate', isTop && 'font-medium')}>
                  {isTop && <span className="mr-1 text-muted-foreground" aria-hidden>▸</span>}
                  {windowLabel(l)}
                </span>
                <span className={cn('tabular-nums shrink-0', level(l.percent, l.severity))}>{l.percent}%</span>
              </div>
              <Gauge value={l.percent} className={cn('w-full', level(l.percent, l.severity))} />
              <span className="text-[10px] text-muted-foreground">{until ? `resets in ${until}` : 'no reset reported'}</span>
            </div>
          );
        })}
      </div>
      <div className="mt-3 border-t pt-2 text-[10px] text-muted-foreground">▸ is the window the strip is showing</div>
    </div>
  );
}

/** Human name for a window, derived ONLY from what the payload actually states. `weekly_*` is never
 *  printed as "weekly"/"7 days": that window rolls on a ~72h cadence, so the kind name is a lie and
 *  only resets_at (rendered separately) tells the truth about its length. */
export function windowLabel(l: UsageLimit): string {
  if (l.scopeLabel) return `${l.scopeLabel} window`;
  if (l.kind === 'session') return 'current session';
  if (l.kind === 'weekly_all') return 'all models';
  return l.kind.replace(/_/g, ' ');
}

/** The window that gates you first is simply the FULLEST one, whichever kind it is.
 *  We deliberately ignore the endpoint's `is_active`: observed live on prod, `weekly_all` reports
 *  `is_active: false` while genuinely accruing (1%, a real future resets_at, corroborated by
 *  seven_day.utilization: 1.0). So the flag marks the window the vendor considers CURRENTLY binding,
 *  not "this window is running" — filtering on it under-reports and is falsely reassuring. */
export function binding(limits: UsageLimit[]): UsageLimit | null {
  return limits.reduce<UsageLimit | null>((best, l) => (!best || l.percent > best.percent ? l : best), null);
}

/** Human "time until reset", derived from resets_at only — never from the limit's kind name.
 *  Rounded to whole minutes FIRST so a value handed in as exactly 4h does not render "3h 59m"
 *  because a few milliseconds elapsed between building it and reading the clock. */
/** Between polls the numbers are, by definition, a past reading — say WHEN, so a still gauge reads as
 *  "last checked 3m ago" instead of "stuck". `stale` additionally means the last attempt failed. */
export function ageLabel(usage: Pick<Usage, 'fetchedAt' | 'stale'>): string {
  const ago = agoLabel(usage.fetchedAt);
  if (!ago) return usage.stale ? 'last reading — refresh failed' : 'updated just now';
  return usage.stale ? `${ago} old — refresh failed` : `updated ${ago} ago`;
}

/** Compact "how long since" for a past ISO timestamp. null when absent or unparseable. */
export function agoLabel(iso: string | undefined): string | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return null;
  const min = Math.round(Math.max(0, ms) / 60_000);
  if (min < 1) return null;
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60), m = min % 60;
  if (h < 24) return m ? `${h}h ${m}m` : `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function untilLabel(iso: string | null): string | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const min = Math.round(ms / 60_000);
  if (min < 1) return '1m';
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60), m = min % 60;
  if (h < 48) return m ? `${h}h ${m}m` : `${h}h`;
  const d = Math.floor(h / 24), rh = h % 24;
  return rh ? `${d}d ${rh}h` : `${d}d`;
}

/** Only severities we have actually SEEN mean something here. The vendor's vocabulary is not
 *  documented and not fully observed, so an unrecognised value falls through to the percentage
 *  thresholds — treating "anything that isn't normal" as elevated would paint the widget a
 *  permanent amber the first time the endpoint adds a benign new word. 'ok' is ours, not the
 *  vendor's: it lets a metric with its OWN bands (disk) say "fine" instead of inheriting 75/90. */
// Thresholds come from the one shared module the server reads too (src/shared/disk.ts) — re-exported
// here so existing importers of this component keep their import site. Not re-declared: a second
// literal is a drift waiting to happen.
export { DISK_WARN_PCT, DISK_CRIT_PCT };

/** Disk has its own bands: 80% full is unremarkable for a disk, so it must NOT inherit the generic
 *  75/90 percent colouring — hence an explicit 'ok' rather than falling through to those. */
export function diskSeverity(pct: number): string {
  return pct >= DISK_CRIT_PCT ? 'critical' : pct >= DISK_WARN_PCT ? 'warning' : 'ok';
}

const ELEVATED: Record<string, string> = { critical: 'text-red-500', exceeded: 'text-red-500', warning: 'text-amber-500', warn: 'text-amber-500', ok: 'text-emerald-500' };

function level(v: number, severity?: string) {
  const known = severity ? ELEVATED[severity] : undefined;
  if (known) return known;
  return v >= 90 ? 'text-red-500' : v >= 75 ? 'text-amber-500' : 'text-emerald-500';
}

/**
 * Hover text. The percentage alone cannot tell you whether 93% is 3GB or 300GB left, which is the
 * first thing anyone asks when they see it amber — so the tooltip carries the actual figures. Falls
 * back to the bare percentage on a sample from a server too old to send the byte fields.
 */
function diskTip(s: { disk: number; diskUsedBytes?: number; diskTotalBytes?: number }): string {
  const bounds = `warn at ${DISK_WARN_PCT}%, critical at ${DISK_CRIT_PCT}%`;
  if (s.diskUsedBytes == null || s.diskTotalBytes == null) return `disk ${s.disk}% used — ${bounds}`;
  const free = Math.max(0, s.diskTotalBytes - s.diskUsedBytes);
  return `disk ${s.disk}% used — ${formatBytes(s.diskUsedBytes)} of ${formatBytes(s.diskTotalBytes)}, `
    + `${formatBytes(free)} free — ${bounds}`;
}

function Metric({ label, value, series, title, severity }: { label: string; value: number; series?: number[]; title?: string; severity?: string }) {
  const tone = level(value, severity);
  // Plain-text fallback only where nothing richer exists (cpu/mem). The usage metric passes no title:
  // it owns a popover card, and a native tooltip on the same element would double up on it.
  const tip = title ?? (series ? `${label} ${value}% — last ${series.length} samples` : undefined);
  return (
    <span className="flex items-center gap-1" title={tip}>
      <span className="uppercase tracking-wide">{label}</span>
      {series ? <Sparkline series={series} className={tone} /> : <Gauge value={value} className={tone} />}
      <span className={cn('tabular-nums', tone)}>{value}%</span>
    </span>
  );
}

// Same 40x12 footprint as the sparkline, so the strip stays one row of like-sized glyphs — but it
// shows a single CURRENT value and is therefore correct and complete on the very first render.
function Gauge({ value, className }: { value: number; className?: string }) {
  const W = 40, H = 12, w = (Math.max(0, Math.min(100, value)) / 100) * W;
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className={cn('overflow-visible', className)} preserveAspectRatio="none">
      <rect x={0} y={H / 2 - 2} width={W} height={4} rx={2} fill="currentColor" opacity={0.2} />
      {w > 0 && <rect x={0} y={H / 2 - 2} width={w} height={4} rx={2} fill="currentColor" />}
    </svg>
  );
}

// Inline SVG sparkline (0-100 domain) — no chart lib, fixed viewBox so it scales crisply.
function Sparkline({ series, className }: { series: number[]; className?: string }) {
  const W = 40, H = 12;
  const n = series.length;
  if (n < 2) return null; // one point is a dot at x=0, not a trend — draw nothing until it's real
  const pts = series.map((v, i) => {
    const x = n > 1 ? (i / (n - 1)) * W : 0;
    const y = H - (Math.max(0, Math.min(100, v)) / 100) * H;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className={cn('overflow-visible', className)} preserveAspectRatio="none">
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth={1} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
