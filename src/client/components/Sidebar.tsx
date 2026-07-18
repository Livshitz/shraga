import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, MessageSquare, Hash, AtSign, MessageCircle } from 'lucide-react';
import { Button } from './ui/button';
import { ScrollArea } from './ui/scroll-area';
import { cn } from '@/lib/utils';
import { WorkspaceTree } from './WorkspaceTree';
import { useSlots } from '@/lib/slots';
import { MachineStats } from './MachineStats';
import type { UnreadSession } from '@/hooks/useUnread';
import type { AgentSocket } from '@/lib/ws';

interface Session {
  sessionId: string;
  title: string;
  userEmail: string;
  userName: string;
  uid: string;
  createdAt: number;
  lastModified: number;
  scope?: 'system' | 'user';
  visibleTo?: string[];
  slackContext?: { type: 'dm' | 'channel' | 'mention'; channelName?: string; userName?: string };
  runStatus?: 'running' | 'idle';
  lastStopReason?: 'max_turns_reached' | 'error' | 'aborted';
  scheduleRunStatus?: 'running' | 'ok' | 'error' | 'aborted';
}

type ChatsFilter = 'mine' | 'all';

function isMine(s: Session, uid: string, email: string): boolean {
  if (s.uid === uid) return true;
  if (s.visibleTo?.includes(email.toLowerCase())) return true;
  return false;
}

interface Props {
  getToken: () => Promise<string | null>;
  activeSessionId?: string;
  onSelect: (sessionId: string, title?: string) => void;
  onNew: () => void;
  refreshKey?: number;
  workspaceRefreshKey?: number;
  onRefreshWorkspace: () => void;
  userUid: string;
  userEmail: string;
  unreads?: Record<string, UnreadSession>;
  busySessions?: Set<string>;
  socket?: AgentSocket | null;
}

export function formatTime(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const iconCls = 'w-4 h-4 mt-0.5 shrink-0';

function slackIcon(s: Session) {
  const ctx = s.slackContext;
  if (ctx?.type === 'dm') return <MessageCircle className={`${iconCls} text-purple-400`} />;
  if (ctx?.type === 'mention') return <AtSign className={`${iconCls} text-blue-400`} />;
  if (ctx?.type === 'channel') return <Hash className={`${iconCls} text-green-400`} />;
  if (s.sessionId.startsWith('slack-')) return <MessageSquare className={`${iconCls} text-yellow-400`} />;
  return <MessageSquare className={`${iconCls} text-muted-foreground`} />;
}

function slackLabel(s: Session): string | null {
  const ctx = s.slackContext;
  if (ctx?.type === 'dm') return `DM${ctx.userName ? ` · ${ctx.userName}` : ''}`;
  if (ctx?.type === 'mention') return `@mention${ctx.channelName ? ` · #${ctx.channelName}` : ''}`;
  if (ctx?.type === 'channel') return `#${ctx.channelName || 'channel'}`;
  if (s.sessionId.startsWith('slack-')) return 'Slack';
  return null;
}

const FILTER_KEY = 'chats-filter';
const UNREAD_FILTER_KEY = 'chats-unread-filter';

export function Sidebar({ getToken, activeSessionId, onSelect, onNew, refreshKey, workspaceRefreshKey, onRefreshWorkspace, userUid, userEmail, unreads = {}, busySessions = new Set(), socket }: Props) {
  const slots = useSlots();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [filter, setFilter] = useState<ChatsFilter>(() => (localStorage.getItem(FILTER_KEY) as ChatsFilter) || 'mine');
  const [unreadOnly, setUnreadOnly] = useState(() => localStorage.getItem(UNREAD_FILTER_KEY) === 'true');
  const [version, setVersion] = useState<string>('');
  const acRef = useRef<AbortController | null>(null);
  const activeRef = useRef<HTMLButtonElement | null>(null);

  function changeFilter(f: ChatsFilter) {
    setFilter(f);
    localStorage.setItem(FILTER_KEY, f);
  }

  function toggleUnreadOnly() {
    const next = !unreadOnly;
    setUnreadOnly(next);
    localStorage.setItem(UNREAD_FILTER_KEY, String(next));
  }

  const scopeFiltered = useMemo(() =>
    sessions.filter((s) => filter === 'all' || isMine(s, userUid, userEmail)),
    [sessions, filter, userUid, userEmail],
  );

  const visibleUnreadCount = useMemo(() =>
    scopeFiltered.filter((s) => unreads[s.sessionId]).length,
    [scopeFiltered, unreads],
  );

  const filtered = useMemo(() =>
    unreadOnly ? scopeFiltered.filter((s) => unreads[s.sessionId]) : scopeFiltered,
    [scopeFiltered, unreadOnly, unreads],
  );

  useEffect(() => {
    getToken().then(t => t ? fetch('/api/version', { headers: { Authorization: `Bearer ${t}` } }) : null).then(r => r?.json()).then(d => d && setVersion(d.version)).catch(() => {});
  }, []);

  useEffect(() => {
    acRef.current?.abort();
    const ac = new AbortController();
    acRef.current = ac;

    getToken().then((token) => {
      if (!token || ac.signal.aborted) return;
      fetch('/api/sessions', { signal: ac.signal, headers: { Authorization: `Bearer ${token}` } })
        .then((r) => (r.ok ? r.json() : []))
        .then((data) => { if (Array.isArray(data)) setSessions(data); })
        .catch(() => {});
    });

    return () => ac.abort();
  }, [getToken, refreshKey]);

  useEffect(() => {
    if (activeRef.current) {
      activeRef.current.scrollIntoView({ block: 'nearest' });
    }
  }, [activeSessionId]);

  return (
    <div className="flex flex-col h-full bg-muted/30">
      <div className="p-3">
        <Button variant="outline" size="sm" className="w-full gap-2 justify-start" onClick={onNew} title="New Chat (Ctrl+N)">
          <Plus className="w-4 h-4" /> New Chat
          <span className="ml-auto flex items-center gap-0.5 text-[10px] text-muted-foreground/50 font-mono">⌃N</span>
        </Button>
      </div>

      <div className="border-b shrink-0 flex flex-col max-h-[40vh]">
        <WorkspaceTree getToken={getToken} onRefresh={onRefreshWorkspace} refreshKey={workspaceRefreshKey} />
      </div>

      <div className="flex items-center justify-between px-3 pt-2 pb-1">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Chats</span>
        <div className="flex gap-0.5">
          {(['mine', 'all'] as const).map((f) => (
            <button key={f} onClick={() => changeFilter(f)} className={cn(
              'text-[10px] px-1.5 rounded-full transition-colors capitalize leading-none',
              filter === f ? 'text-foreground font-medium' : 'text-muted-foreground/60 hover:text-muted-foreground'
            )}>{f}</button>
          ))}
          <button
            onClick={toggleUnreadOnly}
            className={cn(
              'text-[10px] px-1.5 rounded-full transition-colors leading-none',
              unreadOnly ? 'text-blue-600 dark:text-blue-400 font-medium' : 'text-muted-foreground/60 hover:text-muted-foreground',
            )}
          >
            unread{visibleUnreadCount > 0 && <span className="inline-block w-1.5 h-1.5 ml-1 rounded-full bg-blue-500 align-middle" />}
          </button>
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="px-2 pb-2 space-y-0.5">
          {filtered.length === 0 && (
            <p className="text-xs text-muted-foreground px-3 py-6 text-center">
              {unreadOnly ? 'No unread conversations' : sessions.length === 0 ? 'No conversations yet' : 'No conversations match this filter'}
            </p>
          )}
          {filtered.map((s) => {
            const unread = unreads[s.sessionId];
            const isBusy = busySessions.has(s.sessionId) || s.runStatus === 'running' || s.scheduleRunStatus === 'running';
            const isError = !isBusy && (!!s.lastStopReason || s.scheduleRunStatus === 'error' || s.scheduleRunStatus === 'aborted');
            const borderColor = isBusy ? 'border-amber-500' : isError ? 'border-red-500' : unread ? 'border-blue-500' : '';
            const hasBorder = !!(isBusy || isError || unread);
            return (
              <button
                key={s.sessionId}
                ref={s.sessionId === activeSessionId ? activeRef : undefined}
                onClick={() => onSelect(s.sessionId, s.title)}
                className={cn(
                  'w-full text-left px-3 py-2.5 text-sm transition-colors hover:bg-accent/50 group',
                  hasBorder ? `rounded-r-lg border-l-[3px] ${borderColor}` : 'rounded-lg',
                  activeSessionId === s.sessionId && 'bg-accent',
                )}
              >
                <div className="flex items-start gap-2">
                  {slackIcon(s)}
                  <div className="min-w-0 flex-1">
                    <span className={cn('block truncate text-sm leading-snug', unread && 'font-semibold')}>
                      {s.title || 'New session'}
                    </span>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className="text-[10px] text-muted-foreground font-medium">
                        {slackLabel(s) || s.userName}
                      </span>
                      <span className="text-[10px] text-muted-foreground/50">·</span>
                      <span className="text-[10px] text-muted-foreground">{formatTime(s.lastModified)}</span>
                    </div>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </ScrollArea>

      <div className="px-4 py-2 flex flex-col items-center gap-1">
        <MachineStats socket={socket ?? null} getToken={getToken} />
        {slots.sidebarExtras?.()}
        {version && (
          <div className="text-[10px] text-muted-foreground/50 text-center">v{version}</div>
        )}
      </div>
    </div>
  );
}
