import { useCallback, useEffect, useState } from 'react';
import type { Schedule } from '@/lib/schedule-types';

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

export function useSchedules(getToken: () => Promise<string | null>, enabled: boolean, refreshKey = 0) {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [serverRunningIds, setServerRunningIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ schedules: Schedule[]; runningIds: string[] }>('/api/schedules', getToken);
      setSchedules(data.schedules);
      setServerRunningIds(new Set(data.runningIds));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [getToken]);

  useEffect(() => { if (enabled) refresh(); }, [enabled, refresh, refreshKey]);

  const create = useCallback(async (s: Partial<Schedule>) => {
    const created = await api<Schedule>('/api/schedules', getToken, { method: 'POST', body: JSON.stringify(s) });
    await refresh();
    return created;
  }, [getToken, refresh]);

  const update = useCallback(async (id: string, s: Partial<Schedule>) => {
    const updated = await api<Schedule>(`/api/schedules/${id}`, getToken, { method: 'PUT', body: JSON.stringify(s) });
    await refresh();
    return updated;
  }, [getToken, refresh]);

  const remove = useCallback(async (id: string) => {
    await api(`/api/schedules/${id}`, getToken, { method: 'DELETE' });
    await refresh();
  }, [getToken, refresh]);

  const toggle = useCallback(async (id: string, en: boolean) => {
    await api(`/api/schedules/${id}/toggle`, getToken, { method: 'POST', body: JSON.stringify({ enabled: en }) });
    await refresh();
  }, [getToken, refresh]);

  const runNow = useCallback(async (id: string, override?: string) => {
    const result = await api<{ sessionId: string }>(`/api/schedules/${id}/run`, getToken, { method: 'POST', body: JSON.stringify(override ? { override } : {}) });
    await refresh();
    return result.sessionId;
  }, [getToken, refresh]);

  const cancelRun = useCallback(async (id: string) => {
    await api(`/api/schedules/${id}/cancel`, getToken, { method: 'POST' });
    await refresh();
  }, [getToken, refresh]);

  return { schedules, serverRunningIds, loading, error, refresh, create, update, remove, toggle, runNow, cancelRun };
}
