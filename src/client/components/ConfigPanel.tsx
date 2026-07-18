import { useEffect, useRef, useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogBody, DialogFooter } from './ui/dialog';
import { useSlots } from '@/lib/slots';

interface AgentConfig {
  model?: string;
  engine?: string;
  systemPrompt?: string;
  allowedTools?: string[];
  permissionMode?: string;
  maxTurns?: number;
  skillDiscovery?: boolean;
  thinking?: 'adaptive' | 'enabled' | 'disabled';
  effort?: 'low' | 'medium' | 'high' | 'max';
}

interface EngineModel {
  value: string;
  label: string;
  provider?: string;
}

interface EngineInfo {
  name: string;
  models: EngineModel[];
}

const FALLBACK_MODELS: EngineModel[] = [
  { value: '', label: 'Default (claude-sonnet-5)' },
  { value: 'claude-fable-5', label: 'Fable 5 — frontier, most capable' },
  { value: 'claude-opus-4-8', label: 'Opus 4.8 — most capable, best for complex/agentic tasks' },
  { value: 'claude-opus-4-7', label: 'Opus 4.7' },
  { value: 'claude-opus-4-6', label: 'Opus 4.6' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5 — balanced speed & intelligence' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { value: 'claude-haiku-4-5', label: 'Haiku 4.5 — fastest' },
];

const PERMISSION_MODES = [
  { value: 'acceptEdits', label: 'Accept Edits (auto-approve file changes)' },
  { value: 'plan', label: 'Plan (read-only, suggest changes)' },
  { value: 'bypassPermissions', label: 'Bypass All (dangerous — no prompts)' },
];

interface SessionDirectives { engine?: string; model?: string; turns?: number; thinking?: string }

interface Props {
  getToken: () => Promise<string | null>;
  onSaved?: (config: AgentConfig) => void;
  trigger?: React.ReactNode;
  /** When set, the runtime knobs (engine/model/turns/thinking) edit THIS session's directives. */
  sessionId?: string;
  sessionDirectives?: SessionDirectives;
  onDirectivesSaved?: (directives: SessionDirectives) => void;
}

export function ConfigPanel({ getToken, onSaved, trigger, sessionId, sessionDirectives, onDirectivesSaved }: Props) {
  const slots = useSlots();
  const [config, setConfig] = useState<AgentConfig>({});
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [engines, setEngines] = useState<EngineInfo[]>([]);
  const [multiEngine, setMultiEngine] = useState(false);
  // Global config as loaded — so a per-session runtime change doesn't clobber the global defaults.
  const globalRef = useRef<AgentConfig>({});

  useEffect(() => {
    if (!open) return;
    getToken().then((token) => {
      if (!token) return;
      fetch('/api/config', { headers: { Authorization: `Bearer ${token}` } })
        .then((r) => r.json())
        .then((global: AgentConfig) => {
          globalRef.current = global;
          // For an active session, the runtime knobs reflect the session's own directives
          // (falling back to the global default when the session hasn't overridden them).
          const sd = sessionId ? sessionDirectives : undefined;
          setConfig({
            ...global,
            ...(sd?.engine !== undefined ? { engine: sd.engine } : {}),
            ...(sd?.model !== undefined ? { model: sd.model } : {}),
            ...(sd?.turns !== undefined ? { maxTurns: sd.turns } : {}),
            ...(sd?.thinking !== undefined ? { thinking: sd.thinking as AgentConfig['thinking'] } : {}),
          });
        })
        .catch(() => {});
      fetch('/api/engines', { headers: { Authorization: `Bearer ${token}` } })
        .then((r) => r.json())
        .then((data) => {
          setEngines(data.engines ?? []);
          setMultiEngine(data.multiEngine ?? false);
        })
        .catch(() => {});
    });
  }, [open, getToken, sessionId, sessionDirectives]);

  const save = async () => {
    setSaving(true);
    const token = await getToken();
    const auth = { Authorization: `Bearer ${token ?? ''}`, 'Content-Type': 'application/json' };
    try {
      if (sessionId) {
        // Runtime knobs apply to THIS conversation (session directives shadow global at send time).
        const runtime: SessionDirectives = {
          engine: config.engine, model: config.model, turns: config.maxTurns, thinking: config.thinking,
        };
        const r = await fetch(`/api/sessions/${sessionId}/directives`, { method: 'PUT', headers: auth, body: JSON.stringify(runtime) })
          .then((res) => res.json()).catch((e) => { console.warn('[config] directives save failed', e); return null; });
        if (r?.directives) onDirectivesSaved?.(r.directives);
        // Persist only the non-runtime fields globally — keep the global engine/model/turns/thinking intact.
        const global: AgentConfig = {
          ...config,
          engine: globalRef.current.engine, model: globalRef.current.model,
          maxTurns: globalRef.current.maxTurns, thinking: globalRef.current.thinking,
        };
        await fetch('/api/config', { method: 'PUT', headers: auth, body: JSON.stringify(global) });
        onSaved?.(global);
      } else {
        await fetch('/api/config', { method: 'PUT', headers: auth, body: JSON.stringify(config) });
        onSaved?.(config);
      }
      setOpen(false);
    } finally {
      setSaving(false);
    }
  };

  const currentEngine = config.engine || 'claude-code';
  const engineInfo = engines.find(e => e.name === currentEngine);
  const models = engineInfo?.models ?? FALLBACK_MODELS;

  // A <select> whose value matches no option silently shows the first option while state stays
  // unchanged — so switching to an engine without a "" Default entry (e.g. cursor) would persist
  // model: undefined and the header pill would fall back to the global default. Snap to the first
  // valid model when the current one isn't offered by the selected engine.
  useEffect(() => {
    if (!engineInfo || !models.length) return;
    if (!models.some(m => (m.value || '') === (config.model ?? ''))) {
      setConfig((c) => ({ ...c, model: models[0].value || undefined }));
    }
  }, [engineInfo, models, config.model]);

  // Group models by provider if the engine has multi-provider models
  const hasProviders = models.some(m => m.provider);
  const groupedModels = hasProviders
    ? Array.from(
        models.reduce((groups, m) => {
          const key = m.provider || 'default';
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key)!.push(m);
          return groups;
        }, new Map<string, EngineModel[]>())
      )
    : null;

  const selectClass = 'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger || (
          <Button variant="ghost" size="icon" title="Agent Config">
            <SlidersHorizontal className="w-4 h-4" />
          </Button>
        )}
      </DialogTrigger>

      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Agent Configuration</DialogTitle>
        </DialogHeader>

        <DialogBody className="space-y-4">
          {sessionId && (
            <p className="text-xs text-muted-foreground rounded-md bg-muted/50 px-3 py-2">
              Engine, Model, Max Turns & Thinking apply to <strong>this conversation</strong>. Other settings are global defaults for new sessions.
            </p>
          )}
          {multiEngine && (
            <div>
              <label className="text-sm font-medium mb-1.5 block">Engine</label>
              <select
                value={config.engine ?? ''}
                onChange={(e) => {
                  const engine = e.target.value || undefined;
                  setConfig((c) => ({ ...c, engine, model: undefined }));
                }}
                className={selectClass}
              >
                {engines.map((e) => (
                  <option key={e.name} value={e.name}>
                    {e.name === 'claude-code' ? 'Claude Code (default)' : e.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="text-sm font-medium mb-1.5 block">Model</label>
            <select
              value={config.model ?? ''}
              onChange={(e) => setConfig((c) => ({ ...c, model: e.target.value || undefined }))}
              className={selectClass}
            >
              {groupedModels ? (
                groupedModels.map(([provider, providerModels]) => (
                  <optgroup key={provider} label={provider.charAt(0).toUpperCase() + provider.slice(1)}>
                    {providerModels.map((m) => (
                      <option key={m.value} value={m.value}>{m.label}</option>
                    ))}
                  </optgroup>
                ))
              ) : (
                models.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))
              )}
            </select>
          </div>

          {slots.settingsSections?.({ getToken, sessionId })}

          <div>
            <label className="text-sm font-medium mb-1.5 block">Permission Mode</label>
            <select
              value={config.permissionMode ?? 'acceptEdits'}
              onChange={(e) => setConfig((c) => ({ ...c, permissionMode: e.target.value }))}
              className={selectClass}
            >
              {PERMISSION_MODES.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-sm font-medium mb-1.5 block">Max Turns</label>
            <Input
              type="number"
              min={1}
              max={200}
              value={config.maxTurns ?? 50}
              onChange={(e) => setConfig((c) => ({ ...c, maxTurns: Number(e.target.value) || 50 }))}
            />
          </div>

          <div>
            <label className="text-sm font-medium mb-1.5 block">Thinking</label>
            <select
              value={config.thinking ?? ''}
              onChange={(e) => setConfig((c) => ({ ...c, thinking: (e.target.value || undefined) as AgentConfig['thinking'] }))}
              className={selectClass}
            >
              <option value="">Default (off)</option>
              <option value="adaptive">Adaptive (Claude decides)</option>
              <option value="enabled">Enabled (always think)</option>
              <option value="disabled">Disabled</option>
            </select>
          </div>

          <div>
            <label className="text-sm font-medium mb-1.5 block">Effort</label>
            <select
              value={config.effort ?? ''}
              onChange={(e) => setConfig((c) => ({ ...c, effort: (e.target.value || undefined) as AgentConfig['effort'] }))}
              className={selectClass}
            >
              <option value="">Default</option>
              <option value="low">Low — fast</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="max">Max</option>
            </select>
          </div>

          <div>
            <label className="text-sm font-medium mb-1.5 block">Allowed Tools</label>
            <Input
              placeholder="Read, Edit, Bash, WebSearch, Glob, LS"
              value={(config.allowedTools ?? []).join(', ')}
              onChange={(e) => setConfig((c) => ({
                ...c,
                allowedTools: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
              }))}
            />
            <p className="text-xs text-muted-foreground mt-1">Comma-separated list of tools Claude can use</p>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm font-medium">Skill Discovery</label>
              <p className="text-xs text-muted-foreground">Index all skills + auto-inject on trigger match</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={config.skillDiscovery !== false}
              onClick={() => setConfig((c) => ({ ...c, skillDiscovery: c.skillDiscovery === false ? true : false }))}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${config.skillDiscovery !== false ? 'bg-primary' : 'bg-muted'}`}
            >
              <span className={`pointer-events-none block h-5 w-5 rounded-full bg-background shadow-lg ring-0 transition-transform ${config.skillDiscovery !== false ? 'translate-x-5' : 'translate-x-0'}`} />
            </button>
          </div>

          <div>
            <label className="text-sm font-medium mb-1.5 block">System Prompt (optional)</label>
            <Textarea
              placeholder="Additional instructions appended to Claude's system prompt…"
              value={config.systemPrompt ?? ''}
              onChange={(e) => setConfig((c) => ({ ...c, systemPrompt: e.target.value || undefined }))}
              rows={4}
            />
          </div>
        </DialogBody>

        <DialogFooter>
          <Button onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save Configuration'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
