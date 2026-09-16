import { useEffect, useState } from 'react';

/**
 * Whether the signed-in caller is an owner — `isOwner` on `GET /api/config` (derived server-side, never persisted).
 * `undefined` until known. A UI hint only: the server enforces owner-only mutations regardless.
 */
export function useIsOwner(getToken: () => Promise<string | null>, enabled = true): boolean | undefined {
  const [isOwner, setIsOwner] = useState<boolean>();

  useEffect(() => {
    if (!enabled) { setIsOwner(undefined); return; }
    let alive = true;
    getToken().then((token) => {
      if (!token || !alive) return;
      fetch('/api/config', { headers: { Authorization: `Bearer ${token}` } })
        .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
        .then((c: { isOwner?: boolean }) => { if (alive) setIsOwner(!!c.isOwner); })
        .catch((e) => console.warn('[isOwner] load failed', e));
    });
    return () => { alive = false; };
  }, [enabled, getToken]);

  return isOwner;
}
