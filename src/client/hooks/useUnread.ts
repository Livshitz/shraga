import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentSocket, ServerEvent } from '@/lib/ws';
import { requestDesktopAttention, setDesktopBadge } from '@/lib/desktopAttention';

export interface UnreadSession {
  count: number;
  preview: string;
  source: 'response' | 'proactive' | 'schedule';
  title?: string;
}

export interface ToastItem {
  id: string;
  sessionId: string;
  preview: string;
  title?: string;
  ts: number;
}

const MAX_TOASTS = 4;
const TOAST_TTL = 0; // 0 = sticky (no auto-dismiss), positive ms = auto-expire

export function useUnread(
  socket: AgentSocket | null,
  activeSessionId: string | undefined,
) {
  const [unreads, setUnreads] = useState<Record<string, UnreadSession>>({});
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const activeRef = useRef(activeSessionId);
  activeRef.current = activeSessionId;
  const focusedRef = useRef(!document.hidden);
  const socketRef = useRef(socket);
  socketRef.current = socket;

  // Track tab focus
  useEffect(() => {
    const onVisChange = () => {
      focusedRef.current = !document.hidden;
      socketRef.current?.sendPresence(activeRef.current, focusedRef.current);
      if (focusedRef.current && activeRef.current) {
        markRead(activeRef.current);
      }
    };
    const onFocus = () => {
      focusedRef.current = true;
      socketRef.current?.sendPresence(activeRef.current, true);
      if (activeRef.current) markRead(activeRef.current);
    };
    const onBlur = () => {
      focusedRef.current = false;
      socketRef.current?.sendPresence(activeRef.current, false);
    };
    document.addEventListener('visibilitychange', onVisChange);
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('visibilitychange', onVisChange);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  // Send presence when active session changes
  useEffect(() => {
    socket?.sendPresence(activeSessionId, focusedRef.current);
    if (activeSessionId && focusedRef.current) {
      markRead(activeSessionId);
    }
  }, [activeSessionId, socket]);

  useEffect(() => {
    if (!TOAST_TTL || toasts.length === 0) return;
    const timer = setInterval(() => {
      const now = Date.now();
      setToasts(prev => prev.filter(t => now - t.ts < TOAST_TTL));
    }, 5_000);
    return () => clearInterval(timer);
  }, [toasts.length]);

  const handleUnreadEvent = useCallback((event: ServerEvent) => {
    if (event.type === 'unread') {
      const isViewingThis = activeRef.current === event.sessionId && focusedRef.current;
      if (isViewingThis) {
        socketRef.current?.markRead(event.sessionId);
        return;
      }
      setUnreads(prev => ({
        ...prev,
        [event.sessionId]: {
          count: event.count,
          preview: event.preview,
          source: event.source,
          title: event.title,
        },
      }));
      setToasts(prev => {
        const existing = prev.filter(t => t.sessionId !== event.sessionId);
        const toast: ToastItem = {
          id: `${event.sessionId}-${Date.now()}`,
          sessionId: event.sessionId,
          preview: event.preview,
          title: event.title,
          ts: Date.now(),
        };
        return [toast, ...existing].slice(0, MAX_TOASTS);
      });
    }

    if (event.type === 'unread_sync') {
      const mapped: Record<string, UnreadSession> = {};
      for (const [sid, entry] of Object.entries(event.sessions)) {
        if (sid === activeRef.current && focusedRef.current) {
          socketRef.current?.markRead(sid);
          continue;
        }
        mapped[sid] = {
          count: entry.count,
          preview: entry.preview,
          source: entry.source as UnreadSession['source'],
          title: entry.title,
        };
      }
      setUnreads(mapped);
    }

    if (event.type === 'unread_cleared') {
      setUnreads(prev => {
        const next = { ...prev };
        delete next[event.sessionId];
        return next;
      });
    }
  }, []);

  const markRead = useCallback((sessionId: string) => {
    setUnreads(prev => {
      if (!prev[sessionId]) return prev;
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
    setToasts(prev => prev.filter(t => t.sessionId !== sessionId));
    socketRef.current?.markRead(sessionId);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  // Surface an ad-hoc in-app toast (e.g. a foreground native push) reusing the existing stack.
  const addToast = useCallback((t: { sessionId: string; preview: string; title?: string }) => {
    if (activeRef.current === t.sessionId && focusedRef.current) return; // already on that screen
    setToasts(prev => {
      const existing = prev.filter(x => x.sessionId !== t.sessionId);
      const toast: ToastItem = { id: `${t.sessionId}-${Date.now()}`, sessionId: t.sessionId, preview: t.preview, title: t.title, ts: Date.now() };
      return [toast, ...existing].slice(0, MAX_TOASTS);
    });
  }, []);

  const totalUnread = Object.keys(unreads).length;

  // Update document title and favicon
  useEffect(() => {
    const base = 'Shraga';
    document.title = totalUnread > 0 ? `(${totalUnread}) ${base}` : base;
    updateFavicon(totalUnread);
  }, [totalUnread]);

  // Desktop shell (appwrap/macOS): mirror the unread count on the Dock badge, and bounce the Dock
  // icon when a NEW unread arrives while the window is unfocused. No-op on web/mobile/no-kit.
  const prevUnreadRef = useRef(0);
  useEffect(() => {
    setDesktopBadge(totalUnread);
    if (totalUnread > prevUnreadRef.current) requestDesktopAttention(false); // completed response → informational
    prevUnreadRef.current = totalUnread;
  }, [totalUnread]);

  return { unreads, toasts, totalUnread, markRead, dismissToast, addToast, handleUnreadEvent };
}

let faviconCanvas: HTMLCanvasElement | null = null;
let originalFavicon: string | null = null;

function updateFavicon(count: number) {
  if (typeof document === 'undefined') return;

  if (!originalFavicon) {
    const existing = document.querySelector('link[rel="icon"]') as HTMLLinkElement | null;
    originalFavicon = existing?.href ?? '';
  }

  if (count === 0) {
    setFaviconHref(originalFavicon || '');
    return;
  }

  if (!faviconCanvas) {
    faviconCanvas = document.createElement('canvas');
    faviconCanvas.width = 32;
    faviconCanvas.height = 32;
  }

  const ctx = faviconCanvas.getContext('2d');
  if (!ctx) return;

  ctx.clearRect(0, 0, 32, 32);

  // Draw base circle icon
  ctx.fillStyle = '#6366f1';
  ctx.beginPath();
  ctx.arc(16, 16, 14, 0, Math.PI * 2);
  ctx.fill();

  // Draw badge
  ctx.fillStyle = '#ef4444';
  ctx.beginPath();
  ctx.arc(24, 8, 8, 0, Math.PI * 2);
  ctx.fill();

  // Draw count
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 10px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(count > 9 ? '9+' : String(count), 24, 8);

  setFaviconHref(faviconCanvas.toDataURL());
}

function setFaviconHref(href: string) {
  let link = document.querySelector('link[rel="icon"]') as HTMLLinkElement | null;
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  if (link.href !== href) link.href = href;
}
