import { useMemo, useState } from 'react';
import cronstrue from 'cronstrue';
import type { Schedule, Trigger, Task } from '@/lib/schedule-types';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';
import { AutocompleteTextarea } from '../AutocompleteTextarea';

interface Props {
  initial?: Schedule;
  onSave: (s: Partial<Schedule>) => Promise<void>;
  onCancel: () => void;
  skills?: string[];
  workspaceFiles?: string[];
}

function localDateTimeValue(ts?: number): string {
  const d = new Date(ts ?? Date.now() + 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const INTERVAL_PRESETS = [
  { label: '1 min', ms: 60_000 },
  { label: '5 min', ms: 5 * 60_000 },
  { label: '15 min', ms: 15 * 60_000 },
  { label: '1 hour', ms: 60 * 60_000 },
  { label: '6 hours', ms: 6 * 60 * 60_000 },
  { label: '1 day', ms: 24 * 60 * 60_000 },
];

const CRON_PRESETS = [
  { label: 'Every hour', expr: '0 * * * *' },
  { label: 'Daily 9am', expr: '0 9 * * *' },
  { label: 'Weekdays 9am', expr: '0 9 * * 1-5' },
  { label: 'Mondays 9am', expr: '0 9 * * 1' },
];

/** Edits the optional `match` filter on an event trigger: a map of payload
 *  dot-paths → expected values. All entries must match (AND). Empty → fires on any. */
function MatchEditor({ match, onChange }: { match: Record<string, string>; onChange: (m: Record<string, string>) => void }) {
  const rows = Object.entries(match);
  const setRow = (i: number, key: string, value: string) => {
    const next: Record<string, string> = {};
    rows.forEach(([k, v], idx) => { next[idx === i ? key : k] = idx === i ? value : v; });
    onChange(next);
  };
  const removeRow = (i: number) => onChange(Object.fromEntries(rows.filter((_, idx) => idx !== i)));
  const addRow = () => onChange({ ...match, '': '' });

  return (
    <div className="space-y-1">
      <label className="text-xs text-muted-foreground">Match filter (optional — all must match)</label>
      {rows.map(([k, v], i) => (
        <div key={i} className="flex gap-1">
          <Input className="text-xs font-mono" value={k} onChange={(e) => setRow(i, e.target.value, v)} placeholder="payload.path (e.g. type)" />
          <Input className="text-xs font-mono" value={v} onChange={(e) => setRow(i, k, e.target.value)} placeholder="value (e.g. invoice.paid)" />
          <Button type="button" variant="ghost" size="sm" onClick={() => removeRow(i)}>×</Button>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={addRow}>+ Add filter</Button>
    </div>
  );
}

export function ScheduleEditor({ initial, onSave, onCancel, skills = [], workspaceFiles = [] }: Props) {
  const tz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
  const [name, setName] = useState(initial?.name ?? 'New schedule');
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [trigger, setTrigger] = useState<Trigger>(
    initial?.trigger ?? { kind: 'cron', expr: '0 9 * * *', tz }
  );
  const [task, setTask] = useState<Task>(
    initial?.task ?? { kind: 'prompt', prompt: '' }
  );
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const cronDesc = useMemo(() => {
    if (trigger.kind !== 'cron') return '';
    try { return cronstrue.toString(trigger.expr); } catch { return 'Invalid cron'; }
  }, [trigger]);

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      await onSave({ name, enabled, trigger, task });
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">Name</label>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Daily standup summary" />
      </div>

      {/* Trigger */}
      <div className="space-y-2">
        <label className="text-xs text-muted-foreground">Trigger</label>
        <div className="flex gap-1">
          {(['once', 'interval', 'cron', 'event'] as const).map((k) => (
            <Button
              key={k}
              type="button"
              variant={trigger.kind === k ? 'default' : 'outline'}
              size="sm"
              onClick={() => {
                if (k === 'once') setTrigger({ kind: 'once', at: Date.now() + 5 * 60_000 });
                else if (k === 'interval') setTrigger({ kind: 'interval', everyMs: 60 * 60_000 });
                else if (k === 'event') setTrigger({ kind: 'event', source: '' });
                else setTrigger({ kind: 'cron', expr: '0 9 * * *', tz });
              }}
            >
              {k}
            </Button>
          ))}
        </div>

        {trigger.kind === 'once' && (
          <Input
            type="datetime-local"
            value={localDateTimeValue(trigger.at)}
            onChange={(e) => {
              const v = new Date(e.target.value);
              if (!isNaN(v.getTime())) setTrigger({ kind: 'once', at: v.getTime() });
            }}
          />
        )}

        {trigger.kind === 'interval' && (
          <div className="space-y-2">
            <div className="flex gap-1 flex-wrap">
              {INTERVAL_PRESETS.map((p) => (
                <Button
                  key={p.ms}
                  type="button"
                  variant={trigger.everyMs === p.ms ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setTrigger({ kind: 'interval', everyMs: p.ms })}
                >
                  {p.label}
                </Button>
              ))}
            </div>
            <Input
              type="number"
              min={1}
              value={Math.round(trigger.everyMs / 1000)}
              onChange={(e) => setTrigger({ kind: 'interval', everyMs: Math.max(1, Number(e.target.value)) * 1000 })}
              placeholder="seconds"
            />
            <p className="text-xs text-muted-foreground">Every {Math.round(trigger.everyMs / 1000)}s</p>
          </div>
        )}

        {trigger.kind === 'cron' && (
          <div className="space-y-2">
            <div className="flex gap-1 flex-wrap">
              {CRON_PRESETS.map((p) => (
                <Button
                  key={p.expr}
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setTrigger({ kind: 'cron', expr: p.expr, tz })}
                >
                  {p.label}
                </Button>
              ))}
            </div>
            <Input
              className="font-mono text-xs"
              value={trigger.expr}
              onChange={(e) => setTrigger({ ...trigger, expr: e.target.value })}
              placeholder="0 9 * * *"
            />
            <Input
              className="text-xs"
              value={trigger.tz}
              onChange={(e) => setTrigger({ ...trigger, tz: e.target.value })}
              placeholder="IANA timezone"
            />
            <p className="text-xs text-muted-foreground">{cronDesc} ({trigger.tz})</p>
          </div>
        )}

        {trigger.kind === 'event' && (
          <div className="space-y-2">
            <Input
              value={trigger.source}
              onChange={(e) => setTrigger({ ...trigger, source: e.target.value })}
              placeholder="Event source (e.g. stripe, github, deploy)"
            />
            <p className="text-xs text-muted-foreground">
              Fires when an event with this source arrives via <code>POST /api/events/{trigger.source || ':source'}</code> or <code>ctx.emitEvent()</code>.
            </p>
            <MatchEditor
              match={trigger.match ?? {}}
              onChange={(match) => setTrigger({ ...trigger, match })}
            />
          </div>
        )}
      </div>

      {/* Task */}
      <div className="space-y-2">
        <label className="text-xs text-muted-foreground">Task</label>
        <div className="flex gap-1">
          {(['prompt', 'bash'] as const).map((k) => (
            <Button
              key={k}
              type="button"
              variant={task.kind === k ? 'default' : 'outline'}
              size="sm"
              onClick={() => setTask(k === 'prompt' ? { kind: 'prompt', prompt: '' } : { kind: 'bash', command: '' })}
            >
              {k === 'prompt' ? 'Prompt' : 'Bash command'}
            </Button>
          ))}
        </div>
        {task.kind === 'prompt' ? (
          <AutocompleteTextarea
            rows={5}
            value={task.prompt}
            onChange={(val) => setTask({ ...task, prompt: val })}
            placeholder="What should the agent do? (@ for skills, / for commands)"
            skills={skills}
            workspaceFiles={workspaceFiles}
            autoResize={false}
            className="flex min-h-[80px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        ) : task.kind === 'bash' ? (
          <Textarea
            rows={3}
            className="font-mono text-xs"
            value={task.command}
            onChange={(e) => setTask({ ...task, command: e.target.value })}
            placeholder="ls -la ~/"
          />
        ) : (
          <p className="text-xs text-muted-foreground">Command: {task.command}</p>
        )}
      </div>

      <div className="flex items-center gap-2">
        <input id="sched-enabled" type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        <label htmlFor="sched-enabled" className="text-sm">Enabled</label>
      </div>

      {err && <p className="text-xs text-destructive">{err}</p>}

      <div className="flex justify-end gap-2 pt-2">
        <Button variant="outline" onClick={onCancel} disabled={saving}>Cancel</Button>
        <Button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
      </div>
    </div>
  );
}
