import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from '@/hooks/useAuth';
import { useAgentSocket } from '@/hooks/useAgentSocket';
import { usePush } from '@/hooks/usePush';
import { initDesktopAttention, requestDesktopAttention } from '@/lib/desktopAttention';
import { apiFetch } from '@/lib/sessionApi';
import { WorkspaceProvider, type AgentConfig, type WorkspaceContextValue } from '@/lib/workspaceContext';
import { SlotsProvider, useSlots } from '@/lib/slots';
import { LoginPage } from '@/components/LoginPage';
import { OAuthConsent } from '@/components/OAuthConsent';
import { CliAuthConsent } from '@/components/CliAuthConsent';
import { Sidebar } from '@/components/Sidebar';
import { ConversationPane } from '@/components/ConversationPane';
import { McpManager } from '@/components/McpManager';
import { SkillsManager } from '@/components/SkillsManager';
import { ModulesManager } from '@/components/ModulesManager';
import { SchedulesManager, type SchedulesManagerHandle } from '@/components/SchedulesManager';
import type { ServerEvent } from '@/lib/ws';
import type { WorkspaceEntry } from '@/components/WorkspaceTree';
import { Button } from '@/components/ui/button';
import {
  LogOut,
  PanelLeftClose,
  PanelLeft,
  Sun,
  Moon,
  Clock,
  EllipsisVertical,
  Settings,
  BookOpen,
  Blocks,
  SquarePen,
} from 'lucide-react';
import { useDarkMode } from '@/hooks/useDarkMode';
import { useUnread } from '@/hooks/useUnread';
import { ToastStack } from '@/components/Toast';

function getSessionFromUrl(): string | undefined {
  return new URLSearchParams(window.location.search).get('session') || undefined;
}

function syncSessionToUrl(id: string | undefined) {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set('session', id);
  else url.searchParams.delete('session');
  const changed = url.toString() !== window.location.href;
  if (id && changed) window.history.pushState(null, '', url.toString());
  else window.history.replaceState(null, '', url.toString());
}

export function App() {
  // The core ships an empty slot set → no add-on module is imported, so the built bundle carries no
  // add-on code (multi-pane layout, extra input controls, …). A build swaps this value.
  return (
    <SlotsProvider value={{}}>
      <AppInner />
    </SlotsProvider>
  );
}

function AppInner() {
  const slots = useSlots();
  const { dark, toggle: toggleDark } = useDarkMode();
  const { user, token, getToken, loading, mode, needsSetup, loginLocal, registerLocal, logout } = useAuth();
  const [sidebarOpen, _setSidebarOpen] = useState(() => localStorage.getItem('shraga:sidebarOpen') !== 'false');
  const setSidebarOpen = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    _setSidebarOpen((prev) => {
      const next = typeof v === 'function' ? v(prev) : v;
      localStorage.setItem('shraga:sidebarOpen', String(next));
      return next;
    });
  }, []);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [mobileMenuPos, setMobileMenuPos] = useState<{ top: number; right: number }>({ top: 52, right: 8 });
  const mobileMenuBtnRef = useRef<HTMLButtonElement>(null);
  const openMobileMenu = useCallback(() => {
    const r = mobileMenuBtnRef.current?.getBoundingClientRect();
    if (r) setMobileMenuPos({ top: r.bottom + 4, right: Math.max(4, window.innerWidth - r.right) });
    setMobileMenuOpen((v) => !v);
  }, []);
  const [agentConfig, setAgentConfig] = useState<AgentConfig>({});
  const schedulesRef = useRef<SchedulesManagerHandle>(null);
  const [sidebarRefresh, setSidebarRefresh] = useState(0);
  const [scheduleRefresh, setScheduleRefresh] = useState(0);
  const [runningScheduleIds, setRunningScheduleIds] = useState<Set<string>>(new Set());
  const [skills, setSkills] = useState<string[]>([]);
  const [workspaceEntries, setWorkspaceEntries] = useState<WorkspaceEntry[]>([]);
  const [workspaceRefreshKey, setWorkspaceRefreshKey] = useState(0);
  const [busySessions, setBusySessions] = useState<Set<string>>(new Set());
  const [pushEnabled, setPushEnabled] = useState(false);
  // Optimistic auth: if this device authorized before, render immediately on reload instead of
  // blocking behind "Verifying access…"; the revalidation below still flips to false on a real 403.
  const [authorized, setAuthorized] = useState<boolean | null>(
    () => (localStorage.getItem('shraga:authorized') === '1' ? true : null),
  );

  // Core session selection: a single conversation pane, so "the active session" is plain local state
  // (no tabs / multi-pane layout). A fresh chat is `undefined`; the pane adopts a real id on first turn.
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>(() => getSessionFromUrl());
  const openSession = useCallback((id: string, _title?: string) => setActiveSessionId(id), []);
  const assignSession = useCallback((_nodeId: string, id: string) => setActiveSessionId(id), []);
  const renameTab = useCallback((_nodeId: string, _title: string) => {}, []); // no tabs in this build

  const bumpSidebar = useCallback(() => setSidebarRefresh((n) => n + 1), []);

  // Verify server-side authorization before showing main UI
  const wasAuthorized = useRef(false);
  useEffect(() => {
    if (!token) {
      if (!wasAuthorized.current && localStorage.getItem('shraga:authorized') !== '1') setAuthorized(null);
      return;
    }
    getToken().then(async (t) => {
      if (!t) return setAuthorized(false);
      try {
        const res = await fetch('/api/config', { headers: { Authorization: `Bearer ${t}` } });
        if (res.ok) {
          wasAuthorized.current = true;
          localStorage.setItem('shraga:authorized', '1');
          return setAuthorized(true);
        }
        const body = await res.json().catch(() => ({}));
        if (res.status === 401 && (body.error?.includes('audience') || body.error?.includes('aud'))) {
          console.warn('[auth] Token audience mismatch — signing out stale session');
          logout();
          return;
        }
        if (res.status === 403 && body.error?.toLowerCase().includes('whitelist')) {
          localStorage.removeItem('shraga:authorized');
          return setAuthorized(false);
        }
        if (wasAuthorized.current) return;
        setAuthorized(res.status !== 401 && res.status !== 403);
      } catch {
        if (wasAuthorized.current) return;
        setAuthorized(true);
      }
    });
  }, [token, getToken]);

  const refreshWorkspace = useCallback(() => {
    if (!token) return;
    setWorkspaceRefreshKey((n) => n + 1);
    apiFetch('/api/workspace', getToken)
      .then((r) => r.json())
      .then((data: { entries: WorkspaceEntry[] }) => setWorkspaceEntries(data.entries ?? []))
      .catch((err) => console.warn('[workspace] refresh failed', err));
  }, [token, getToken]);

  const handleScheduleEvent = useCallback((event: Extract<ServerEvent, { type: `schedule:${string}` }>) => {
    setScheduleRefresh((n) => n + 1);
    if (event.type === 'schedule:run_started') {
      setRunningScheduleIds((prev) => new Set(prev).add(event.scheduleId));
      bumpSidebar();
    } else if (event.type === 'schedule:run_finished') {
      setRunningScheduleIds((prev) => {
        const next = new Set(prev);
        next.delete(event.scheduleId);
        return next;
      });
      bumpSidebar();
    } else if (event.type === 'schedule:deleted') {
      setRunningScheduleIds((prev) => {
        const next = new Set(prev);
        next.delete(event.id);
        return next;
      });
    }
  }, [bumpSidebar]);

  const markReadRef = useRef<((sid: string) => void) | null>(null);
  const unreadEventRef = useRef<((event: ServerEvent) => void) | null>(null);
  const activeSessionRef = useRef(activeSessionId);
  activeSessionRef.current = activeSessionId;

  // App-global socket-event sink: sidebar / unread / schedules / busy-set. Per-conversation message
  // state and the model pill are handled by useConversation inside the ConversationPane.
  const handleGlobalEvent = useCallback(
    (event: ServerEvent) => {
      unreadEventRef.current?.(event);
      if (event.type.startsWith('schedule:')) {
        handleScheduleEvent(event as Extract<ServerEvent, { type: `schedule:${string}` }>);
        return;
      }
      if (event.type === 'permission_request') requestDesktopAttention(true);
      switch (event.type) {
        case 'workspace_change':
          refreshWorkspace();
          break;
        case 'session_title_updated':
          bumpSidebar();
          break;
        case 'session_messages_changed':
          bumpSidebar();
          if (event.sessionId === activeSessionRef.current) markReadRef.current?.(event.sessionId);
          break;
        case 'session_busy':
          setBusySessions((prev) => {
            const next = new Set(prev);
            if (event.busy) next.add(event.sessionId);
            else next.delete(event.sessionId);
            return next;
          });
          if (!event.busy) bumpSidebar();
          break;
      }
    },
    [handleScheduleEvent, refreshWorkspace, bumpSidebar],
  );

  const { socket, connectionStatus, authError } = useAgentSocket(token, getToken, handleGlobalEvent);

  const { unreads, toasts, markRead, dismissToast, addToast, handleUnreadEvent } = useUnread(socket, activeSessionId);
  unreadEventRef.current = handleUnreadEvent;
  markReadRef.current = markRead;

  // Native push + client presence. No-op in a plain browser (initNative resolves false). This build
  // has no multi-instance switching, so a foreign-instance tap just opens the session here.
  usePush({
    socket,
    getToken,
    pushEnabled,
    activeSessionId,
    switchTo: () => {},
    openSession,
    onForegroundMessage: (m) => {
      const sid = typeof m.data?.session === 'string' ? m.data.session : undefined;
      if (sid) addToast({ sessionId: sid, preview: m.body || 'New message', title: m.title });
    },
  });

  useEffect(() => {
    initDesktopAttention();
  }, []);

  // Active session → shareable URL (+ mark its conversation read).
  useEffect(() => {
    syncSessionToUrl(activeSessionId);
    if (activeSessionId) markRead(activeSessionId);
  }, [activeSessionId, markRead]);

  // Browser back/forward → select that session.
  useEffect(() => {
    const onPopState = () => setActiveSessionId(getSessionFromUrl());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // Load config / skills / workspace / features
  useEffect(() => {
    if (!token) return;
    apiFetch('/api/config', getToken).then((r) => r.json()).then(setAgentConfig).catch(() => {});
    apiFetch('/api/skills', getToken)
      .then((r) => r.json())
      .then((data: { skills: string[]; builtins: string[] }) => setSkills(data.skills))
      .catch(() => {});
    apiFetch('/api/features', getToken)
      .then((r) => r.json())
      .then((f: { push?: boolean }) => setPushEnabled(!!f.push))
      .catch(() => {});
  }, [token, getToken]);
  useEffect(() => {
    refreshWorkspace();
  }, [refreshWorkspace]);

  const newChat = useCallback(() => {
    setActiveSessionId(undefined);
    if (window.innerWidth < 640) setSidebarOpen(false);
  }, [setSidebarOpen]);

  const workspaceFiles = useMemo(
    () => workspaceEntries.filter((e) => e.type === 'file').map((e) => e.path),
    [workspaceEntries],
  );

  const workspaceCtx = useMemo<WorkspaceContextValue>(
    () => ({
      socket,
      connectionStatus,
      getToken,
      token,
      agentConfig,
      setAgentConfig,
      activeSessionId,
      skills,
      workspaceFiles,
      openSchedules: () => schedulesRef.current?.open(),
      markRead,
      bumpSidebar,
      assignSession,
      renameTab,
      openSession,
    }),
    [socket, connectionStatus, getToken, token, agentConfig, activeSessionId, skills, workspaceFiles, markRead, bumpSidebar, assignSession, renameTab, openSession],
  );

  if (loading) {
    return <div className="flex h-full items-center justify-center text-muted-foreground text-sm">Loading…</div>;
  }

  if (!user || !token) return <LoginPage mode={mode} needsSetup={needsSetup} onLoginLocal={loginLocal} onRegisterLocal={registerLocal} />;

  if (authorized === null) {
    return <div className="flex h-full items-center justify-center text-muted-foreground text-sm">Verifying access…</div>;
  }

  if (!authorized || authError) {
    return (
      <div className="flex h-full items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4 p-8 rounded-xl border bg-card shadow-sm w-full max-w-sm text-center">
          <div className="flex items-center justify-center w-12 h-12 rounded-full bg-destructive/10 text-destructive">
            <LogOut className="w-6 h-6" />
          </div>
          <h2 className="text-lg font-semibold">Access Denied</h2>
          <p className="text-sm text-muted-foreground">Your account is not authorized to use this app.</p>
          <p className="text-xs text-muted-foreground">Signed in as {user.email}</p>
          <Button variant="outline" onClick={() => logout()}>
            Sign out
          </Button>
        </div>
      </div>
    );
  }

  if (window.location.pathname === '/oauth/authorize') {
    return <OAuthConsent getToken={getToken} userEmail={user.email ?? ''} />;
  }

  if (window.location.pathname === '/cli-auth') {
    return <CliAuthConsent getToken={getToken} userEmail={user.email ?? ''} />;
  }

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-50 bg-background sm:relative sm:inset-auto sm:z-auto sm:w-64 sm:shrink-0 sm:border-r flex flex-col">
          <div
            className="flex items-center justify-between px-3 py-2 border-b sm:hidden"
            style={{ paddingTop: 'max(0.5rem, env(safe-area-inset-top))' }}
          >
            <span className="text-sm font-medium">Sessions</span>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setSidebarOpen(false)}>
              <PanelLeftClose className="w-4 h-4" />
            </Button>
          </div>
          <div className="flex-1 min-h-0">
            <Sidebar
              getToken={getToken}
              activeSessionId={activeSessionId}
              onSelect={(id, title) => {
                openSession(id, title);
                markRead(id);
                if (window.innerWidth < 640) setSidebarOpen(false);
              }}
              onNew={newChat}
              refreshKey={sidebarRefresh}
              workspaceRefreshKey={workspaceRefreshKey}
              onRefreshWorkspace={refreshWorkspace}
              userUid={user.uid}
              userEmail={user.email || ''}
              unreads={unreads}
              busySessions={busySessions}
              socket={socket}
            />
          </div>
        </div>
      )}

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0">
        <header
          className="border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60"
          style={{ paddingTop: 'env(safe-area-inset-top)' }}
        >
          <div className="flex items-center gap-1.5 sm:gap-2 px-2 sm:px-3 py-1.5">
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 sm:h-8 sm:w-8 shrink-0"
              onClick={() => setSidebarOpen(!sidebarOpen)}
              title="Toggle sidebar"
            >
              {sidebarOpen ? <PanelLeftClose className="w-4 h-4" /> : <PanelLeft className="w-4 h-4" />}
            </Button>
            <Button variant="ghost" size="icon" className="h-9 w-9 sm:h-8 sm:w-8 shrink-0" onClick={newChat} title="New chat (⌘N)">
              <SquarePen className="w-4 h-4" />
            </Button>

            <div className="flex-1" />

            {/* Desktop: inline global tools */}
            <div className="hidden sm:flex items-center gap-0.5 shrink-0">
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={toggleDark} title={dark ? 'Light mode' : 'Dark mode'}>
                {dark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
              </Button>
              {slots.headerActions?.()}
              <McpManager getToken={getToken} />
              <SkillsManager getToken={getToken} onSkillsChange={setSkills} />
              <ModulesManager getToken={getToken} />
              <SchedulesManager
                ref={schedulesRef}
                getToken={getToken}
                refreshKey={scheduleRefresh}
                runningIds={runningScheduleIds}
                onOpenSession={(sid) => openSession(sid)}
                skills={skills}
                workspaceFiles={workspaceFiles}
              />
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => logout()} title="Sign out">
                <LogOut className="w-4 h-4" />
              </Button>
            </div>
            {/* Mobile: 3-dot menu */}
            <div className="relative sm:hidden shrink-0">
              <Button ref={mobileMenuBtnRef} variant="ghost" size="icon" className="h-9 w-9" onClick={openMobileMenu}>
                <EllipsisVertical className="w-4 h-4" />
              </Button>
              {mobileMenuOpen && createPortal(
                <>
                  <div className="fixed inset-0 z-[1090] cursor-pointer" onClick={() => setMobileMenuOpen(false)} />
                  <div
                    className="fixed z-[1100] border rounded-lg shadow-lg p-1 min-w-[170px] bg-white dark:bg-zinc-900 whitespace-nowrap"
                    style={{ top: mobileMenuPos.top, right: mobileMenuPos.right }}
                  >
                    {slots.headerActions?.()}
                    <McpManager
                      getToken={getToken}
                      trigger={
                        <button className="flex w-full items-center gap-2.5 rounded-md px-3 py-2.5 text-sm hover:bg-accent">
                          <Settings className="w-3.5 h-3.5" /> MCPs
                        </button>
                      }
                    />
                    <SkillsManager
                      getToken={getToken}
                      onSkillsChange={setSkills}
                      trigger={
                        <button className="flex w-full items-center gap-2.5 rounded-md px-3 py-2.5 text-sm hover:bg-accent">
                          <BookOpen className="w-3.5 h-3.5" /> Skills
                        </button>
                      }
                    />
                    <ModulesManager
                      getToken={getToken}
                      trigger={
                        <button className="flex w-full items-center gap-2.5 rounded-md px-3 py-2.5 text-sm hover:bg-accent">
                          <Blocks className="w-3.5 h-3.5" /> Modules
                        </button>
                      }
                    />
                    <SchedulesManager
                      getToken={getToken}
                      refreshKey={scheduleRefresh}
                      runningIds={runningScheduleIds}
                      onOpenSession={(sid) => openSession(sid)}
                      skills={skills}
                      workspaceFiles={workspaceFiles}
                      trigger={
                        <button className="flex w-full items-center gap-2.5 rounded-md px-3 py-2.5 text-sm hover:bg-accent">
                          <Clock className="w-3.5 h-3.5" /> Schedules
                        </button>
                      }
                    />
                    <div className="border-t my-1" />
                    <button
                      className="flex w-full items-center gap-2.5 rounded-md px-3 py-2.5 text-sm hover:bg-accent"
                      onClick={() => {
                        setMobileMenuOpen(false);
                        toggleDark();
                      }}
                    >
                      {dark ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
                      {dark ? 'Light mode' : 'Dark mode'}
                    </button>
                    <button
                      className="flex w-full items-center gap-2.5 rounded-md px-3 py-2.5 text-sm hover:bg-accent"
                      onClick={() => logout()}
                    >
                      <LogOut className="w-3.5 h-3.5" /> Sign out
                    </button>
                  </div>
                </>,
                document.body,
              )}
            </div>
          </div>
        </header>

        {connectionStatus === 'update_available' && (
          <div className="flex items-center justify-center gap-3 py-2.5 px-4 bg-amber-500 dark:bg-amber-600 text-white text-sm font-medium animate-pulse">
            <span>A new version is available</span>
            <button
              onClick={() => window.location.reload()}
              className="px-3 py-1 bg-white text-amber-700 rounded font-semibold text-xs hover:bg-amber-50 transition-colors"
            >
              Reload now
            </button>
          </div>
        )}

        <WorkspaceProvider value={workspaceCtx}>
          {/* Core chat-only: a single conversation pane for the active session (no tabs / multi-pane layout). */}
          <div className="flex-1 min-h-0">
            <ConversationPane key={activeSessionId ?? 'new'} nodeId="main" sessionId={activeSessionId} />
          </div>
        </WorkspaceProvider>
      </div>

      <ToastStack
        toasts={toasts}
        onDismiss={dismissToast}
        onOpen={(sid) => {
          openSession(sid);
          markRead(sid);
        }}
      />
    </div>
  );
}
