import { useEffect, useRef, useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogBody, DialogFooter } from './ui/dialog';
import { useSlots } from '@/lib/slots';
import { useEngines, type EngineModel } from '@/hooks/useEngines';
import { DEFAULT_MODEL } from '../../shared/models';
import { ClaudeAccountSection } from './ClaudeAccountSection';

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
  allowUntrustedReplies?: boolean;
}

const FALLBACK_MODELS: EngineModel[] = [
  { value: '', label: `Default (${DEFAULT_MODEL})` },
  { value: 'claude-fable-5-1', label: 'Fable 5.1 — frontier, most capable' },
  { value: 'claude-fable-5', label: 'Fable 5' },
  { value: 'claude-opus-5', label: 'Opus 5 — most capable, best for complex/agentic tasks' },
  { value: 'claude-opus-4-8', label: 'Opus 4.8' },
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

/** True if any field of `next` differs from `prev` (value-wise; key order irrelevant). */
const changedFrom = (prev: AgentConfig, next: AgentConfig) =>
  [...new Set([...Object.keys(prev), ...Object.keys(next)])]
    .some((k) => JSON.stringify((prev as any)[k]) !== JSON.stringify((next as any)[k]));

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
  const { engines, multiEngine } = useEngines(getToken, open);
  // Global config as loaded — so a per-session runtime change doesn't clobber the global defaults.
  const globalRef = useRef<AgentConfig>({});
  // Save scope for the runtime knobs (engine/model/turns/thinking): this conversation, or the
  // global default every channel without its own pin uses — Slack, email, scheduler included.
  const [applyGlobally, setApplyGlobally] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Global config is owner-only (PUT /api/config 403s otherwise); a session's own runtime knobs are not.
  const [isOwner, setIsOwner] = useState<boolean>();
  const canGlobal = isOwner === true;
  const canRuntime = canGlobal || !!sessionId;

  useEffect(() => {
    if (!open) return;
    setApplyGlobally(false); // scope is a per-open decision, never a sticky one
    setError(null);
    getToken().then((token) => {
      if (!token) return;
      fetch('/api/config', { headers: { Authorization: `Bearer ${token}` } })
        .then((r) => r.json())
        .then(({ isOwner: owner, ...global }: AgentConfig & { isOwner?: boolean }) => {
          setIsOwner(!!owner);
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
    });
  }, [open, getToken, sessionId, sessionDirectives]);

  /** Throws the server's error message on a non-2xx, so save() surfaces it instead of closing. */
  const send = async (url: string, body: unknown, auth: Record<string, string>) => {
    const res = await fetch(url, { method: 'PUT', headers: auth, body: JSON.stringify(body) });
    const data = await res.json().catch((e) => { console.warn('[config] response not JSON', url, res.status, e); return {}; });
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    const token = await getToken();
    const auth = { Authorization: `Bearer ${token ?? ''}`, 'Content-Type': 'application/json' };
    try {
      if (sessionId) {
        // Global scope: write the runtime knobs into agent-config AND clear this session's own
        // pins, so the conversation follows the new default instead of its stale override.
        // Session scope: pin them on the session only, leaving the global values untouched.
        const runtime: SessionDirectives = applyGlobally
          ? { engine: '', model: '', turns: null, thinking: '' } as any // '' / null = clear the pin
          : { engine: config.engine, model: config.model, turns: config.maxTurns, thinking: config.thinking };
        const r = await send(`/api/sessions/${sessionId}/directives`, runtime, auth);
        if (r?.directives) onDirectivesSaved?.(r.directives);
        const global: AgentConfig = applyGlobally ? config : {
          ...config,
          engine: globalRef.current.engine, model: globalRef.current.model,
          maxTurns: globalRef.current.maxTurns, thinking: globalRef.current.thinking,
        };
        // A session-only save with no global field changed has nothing to persist globally.
        if (changedFrom(globalRef.current, global)) {
          await send('/api/config', global, auth);
          onSaved?.(global);
        }
      } else {
        await send('/api/config', config, auth);
        onSaved?.(config);
      }
      setOpen(false);
    } catch (e: any) {
      console.warn('[config] save failed', e);
      setError(e.message || 'Save failed');
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
            <div className="text-xs text-muted-foreground rounded-md bg-muted/50 px-3 py-2 space-y-2">
              <p>
                Engine, Model, Max Turns & Thinking apply to{' '}
                <strong>{applyGlobally ? 'every conversation' : 'this conversation'}</strong>. Other settings are always global defaults.
              </p>
              {canGlobal && (
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={applyGlobally} onChange={(e) => setApplyGlobally(e.target.checked)} />
                  <span>Apply globally — also the default for Slack, email &amp; scheduled runs</span>
                </label>
              )}
            </div>
          )}
          {multiEngine && (
            <div>
              <label className="text-sm font-medium mb-1.5 block">Engine</label>
              <select
                disabled={!canRuntime}
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
              disabled={!canRuntime}
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

          <ClaudeAccountSection getToken={getToken} />

          <div>
            <label className="text-sm font-medium mb-1.5 block">Permission Mode</label>
            <select
              disabled={!canGlobal}
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
              disabled={!canRuntime}
              value={config.maxTurns ?? 50}
              onChange={(e) => setConfig((c) => ({ ...c, maxTurns: Number(e.target.value) || 50 }))}
            />
          </div>

          <div>
            <label className="text-sm font-medium mb-1.5 block">Thinking</label>
            <select
              disabled={!canRuntime}
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
              disabled={!canGlobal}
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
              disabled={!canGlobal}
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
              disabled={!canGlobal}
              aria-checked={config.skillDiscovery !== false}
              onClick={() => setConfig((c) => ({ ...c, skillDiscovery: c.skillDiscovery === false ? true : false }))}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${config.skillDiscovery !== false ? 'bg-primary' : 'bg-muted'}`}
            >
              <span className={`pointer-events-none block h-5 w-5 rounded-full bg-background shadow-lg ring-0 transition-transform ${config.skillDiscovery !== false ? 'translate-x-5' : 'translate-x-0'}`} />
            </button>
          </div>

          <div className="flex items-center justify-between">
            <div className="pr-4">
              <label className="text-sm font-medium">Reply to untrusted senders</label>
              <p className="text-xs text-muted-foreground">
                Off: inbound messages from unverified or unknown senders are still processed and escalated to
                owners, but the agent sends them no automatic reply.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              disabled={!canGlobal}
              aria-checked={config.allowUntrustedReplies === true}
              aria-label="Reply to untrusted senders"
              onClick={() => setConfig((c) => ({ ...c, allowUntrustedReplies: c.allowUntrustedReplies === true ? false : true }))}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${config.allowUntrustedReplies === true ? 'bg-primary' : 'bg-muted'}`}
            >
              <span className={`pointer-events-none block h-5 w-5 rounded-full bg-background shadow-lg ring-0 transition-transform ${config.allowUntrustedReplies === true ? 'translate-x-5' : 'translate-x-0'}`} />
            </button>
          </div>

          <div>
            <label className="text-sm font-medium mb-1.5 block">System Prompt (optional)</label>
            <Textarea
              placeholder="Additional instructions appended to Claude's system prompt…"
              disabled={!canGlobal}
              value={config.systemPrompt ?? ''}
              onChange={(e) => setConfig((c) => ({ ...c, systemPrompt: e.target.value || undefined }))}
              rows={4}
            />
          </div>
        </DialogBody>

        <DialogFooter className="flex-col items-stretch gap-2">
          {error && <p className="text-sm text-destructive">{error}</p>}
          {isOwner === false && (
            <p className="text-xs text-muted-foreground">
              {sessionId ? 'Only an owner can change the global defaults — runtime knobs apply to this conversation.' : 'Read-only — only an owner can change the agent config.'}
            </p>
          )}
          {canRuntime && (
            <Button onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save Configuration'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
