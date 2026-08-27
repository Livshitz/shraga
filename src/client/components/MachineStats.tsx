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
  isActive: boolean;
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
  const [series, setSeries] = useState<number[]>([]);

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
        const b = binding(d.limits);
        if (b) setSeries(prev => [...prev, b.percent].slice(-WINDOW));
      } catch (err) {
        console.warn('[MachineStats] claude usage poll failed', err);
        if (alive) setUsage(null);
      }
    };
    void poll();
    const id = setInterval(poll, USAGE_POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, [getToken]);

  return <UsageMetric usage={usage} series={series} />;
}

/** Pure render — null usage (204, or any failure) renders NOTHING. Split from the fetching shell so
 *  the gate and the labelling are testable without a network or a DOM. */
export function UsageMetric({ usage, series }: { usage: Usage | null; series: number[] }) {
  const top = usage && binding(usage.limits);
  if (!usage || !top) return null;

  // Every window, each labelled from its OWN resets_at — the `weekly_*` kinds do NOT reset weekly.
  const detail = usage.limits
    .map(l => `${l.scopeLabel ?? l.kind} ${l.percent}%${untilLabel(l.resetsAt) ? ` (resets in ${untilLabel(l.resetsAt)})` : ''}`)
    .join('\n');
  const plan = usage.subscriptionType ? `claude ${usage.subscriptionType} — ` : 'claude ';

  return <Metric label="usage" value={top.percent} series={series} title={`${plan}${top.percent}% of the binding limit\n${detail}`} severity={top.severity} />;
}

/** The window that actually gates you is the fullest one, whichever kind it happens to be. */
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

function level(v: number, severity?: string) {
  // A non-normal severity from the server outranks our own thresholds — it knows about
  // soft caps and approaching-limit states that a raw percentage doesn't show.
  if (severity && severity !== 'normal') return severity === 'critical' ? 'text-red-500' : 'text-amber-500';
  return v >= 90 ? 'text-red-500' : v >= 75 ? 'text-amber-500' : 'text-emerald-500';
}

function Metric({ label, value, series, title, severity }: { label: string; value: number; series: number[]; title?: string; severity?: string }) {
  const tone = level(value, severity);
  return (
    <span className="flex items-center gap-1" title={title ?? `${label} ${value}% — last ${series.length} samples`}>
      <span className="uppercase tracking-wide">{label}</span>
      <Sparkline series={series} className={tone} />
      <span className={cn('tabular-nums', tone)}>{value}%</span>
    </span>
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
