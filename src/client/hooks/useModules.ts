import { useCallback, useEffect, useState } from 'react';

export interface ModuleConfigField {
  type: 'string' | 'number' | 'boolean';
  default: unknown;
  description?: string;
}
export type ModuleConfigSchema = Record<string, ModuleConfigField>;

export interface InstalledModule {
  name: string;
  version: string;
  description?: string;
  enabled: boolean;
  config: Record<string, unknown>;
  installedAt: string;
  source: string;
  configSchema?: ModuleConfigSchema;
  skillCount?: number;
  scheduleCount?: number;
}

export interface AvailableModule {
  name: string;
  version: string;
  description?: string;
  installed: boolean;
  configSchema?: ModuleConfigSchema;
}

async function api<T>(path: string, getToken: () => Promise<string | null>, init?: RequestInit): Promise<T> {
  const token = await getToken();
  const res = await fetch(path, {
    ...init,
    headers: { Authorization: `Bearer ${token ?? ''}`, 'Content-Type': 'application/json', ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `${res.status} ${res.statusText}`);
  }
  return res.json();
}

export function useModules(getToken: () => Promise<string | null>, enabled: boolean, refreshKey = 0) {
  const [installed, setInstalled] = useState<InstalledModule[]>([]);
  const [available, setAvailable] = useState<AvailableModule[]>([]);
  const [unsupported, setUnsupported] = useState(false); // server predates /api/modules (404)
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ installed: InstalledModule[]; available: AvailableModule[] }>('/api/modules', getToken);
      setInstalled(data.installed ?? []);
      setAvailable(data.available ?? []);
      setUnsupported(false);
    } catch (e: any) {
      if (/^404\b/.test(e.message)) setUnsupported(true);
      else setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [getToken]);

  useEffect(() => { if (enabled) refresh(); }, [enabled, refresh, refreshKey]);

  const install = useCallback(async (ref: { name?: string; path?: string }) => {
    await api('/api/modules/install', getToken, { method: 'POST', body: JSON.stringify(ref) });
    await refresh();
  }, [getToken, refresh]);

  const toggle = useCallback(async (name: string, en: boolean) => {
    await api(`/api/modules/${name}/${en ? 'enable' : 'disable'}`, getToken, { method: 'POST' });
    await refresh();
  }, [getToken, refresh]);

  const updateConfig = useCallback(async (name: string, config: Record<string, unknown>) => {
    await api(`/api/modules/${name}/config`, getToken, { method: 'PUT', body: JSON.stringify({ config }) });
    await refresh();
  }, [getToken, refresh]);

  const uninstall = useCallback(async (name: string) => {
    await api(`/api/modules/${name}`, getToken, { method: 'DELETE' });
    await refresh();
  }, [getToken, refresh]);

  return { installed, available, unsupported, loading, error, refresh, install, toggle, updateConfig, uninstall };
}
