import { useEffect, useState } from 'react';
import type { AgentSocket, ServerEvent } from '@/lib/ws';
import { cn } from '@/lib/utils';

type Sample = Extract<ServerEvent, { type: 'stats' }>['sample'];

const WINDOW = 120;

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
    </div>
  );
}

function level(v: number) {
  return v >= 90 ? 'text-red-500' : v >= 75 ? 'text-amber-500' : 'text-emerald-500';
}

function Metric({ label, value, series }: { label: string; value: number; series: number[] }) {
  return (
    <span className="flex items-center gap-1" title={`${label} ${value}% — last ${series.length} samples`}>
      <span className="uppercase tracking-wide">{label}</span>
      <Sparkline series={series} className={level(value)} />
      <span className={cn('tabular-nums', level(value))}>{value}%</span>
    </span>
  );
}

// Inline SVG sparkline (0-100 domain) — no chart lib, fixed viewBox so it scales crisply.
function Sparkline({ series, className }: { series: number[]; className?: string }) {
  const W = 40, H = 12;
  const n = series.length;
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
