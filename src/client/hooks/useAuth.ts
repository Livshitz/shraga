import { useCallback, useEffect, useRef, useState } from 'react';
import { onAuth, signOutUser, hasFirebase } from '@/lib/firebase';

export interface AuthUser {
  uid: string;
  email: string | null;
}

export interface AuthState {
  user: AuthUser | null;
  token: string | null;
  getToken: () => Promise<string | null>;
  loading: boolean;
  /** Active auth provider (from GET /api/auth/mode). */
  mode: 'local' | 'firebase' | null;
  /** Local mode, zero users yet → show the create-first-user form. */
  needsSetup: boolean;
  /** Local login/register. Resolves to an error message, or null on success. */
  loginLocal: (email: string, password: string) => Promise<string | null>;
  registerLocal: (email: string, password: string) => Promise<string | null>;
  logout: () => Promise<void>;
}

const LS_TOKEN = 'shraga_token';

function decodeLocalEmail(token: string): string | null {
  try {
    const payload = atob(token.slice(4).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'));
    return payload.slice(0, payload.lastIndexOf(':')) || null;
  } catch {
    return null;
  }
}

export function useAuth(): AuthState {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<'local' | 'firebase' | null>(null);
  const [needsSetup, setNeedsSetup] = useState(false);
  const tokenRef = useRef<string | null>(null);
  const fbUserRef = useRef<any>(null);

  useEffect(() => {
    let unsub: (() => void) | undefined;
    (async () => {
      let m: 'local' | 'firebase' = hasFirebase ? 'firebase' : 'local';
      try {
        const r = await fetch('/api/auth/mode');
        if (r.ok) {
          const d = await r.json();
          m = d.provider === 'firebase' ? 'firebase' : 'local';
          setNeedsSetup(!!d.needsSetup);
        }
      } catch {
        /* fall back to firebase-presence heuristic */
      }
      setMode(m);

      if (m === 'firebase') {
        unsub = onAuth(async (u) => {
          fbUserRef.current = u;
          const t = u ? await u.getIdToken() : null;
          tokenRef.current = t;
          setToken(t);
          setUser(u ? { uid: u.uid, email: u.email } : null);
          setLoading(false);
        });
      } else {
        const t = localStorage.getItem(LS_TOKEN);
        if (t) {
          tokenRef.current = t;
          setToken(t);
          const email = decodeLocalEmail(t);
          setUser({ uid: email ?? 'user', email });
        }
        setLoading(false);
      }
    })();
    return () => unsub?.();
  }, []);

  const getToken = useCallback(async () => {
    if (mode === 'firebase') return fbUserRef.current ? fbUserRef.current.getIdToken() : null;
    return tokenRef.current;
  }, [mode]);

  const applyLocalToken = (t: string, email: string) => {
    localStorage.setItem(LS_TOKEN, t);
    tokenRef.current = t;
    setToken(t);
    setUser({ uid: email, email });
    setNeedsSetup(false);
  };

  const localAuth = useCallback(async (path: 'login' | 'register', email: string, password: string): Promise<string | null> => {
    try {
      const r = await fetch(`/api/auth/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.token) return d.error || 'Authentication failed';
      applyLocalToken(d.token, email);
      return null;
    } catch (e: any) {
      return e?.message || 'Network error';
    }
  }, []);

  const loginLocal = useCallback((e: string, p: string) => localAuth('login', e, p), [localAuth]);
  const registerLocal = useCallback((e: string, p: string) => localAuth('register', e, p), [localAuth]);

  const logout = useCallback(async () => {
    if (mode === 'firebase') {
      await signOutUser();
    } else {
      localStorage.removeItem(LS_TOKEN);
      tokenRef.current = null;
      setToken(null);
      setUser(null);
    }
  }, [mode]);

  return { user, token, getToken, loading, mode, needsSetup, loginLocal, registerLocal, logout };
}
