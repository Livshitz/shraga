import { useEffect, useState } from 'react';
import type { AgentSocket, ServerEvent } from '@/lib/ws';
import { cn } from '@/lib/utils';

type Sample = Extract<ServerEvent, { type: 'stats' }>['sample'];

export interface UsageLimit {
  kind: string;
  group: string;
  percent: number;
  severity: string;
  resetsAt: string | null;
  scopeLabel?: string;
}
export interface Usage { subscriptionType: string | null; limits: UsageLimit[] }

const WINDOW = 120;
const USAGE_POLL_MS = 60_000;

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
    <div className="flex items-center justify-center gap-2 text-[10px] text-muted-foreground/60">
      <Metric label="cpu" value={latest.cpu} series={samples.map(s => s.cpu)} />
      <Metric label="mem" value={latest.mem} series={samples.map(s => s.mem)} />
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
    const poll = async () => {
      try {
        const t = await getToken();
        if (!t) return;
        const r = await fetch('/api/claude-usage', { headers: { Authorization: `Bearer ${t}` } });
        if (!alive) return;
        // 204 = not a subscription deployment. Anything non-OK = fail closed, same outcome.
        if (r.status !== 200) { setUsage(null); return; }
        const d: Usage = await r.json();
        if (!alive || !d?.limits?.length) return;
        setUsage(d);
      } catch (err) {
        console.warn('[MachineStats] claude usage poll failed', err);
        if (alive) setUsage(null);
      }
    };
    void poll();
    const id = setInterval(poll, USAGE_POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, [getToken]);

  return <UsageMetric usage={usage} />;
}

/** Pure render — null usage (204, or any failure) renders NOTHING. Split from the fetching shell so
 *  the gate and the labelling are testable without a network or a DOM. */
export function UsageMetric({ usage }: { usage: Usage | null }) {
  const top = usage && binding(usage.limits);
  if (!usage || !top) return null;

  // Every window, each labelled from its OWN resets_at — the `weekly_*` kinds do NOT reset weekly.
  const detail = usage.limits
    .map(l => `${l.scopeLabel ?? l.kind} ${l.percent}%${untilLabel(l.resetsAt) ? ` (resets in ${untilLabel(l.resetsAt)})` : ''}`)
    .join('\n');
  const plan = usage.subscriptionType ? `claude ${usage.subscriptionType} — ` : 'claude ';

  // No `series`: usage has no server-side history to seed from, so it renders a GAUGE (full from the
  // first paint) instead of a sparkline that would plot tab-uptime and be empty for the first minutes.
  return <Metric label="usage" value={top.percent} title={`${plan}${top.percent}% of the binding limit\n${detail}`} severity={top.severity} />;
}

/** The window that gates you first is simply the FULLEST one, whichever kind it is.
 *  We deliberately ignore the endpoint's `is_active`: observed live on prod, `weekly_all` reports
 *  `is_active: false` while genuinely accruing (1%, a real future resets_at, corroborated by
 *  seven_day.utilization: 1.0). So the flag marks the window the vendor considers CURRENTLY binding,
 *  not "this window is running" — filtering on it under-reports and is falsely reassuring. */
export function binding(limits: UsageLimit[]): UsageLimit | null {
  return limits.reduce<UsageLimit | null>((best, l) => (!best || l.percent > best.percent ? l : best), null);
}

/** Human "time until reset", derived from resets_at only — never from the limit's kind name. */
export function untilLabel(iso: string | null): string | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.max(1, Math.round(ms / 60_000))}m`;
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

/** Only severities we have actually SEEN mean something here. The vendor's vocabulary is not
 *  documented and not fully observed, so an unrecognised value falls through to the percentage
 *  thresholds — treating "anything that isn't normal" as elevated would paint the widget a
 *  permanent amber the first time the endpoint adds a benign new word. */
const ELEVATED: Record<string, string> = { critical: 'text-red-500', exceeded: 'text-red-500', warning: 'text-amber-500', warn: 'text-amber-500' };

function level(v: number, severity?: string) {
  const known = severity ? ELEVATED[severity] : undefined;
  if (known) return known;
  return v >= 90 ? 'text-red-500' : v >= 75 ? 'text-amber-500' : 'text-emerald-500';
}

function Metric({ label, value, series, title, severity }: { label: string; value: number; series?: number[]; title?: string; severity?: string }) {
  const tone = level(value, severity);
  return (
    <span className="flex items-center gap-1" title={title ?? `${label} ${value}%${series ? ` — last ${series.length} samples` : ''}`}>
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
