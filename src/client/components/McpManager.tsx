import { useEffect, useState } from 'react';
import { Plus, Trash2, Settings, Lock } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogBody, DialogFooter } from './ui/dialog';

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  readonly?: boolean;
}
export type McpConfig = Record<string, McpServerConfig>;

interface Props {
  getToken: () => Promise<string | null>;
  trigger?: React.ReactNode;
}

const emptyServer = (): McpServerConfig => ({ command: '', args: [], env: {} });

export function McpManager({ getToken, trigger }: Props) {
  const [config, setConfig] = useState<McpConfig>({});
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingEnv, setEditingEnv] = useState<Set<string>>(new Set());
  const toggleEditing = (id: string) =>
    setEditingEnv((s) => { const next = new Set(s); next.has(id) ? next.delete(id) : next.add(id); return next; });

  useEffect(() => {
    if (!open) return;
    getToken().then((token) => {
      if (!token) return;
      fetch('/api/mcps', { headers: { Authorization: `Bearer ${token}` } })
        .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
        .then(setConfig)
        .catch((e) => console.error('[McpManager] fetch failed', e));
    });
  }, [open, getToken]);

  const save = async () => {
    setSaving(true);
    const token = await getToken();
    try {
      await fetch('/api/mcps', {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token ?? ''}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      setOpen(false);
    } finally {
      setSaving(false);
    }
  };

  const addServer = () => {
    const name = `server-${Date.now()}`;
    setConfig((c) => ({ ...c, [name]: emptyServer() }));
  };

  const removeServer = (name: string) => {
    setConfig((c) => {
      const next = { ...c };
      delete next[name];
      return next;
    });
  };

  const updateServer = (name: string, key: keyof McpServerConfig, value: string) => {
    setConfig((c) => ({ ...c, [name]: { ...c[name], [key]: key === 'args' ? value.split(' ') : value } }));
  };

  const updateEnvKey = (name: string, oldKey: string, newKey: string) => {
    setConfig((c) => {
      const env = { ...c[name].env };
      const val = env[oldKey] ?? '';
      delete env[oldKey];
      if (newKey.trim()) env[newKey.trim()] = val;
      return { ...c, [name]: { ...c[name], env } };
    });
  };

  const updateEnvVal = (name: string, key: string, val: string) => {
    setConfig((c) => ({
      ...c,
      [name]: { ...c[name], env: { ...c[name].env, [key]: val } },
    }));
  };

  const removeEnvKey = (name: string, key: string) => {
    setConfig((c) => {
      const env = { ...c[name].env };
      delete env[key];
      return { ...c, [name]: { ...c[name], env } };
    });
  };

  const addEnvKey = (name: string) => {
    const key = `KEY_${Date.now()}`;
    setConfig((c) => ({
      ...c,
      [name]: { ...c[name], env: { ...c[name].env, [key]: '' } },
    }));
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger || (
          <Button variant="ghost" size="icon" title="MCP Servers">
            <Settings className="w-4 h-4" />
          </Button>
        )}
      </DialogTrigger>

      <DialogContent className="max-w-[95vw] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>MCP Servers</DialogTitle>
        </DialogHeader>

        <DialogBody className="space-y-4">
          {Object.entries(config).map(([name, server]) => {
            const isReadonly = !!server.readonly;
            return (
            <div key={name} className={`border rounded-lg p-4 space-y-3 ${isReadonly ? 'opacity-70' : ''}`}>
              <div className="flex items-center justify-between">
                <span className="font-medium text-sm flex items-center gap-1.5">
                  {isReadonly && <Lock className="w-3 h-3 text-muted-foreground" />}
                  {name}
                </span>
                {!isReadonly && (
                  <Button variant="ghost" size="icon" onClick={() => removeServer(name)}>
                    <Trash2 className="w-4 h-4 text-destructive" />
                  </Button>
                )}
              </div>
              {isReadonly ? (
                <p className="text-xs text-muted-foreground">Configured in shraga.config.ts</p>
              ) : (
              <div className="grid gap-2">
                <Input
                  placeholder="Command (e.g. npx)"
                  value={server.command}
                  onChange={(e) => updateServer(name, 'command', e.target.value)}
                />
                <Input
                  placeholder="Args (space-separated)"
                  value={(server.args || []).join(' ')}
                  onChange={(e) => updateServer(name, 'args', e.target.value)}
                />
                {Object.entries(server.env || {}).length > 0 && (
                  <div className="space-y-2">
                    <span className="text-xs text-muted-foreground">Environment variables</span>
                    {Object.entries(server.env || {}).map(([k, v]) => (
                      <div key={k} className="flex gap-2 items-center">
                        <Input
                          className="w-1/3 font-mono text-xs"
                          value={k}
                          onChange={(e) => updateEnvKey(name, k, e.target.value)}
                          placeholder="KEY"
                        />
                        {editingEnv.has(`${name}:${k}`) ? (
                          <Input
                            className="flex-1 font-mono text-xs"
                            placeholder="paste new value"
                            autoFocus
                            onChange={(e) => updateEnvVal(name, k, e.target.value)}
                            onBlur={() => toggleEditing(`${name}:${k}`)}
                          />
                        ) : (
                          <span
                            className="flex-1 font-mono text-xs text-muted-foreground truncate cursor-pointer px-3 py-2 border rounded-md bg-background hover:border-ring"
                            onClick={() => toggleEditing(`${name}:${k}`)}
                            title="Click to change"
                          >{v || '(empty — click to set)'}</span>
                        )}
                        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => removeEnvKey(name, k)}>
                          <Trash2 className="w-3 h-3 text-muted-foreground" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
                <Button variant="ghost" size="sm" className="text-xs text-muted-foreground" onClick={() => addEnvKey(name)}>
                  + Add env var
                </Button>
              </div>
              )}
            </div>
            );
          })}

          {Object.keys(config).length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-4">No MCP servers configured</p>
          )}
        </DialogBody>

        <DialogFooter className="flex gap-2">
          <Button variant="outline" onClick={addServer} className="gap-2">
            <Plus className="w-4 h-4" /> Add Server
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
