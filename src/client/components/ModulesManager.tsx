import { useState } from 'react';
import { Blocks, ChevronDown, ChevronRight, Trash2, Download, Loader2, Check } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from './ui/dialog';
import { useModules, type InstalledModule, type ModuleConfigSchema } from '@/hooks/useModules';

interface Props {
  getToken: () => Promise<string | null>;
  trigger?: React.ReactNode;
}

// Same inline-switch idiom as ConfigPanel's Skill Discovery toggle.
function Toggle({ checked, onChange, title, disabled }: { checked: boolean; onChange: (v: boolean) => void; title?: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      title={title}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${checked ? 'bg-primary' : 'bg-muted'}`}
    >
      <span className={`pointer-events-none block h-5 w-5 rounded-full bg-background shadow-lg ring-0 transition-transform ${checked ? 'translate-x-5' : 'translate-x-0'}`} />
    </button>
  );
}

function configSummary(m: InstalledModule): string {
  const keys = Object.keys(m.config ?? {});
  if (keys.length === 0) return '';
  return keys.slice(0, 3).map((k) => `${k}: ${String(m.config[k])}`).join(' · ') + (keys.length > 3 ? ` · +${keys.length - 3}` : '');
}

function ConfigForm({ schema, config, onSave, saving }: {
  schema: ModuleConfigSchema;
  config: Record<string, unknown>;
  onSave: (config: Record<string, unknown>) => void;
  saving: boolean;
}) {
  // Text/number fields are kept as strings while editing; coercion happens only on Save.
  const [draft, setDraft] = useState<Record<string, unknown>>(() => {
    const d: Record<string, unknown> = {};
    for (const [k, f] of Object.entries(schema)) {
      const v = config[k] ?? f.default;
      d[k] = f.type === 'boolean' ? Boolean(v) : v == null ? '' : String(v);
    }
    return d;
  });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const set = (k: string, v: unknown) => {
    setDraft((p) => ({ ...p, [k]: v }));
    setFieldErrors((p) => (p[k] ? { ...p, [k]: '' } : p));
  };
  const save = () => {
    const out: Record<string, unknown> = {};
    const errors: Record<string, string> = {};
    for (const [k, f] of Object.entries(schema)) {
      const v = draft[k];
      if (f.type === 'boolean') { out[k] = Boolean(v); continue; }
      const s = String(v ?? '').trim();
      if (f.type === 'number') {
        if (s === '') {
          // Empty → fall back to the schema default; omit the key when there is no usable default.
          if (typeof f.default === 'number' && Number.isFinite(f.default)) out[k] = f.default;
          continue;
        }
        const n = Number(s);
        if (!Number.isFinite(n)) { errors[k] = 'Not a number'; continue; }
        out[k] = n;
      } else {
        out[k] = s;
      }
    }
    if (Object.values(errors).some(Boolean)) { setFieldErrors(errors); return; }
    setFieldErrors({});
    onSave(out);
  };
  return (
    <div className="space-y-2 pt-2">
      {Object.entries(schema).map(([key, field]) => (
        <div key={key} className="flex items-center gap-2">
          <label className="text-xs w-36 shrink-0 truncate" title={field.description || key}>{key}</label>
          {field.type === 'boolean' ? (
            <Toggle checked={Boolean(draft[key])} onChange={(v) => set(key, v)} />
          ) : (
            <div className="flex-1 min-w-0">
              <Input
                type="text"
                inputMode={field.type === 'number' ? 'decimal' : undefined}
                value={String(draft[key] ?? '')}
                onChange={(e) => set(key, e.target.value)}
                className={`h-7 text-xs w-full ${fieldErrors[key] ? 'border-destructive' : ''}`}
                placeholder={field.description}
              />
              {fieldErrors[key] && <p className="text-[10px] text-destructive mt-0.5">{fieldErrors[key]}</p>}
            </div>
          )}
        </div>
      ))}
      <Button size="sm" className="h-6 text-xs" disabled={saving} onClick={save}>
        {saving ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Check className="w-3 h-3 mr-1" />} Save config
      </Button>
    </div>
  );
}

export function ModulesManager({ getToken, trigger }: Props) {
  const [open, setOpen] = useState(false);
  const { installed, available, unsupported, loading, error, install, toggle, updateConfig, uninstall } = useModules(getToken, open);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const run = async (key: string, fn: () => Promise<void>) => {
    if (busy) return; // one action in flight at a time
    setBusy(key);
    setActionError(null);
    try { await fn(); } catch (e: any) { setActionError(e.message); } finally { setBusy(null); }
  };

  const notInstalled = available.filter((a) => !a.installed);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger || (
          <Button variant="ghost" size="icon" title="Modules" className="h-8 w-8">
            <Blocks className="w-4 h-4" />
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-[95vw] sm:max-w-2xl h-[70dvh] sm:h-[520px] flex flex-col gap-0 p-0">
        <DialogHeader className="px-4 pt-4 pb-2 border-b shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <Blocks className="w-4 h-4" /> Modules
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto p-3 space-y-4">
          {unsupported && (
            <p className="text-sm text-muted-foreground text-center py-8">
              This server does not support modules yet.
            </p>
          )}
          {(error || actionError) && (
            <p className="text-xs text-destructive">{actionError || error}</p>
          )}
          {loading && installed.length === 0 && !unsupported && (
            <p className="text-sm text-muted-foreground text-center py-8">Loading…</p>
          )}

          {!unsupported && !loading && installed.length === 0 && notInstalled.length === 0 && !error && (
            <p className="text-sm text-muted-foreground text-center py-8">No modules available.</p>
          )}

          {installed.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Installed</h3>
              {installed.map((m) => {
                const isExpanded = expanded === m.name;
                const hasSchema = m.configSchema && Object.keys(m.configSchema).length > 0;
                const artifacts = [
                  m.skillCount ? `provides ${m.skillCount} skill${m.skillCount === 1 ? '' : 's'}` : '',
                  m.scheduleCount ? `${m.scheduleCount} schedule${m.scheduleCount === 1 ? '' : 's'}` : '',
                ].filter(Boolean).join(', ');
                return (
                  <div key={m.name} className="border rounded-lg p-3 space-y-1">
                    <div className="flex items-center gap-2">
                      <Toggle
                        checked={m.enabled}
                        onChange={(en) => run(`toggle-${m.name}`, () => toggle(m.name, en))}
                        title={m.enabled ? 'Disable' : 'Enable'}
                        disabled={busy === `toggle-${m.name}`}
                      />
                      <span className="font-medium text-sm truncate">{m.name}</span>
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-muted text-muted-foreground shrink-0">v{m.version}</span>
                      {!m.enabled && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground shrink-0">disabled</span>
                      )}
                      <div className="flex-1" />
                      {busy === `toggle-${m.name}` && <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />}
                      {(hasSchema || m.readme) && (
                        <button
                          className="text-muted-foreground hover:text-foreground transition-colors"
                          onClick={() => setExpanded(isExpanded ? null : m.name)}
                          title="Details"
                        >
                          {isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                        </button>
                      )}
                      <button
                        className="text-muted-foreground hover:text-destructive transition-colors"
                        onClick={() => { if (confirm(`Uninstall module "${m.name}"? Its skills and schedules will be removed (seeds/data stay).`)) run(`rm-${m.name}`, () => uninstall(m.name)); }}
                        title="Uninstall"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    {m.description && <p className="text-xs text-muted-foreground">{m.description}</p>}
                    {artifacts && <p className="text-[10px] text-muted-foreground">{artifacts}</p>}
                    {!isExpanded && configSummary(m) && (
                      <p className="text-[10px] font-mono text-muted-foreground truncate">{configSummary(m)}</p>
                    )}
                    {isExpanded && m.readme && (
                      <pre className="text-[11px] text-muted-foreground whitespace-pre-wrap font-sans bg-muted/40 rounded p-2 max-h-48 overflow-y-auto">{m.readme}</pre>
                    )}
                    {isExpanded && hasSchema && (
                      <ConfigForm
                        key={JSON.stringify(m.config)}
                        schema={m.configSchema!}
                        config={m.config}
                        saving={busy === `cfg-${m.name}`}
                        onSave={(cfg) => run(`cfg-${m.name}`, () => updateConfig(m.name, cfg))}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {notInstalled.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Available</h3>
              {notInstalled.map((m) => (
                <div key={m.name} className="border rounded-lg p-3 flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm truncate">{m.name}</span>
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-muted text-muted-foreground shrink-0">v{m.version}</span>
                    </div>
                    {m.description && <p className="text-xs text-muted-foreground">{m.description}</p>}
                  </div>
                  <Button
                    size="sm" variant="outline" className="h-7 text-xs shrink-0"
                    disabled={busy === `install-${m.name}`}
                    onClick={() => run(`install-${m.name}`, () => install({ name: m.name }))}
                  >
                    {busy === `install-${m.name}` ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Download className="w-3 h-3 mr-1" />}
                    Install
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
