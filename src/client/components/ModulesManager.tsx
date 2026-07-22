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

function Toggle({ checked, onChange, title }: { checked: boolean; onChange: (v: boolean) => void; title?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      title={title}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex shrink-0 items-center rounded-full transition-colors ${checked ? 'bg-primary' : 'bg-muted-foreground/30'}`}
      style={{ height: 18, width: 32 }}
    >
      <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transform transition-transform ${checked ? 'translate-x-[15px]' : 'translate-x-[2px]'}`} />
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
  const [draft, setDraft] = useState<Record<string, unknown>>(() => {
    const d: Record<string, unknown> = {};
    for (const [k, f] of Object.entries(schema)) d[k] = config[k] ?? f.default;
    return d;
  });
  const set = (k: string, v: unknown) => setDraft((p) => ({ ...p, [k]: v }));
  return (
    <div className="space-y-2 pt-2">
      {Object.entries(schema).map(([key, field]) => (
        <div key={key} className="flex items-center gap-2">
          <label className="text-xs w-36 shrink-0 truncate" title={field.description || key}>{key}</label>
          {field.type === 'boolean' ? (
            <Toggle checked={Boolean(draft[key])} onChange={(v) => set(key, v)} />
          ) : (
            <Input
              type={field.type === 'number' ? 'number' : 'text'}
              value={String(draft[key] ?? '')}
              onChange={(e) => set(key, field.type === 'number' ? Number(e.target.value) : e.target.value)}
              className="h-7 text-xs flex-1"
              placeholder={field.description}
            />
          )}
        </div>
      ))}
      <Button size="sm" className="h-6 text-xs" disabled={saving} onClick={() => onSave(draft)}>
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
                      />
                      <span className="font-medium text-sm truncate">{m.name}</span>
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-muted text-muted-foreground shrink-0">v{m.version}</span>
                      {!m.enabled && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground shrink-0">disabled</span>
                      )}
                      <div className="flex-1" />
                      {busy === `toggle-${m.name}` && <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />}
                      {hasSchema && (
                        <button
                          className="text-muted-foreground hover:text-foreground transition-colors"
                          onClick={() => setExpanded(isExpanded ? null : m.name)}
                          title="Configure"
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
