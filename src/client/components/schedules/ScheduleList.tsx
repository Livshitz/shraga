import { useState } from 'react';
import cronstrue from 'cronstrue';
import { Loader2, Play, Square, Pencil, Trash2, Plus } from 'lucide-react';
import type { Schedule } from '@/lib/schedule-types';
import { Button } from '../ui/button';

type FilterKey = 'mine' | 'others' | 'system';
type TriggerFilterKey = 'once' | 'interval' | 'cron' | 'event';

function triggerKind(s: Schedule): TriggerFilterKey {
  return s.trigger.kind as TriggerFilterKey;
}

interface Props {
  schedules: Schedule[];
  currentUserUid?: string;
  onCreate: () => void;
  onEdit: (s: Schedule) => void;
  onDelete: (id: string) => void;
  onToggle: (id: string, enabled: boolean) => void;
  onRunNow: (id: string, override?: string) => Promise<string | undefined>;
  onCancel: (id: string) => void;
  onOpenRun: (sessionId: string) => void;
  runningIds?: Set<string>;
}

function describeTrigger(s: Schedule): string {
  const t = s.trigger;
  if (t.kind === 'once') return `Once at ${new Date(t.at).toLocaleString()}`;
  if (t.kind === 'interval') {
    const sec = Math.round(t.everyMs / 1000);
    if (sec >= 86400) return `Every ${Math.round(sec / 86400)}d`;
    if (sec >= 3600) return `Every ${Math.round(sec / 3600)}h`;
    if (sec >= 60) return `Every ${Math.round(sec / 60)}m`;
    return `Every ${sec}s`;
  }
  if (t.kind === 'event') {
    const filters = t.match ? Object.entries(t.match).map(([k, v]) => `${k}=${v}`).join(', ') : '';
    return `On event "${t.source}"${filters ? ` where ${filters}` : ''}`;
  }
  try {
    const tz = t.tz || 'UTC';
    const utcDesc = formatCronUTC(t.expr, tz);
    const humanDesc = cronstrue.toString(t.expr);
    const tzLabel = tz === 'UTC' ? 'UTC' : tz.split('/').pop()?.replace(/_/g, ' ') || tz;
    return utcDesc ? `${utcDesc} (${humanDesc} ${tzLabel})` : `${humanDesc} ${tzLabel}`;
  } catch { return t.expr; }
}

function formatCronUTC(expr: string, tz: string): string | null {
  try {
    const parts = expr.split(/\s+/);
    if (parts.length < 5) return null;
    const min = parseInt(parts[0], 10);
    const hour = parseInt(parts[1], 10);
    if (isNaN(min) || isNaN(hour)) return null;
    // Cron hour:min is in `tz` — convert to UTC
    const now = new Date();
    const tzOffset = new Date(now.toLocaleString('en-US', { timeZone: tz })).getTime()
      - new Date(now.toLocaleString('en-US', { timeZone: 'UTC' })).getTime();
    const ref = new Date();
    ref.setUTCHours(hour, min, 0, 0);
    const utc = new Date(ref.getTime() - tzOffset);
    return utc.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });
  } catch { return null; }
}

function relTime(ts?: number): string {
  if (!ts) return '—';
  const diff = ts - Date.now();
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  if (abs < 60000) return diff > 0 ? 'in <1m' : '<1m ago';
  if (mins < 60) return diff > 0 ? `in ${mins}m` : `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return diff > 0 ? `in ${hrs}h` : `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return diff > 0 ? `in ${days}d` : `${days}d ago`;
}

const STATUS_COLORS: Record<string, string> = {
  ok: 'bg-green-50 text-green-700 dark:bg-green-950/50 dark:text-green-300',
  error: 'bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-300',
  running: 'bg-blue-50 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300',
  aborted: 'bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300',
};

function isSystemSchedule(s: Schedule): boolean {
  return s.scope === 'system';
}

function overrideLabel(kind: string): string {
  if (kind === 'prompt') return 'Additional instructions (appended to prompt)';
  if (kind === 'bash') return 'Override command';
  return 'Override args';
}

function overridePlaceholder(kind: string): string {
  if (kind === 'prompt') return 'e.g. Dry run — compose the message but do NOT post to Slack';
  if (kind === 'bash') return 'e.g. bun run report:fb-ads-spend --dry-run';
  return 'e.g. --dry-run';
}

function classifySchedule(s: Schedule, currentUid?: string): FilterKey {
  if (s.scope === 'system') return 'system';
  return s.createdBy?.uid === currentUid ? 'mine' : 'others';
}

export function ScheduleList({ schedules, currentUserUid, onCreate, onEdit, onDelete, onToggle, onRunNow, onCancel, onOpenRun, runningIds = new Set() }: Props) {
  const [runModalId, setRunModalId] = useState<string | null>(null);
  const [overrideText, setOverrideText] = useState('');
  const [filters, setFilters] = useState<Record<FilterKey, boolean>>({ mine: true, others: true, system: true });
  const [triggerFilters, setTriggerFilters] = useState<Record<TriggerFilterKey, boolean>>({ once: true, interval: true, cron: true, event: true });
  const [running, setRunning] = useState(false);

  const toggleFilter = (key: FilterKey) => setFilters((f) => {
    const allOn = Object.values(f).every(Boolean);
    if (allOn) return { mine: false, others: false, system: false, [key]: true };
    const next = { ...f, [key]: !f[key] };
    if (!Object.values(next).some(Boolean)) return { mine: true, others: true, system: true };
    return next;
  });
  const toggleTriggerFilter = (key: TriggerFilterKey) => setTriggerFilters((f) => {
    const allOn = Object.values(f).every(Boolean);
    if (allOn) return { once: false, interval: false, cron: false, event: false, [key]: true };
    const next = { ...f, [key]: !f[key] };
    if (!Object.values(next).some(Boolean)) return { once: true, interval: true, cron: true, event: true };
    return next;
  });

  const filtered = schedules.filter((s) => filters[classifySchedule(s, currentUserUid)] && triggerFilters[triggerKind(s)]);

  const handlePlay = (s: Schedule) => {
    const saved = localStorage.getItem(`schedule-override-${s.id}`);
    setOverrideText(saved ?? '');
    setRunModalId(s.id);
  };

  const handleRunConfirm = async () => {
    if (!runModalId) return;
    setRunning(true);
    try {
      const override = overrideText.trim() || undefined;
      if (override) {
        localStorage.setItem(`schedule-override-${runModalId}`, override);
      }
      const sessionId = await onRunNow(runModalId, override);
      setRunModalId(null);
      setOverrideText('');
      if (sessionId) onOpenRun(sessionId);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex gap-1 flex-wrap">
          {(['mine', 'others', 'system'] as const).map((key) => (
            <button
              key={key}
              onClick={() => toggleFilter(key)}
              className={`text-[11px] px-2 py-0.5 rounded-full border transition-colors ${filters[key] ? 'bg-primary text-primary-foreground border-primary' : 'bg-transparent text-muted-foreground border-border hover:border-muted-foreground'}`}
            >
              {key}
            </button>
          ))}
          <span className="w-px h-4 bg-border mx-1" />
          {(['once', 'interval', 'cron', 'event'] as const).map((key) => (
            <button
              key={key}
              onClick={() => toggleTriggerFilter(key)}
              className={`text-[11px] px-2 py-0.5 rounded-full border transition-colors ${triggerFilters[key] ? 'bg-primary text-primary-foreground border-primary' : 'bg-transparent text-muted-foreground border-border hover:border-muted-foreground'}`}
            >
              {key}
            </button>
          ))}
        </div>
        <Button size="sm" onClick={onCreate} className="gap-1"><Plus className="w-4 h-4" /> New schedule</Button>
      </div>

      {filtered.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-8">
          {schedules.length === 0 ? 'No schedules yet.' : 'No schedules match filters.'}
        </p>
      )}

      {filtered.map((s) => (
        <div key={s.id} className="border rounded-lg p-3 space-y-2 overflow-hidden">
          <div className="flex items-start justify-between gap-2 flex-wrap">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 min-w-0 flex-wrap">
                <input
                  type="checkbox"
                  checked={s.enabled}
                  onChange={(e) => onToggle(s.id, e.target.checked)}
                  title={s.enabled ? 'Disable' : 'Enable'}
                  className="shrink-0"
                />
                <span className="font-medium text-sm truncate max-w-[280px]" title={s.name}>{s.name}</span>
                <span className="shrink-0 text-[10px] font-mono px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                  {s.task.kind}
                </span>
                <span className="shrink-0 text-[10px] font-mono px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                  {s.trigger.kind}
                </span>
                {runningIds.has(s.id) && (
                  <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    running
                  </span>
                )}
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300">
                  {isSystemSchedule(s) ? 'system' : s.createdBy?.email?.split('@')[0] ?? 'unknown'}
                </span>
              </div>
              <div className="mt-1 text-xs text-muted-foreground truncate">{describeTrigger(s)}</div>
              <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
                <span>Next: {s.enabled ? relTime(s.nextRun) : 'disabled'}</span>
                {s.lastRun && (
                  <button
                    className={`px-1.5 py-0.5 rounded text-[10px] ${STATUS_COLORS[s.lastRun.status] ?? ''}`}
                    onClick={() => onOpenRun(s.lastRun!.sessionId)}
                    title="Open last run"
                  >
                    last: {s.lastRun.status} {relTime(s.lastRun.at)}
                  </button>
                )}
                <span>runs: {s.runCount ?? 0}</span>
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {runningIds.has(s.id) ? (
                <Button variant="ghost" size="icon" title="Stop run" onClick={() => onCancel(s.id)}>
                  <Square className="w-4 h-4 text-destructive" />
                </Button>
              ) : (
                <Button variant="ghost" size="icon" title="Run now" onClick={() => handlePlay(s)}>
                  <Play className="w-4 h-4" />
                </Button>
              )}
              <Button variant="ghost" size="icon" title="Edit" onClick={() => onEdit(s)}><Pencil className="w-4 h-4" /></Button>
              <Button variant="ghost" size="icon" title="Delete" onClick={() => onDelete(s.id)}><Trash2 className="w-4 h-4 text-destructive" /></Button>
            </div>
          </div>

          {runModalId === s.id && (
            <div className="border-t pt-2 mt-2 space-y-2">
              <label className="text-xs text-muted-foreground">{overrideLabel(s.task.kind)}</label>
              <input
                type="text"
                className="w-full text-sm border rounded px-2 py-1.5 bg-background"
                placeholder={overridePlaceholder(s.task.kind)}
                value={overrideText}
                onChange={(e) => setOverrideText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !running) handleRunConfirm(); if (e.key === 'Escape') setRunModalId(null); }}
                disabled={running}
                autoFocus
              />
              <div className="flex gap-2 justify-end">
                <Button size="sm" variant="ghost" onClick={() => setRunModalId(null)} disabled={running}>Cancel</Button>
                <Button size="sm" onClick={handleRunConfirm} disabled={running}>{running ? 'Running...' : 'Run'}</Button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
