import { useCallback } from 'react';
import { api } from '@/lib/api';
import { useIsOwner } from './useIsOwner';

/** `/api/owner/*` caller: throws the server's `error` (validation text included), logged before it reaches the UI. */
export type OwnerCall = <T = any>(path: string, method?: string, body?: unknown) => Promise<T>;

/** Owner Console access: `isOwner` (UI hint — the server enforces) + an authenticated caller for `/api/owner/*`. */
export function useOwner(getToken: () => Promise<string | null>, enabled = true) {
  const isOwner = useIsOwner(getToken, enabled);
  const call = useCallback<OwnerCall>(async (path, method = 'GET', body) => {
    try {
      return await api(`/api/owner${path}`, getToken, { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    } catch (e: any) {
      console.warn(`[owner] ${method} ${path} failed: ${e?.message ?? e}`);
      throw e;
    }
  }, [getToken]);
  return { isOwner, call };
}
