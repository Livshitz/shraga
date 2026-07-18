import { useCallback, useEffect, useRef, useState } from 'react';
import { initNative, push, isVisible, onVisibilityChange } from '@/lib/native';
import type { PushMessage } from '@/lib/native';
import type { AgentSocket } from '@/lib/ws';
import { sameOrigin } from '@/lib/utils';

/** Where a notification tap should take the user. Pure + exported so it's unit-verifiable. */
export type TapNav =
  | { action: 'switch'; url: string; session?: string } // different instance → full navigation
  | { action: 'session'; session: string } // same instance → open the session tab
  | { action: 'none' };

/**
 * Decide tap routing from the push payload (`m.data = {instance, session, kind}`) relative to
 * where we're running. A foreign `instance` wins (navigate there, carrying the session); same
 * instance just opens the session; nothing actionable → 'none'.
 */
export function computeTapNav(currentOrigin: string, data: Record<string, unknown>): TapNav {
  const instance = typeof data.instance === 'string' ? data.instance : undefined;
  const session = typeof data.session === 'string' ? data.session : undefined;
  if (instance && !sameOrigin(instance, currentOrigin)) {
    return { action: 'switch', url: instance, session };
  }
  if (session) return { action: 'session', session };
  return { action: 'none' };
}

interface UsePushOpts {
  socket: AgentSocket | null;
  getToken: () => Promise<string | null>;
  pushEnabled: boolean;
  activeSessionId: string | undefined;
  /** Navigate to another instance (full reload), optionally deep-linking a session. */
  switchTo: (url: string, session?: string) => void;
  /** Open a session tab on THIS instance. */
  openSession: (sessionId: string) => void;
  /** Surface a foreground push as an in-app toast (avoids the OS double-notifying). */
  onForegroundMessage?: (m: PushMessage) => void;
}

/**
 * Native push lifecycle + client presence. No-ops every push path in a plain browser
 * (`initNative()` resolves false). Presence is emitted regardless of native — the server uses it
 * to suppress a push for the screen the user is actively viewing.
 */
export function usePush(opts: UsePushOpts) {
  const { socket, getToken, pushEnabled, activeSessionId, switchTo, openSession, onForegroundMessage } = opts;
  const [isNative, setIsNative] = useState(false);

  // Keep handler deps in refs so the register/subscribe effect runs once (no resubscribe churn).
  const switchToRef = useRef(switchTo);
  switchToRef.current = switchTo;
  const openSessionRef = useRef(openSession);
  openSessionRef.current = openSession;
  const onMsgRef = useRef(onForegroundMessage);
  onMsgRef.current = onForegroundMessage;
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;

  useEffect(() => {
    initNative().then(setIsNative);
  }, []);

  // POST the device token to THIS instance's backend. Re-callable on boot + future re-registration.
  const registerToken = useCallback(async () => {
    try {
      const { platform, token, topic } = await push.register();
      const auth = await getTokenRef.current();
      const res = await fetch('/api/push/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
        body: JSON.stringify({ token, platform, topic }),
      });
      if (!res.ok) {
        console.warn('[push] register POST failed', res.status);
        return;
      }
      console.log('[push] registered token with', window.location.origin);
    } catch (err) {
      console.warn('[push] token registration failed', err);
    }
  }, []);

  // Push registration + tap/message subscriptions. Gated on native + feature flag → pure web no-ops.
  useEffect(() => {
    if (!isNative || !pushEnabled || push.capability !== 'native') return;
    let cancelled = false;

    (async () => {
      const perm = await push.requestPermission().catch((e) => {
        console.warn('[push] requestPermission failed', e);
        return 'denied' as const;
      });
      if (cancelled || perm !== 'granted') return;
      await registerToken();
    })();

    const offTap = push.onTap((m) => {
      const nav = computeTapNav(window.location.origin, m.data ?? {});
      console.log('[push] tap →', nav.action);
      if (nav.action === 'switch') switchToRef.current(nav.url, nav.session);
      else if (nav.action === 'session') openSessionRef.current(nav.session);
    });

    const offMsg = push.onMessage((m) => {
      console.log('[push] foreground message');
      onMsgRef.current?.(m);
    });

    return () => {
      cancelled = true;
      offTap();
      offMsg();
    };
  }, [isNative, pushEnabled, registerToken]);

  // Client presence (Page Visibility + active session) → lets the server skip notifying a screen
  // the user is actively looking at. Runs in every environment; harmless when push is off.
  useEffect(() => {
    if (!socket) return;
    const report = () => socket.sendClientPresence(activeSessionId, isVisible());
    report();
    return onVisibilityChange(report);
  }, [socket, activeSessionId]);

  return { isNative };
}
