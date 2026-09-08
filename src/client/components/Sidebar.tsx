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
import { useSessionList, type SessionRow as Session, type ChatsFilter } from '@/hooks/useSessionList';
import { CLIENT_BUILD_VERSION } from '@/lib/build-version';

interface Props {
  getToken: () => Promise<string | null>;
  activeSessionId?: string;
  onSelect: (sessionId: string, title?: string) => void;
  onNew: () => void;
  refreshKey?: number;
  workspaceRefreshKey?: number;
  onRefreshWorkspace: () => void;
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

/**
 * Unread rows the current scope should show. Exported so the scoping is testable on its own: it is
 * what the old client-side `scopeFiltered`/`visibleUnreadCount` did, moved onto the server-stamped
 * `mine` flag because the trimmed list row no longer carries uid/visibleTo.
 */
export function scopeUnread(unreads: Record<string, unknown>, byId: Map<string, Session>, filter: ChatsFilter): Session[] {
  return Object.keys(unreads)
    .map((id) => byId.get(id))
    .filter((s): s is Session => !!s && (filter === 'all' || s.mine !== false));
}

const FILTER_KEY = 'chats-filter';
const UNREAD_FILTER_KEY = 'chats-unread-filter';

export function Sidebar({ getToken, activeSessionId, onSelect, onNew, refreshKey, workspaceRefreshKey, onRefreshWorkspace, unreads = {}, busySessions = new Set(), socket }: Props) {
  const slots = useSlots();
  const [filter, setFilter] = useState<ChatsFilter>(() => (localStorage.getItem(FILTER_KEY) as ChatsFilter) || 'mine');
  const [unreadOnly, setUnreadOnly] = useState(() => localStorage.getItem(UNREAD_FILTER_KEY) === 'true');
  const [version, setVersion] = useState<string>('');
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

  // ── Data ───────────────────────────────────────────────────────────────────
  const hydrateIds = useMemo(
    () => [activeSessionId, ...Object.keys(unreads)].filter((id): id is string => !!id),
    [activeSessionId, unreads],
  );
  const { sessions, cursor, loading, byId, loadMore } = useSessionList({ getToken, filter, refreshKey, hydrateIds });

  // Both the unread VIEW and the unread DOT are scoped by `mine`, which the server stamps on every
  // row (the trimmed list item no longer carries uid/visibleTo, so the client cannot re-derive it).
  // Without this an owner replying in someone else's session lights the dot and lists that row
  // under "mine" — the old client-side scopeFiltered/visibleUnreadCount did scope it.
  // `?ids=` hydration stays UNSCOPED on purpose: the active row must render whatever the filter is.
  const unreadRows = useMemo(() => scopeUnread(unreads, byId, filter), [unreads, byId, filter]);
  const unreadCount = unreadRows.length;

  const filtered = useMemo(() => {
    if (!unreadOnly) return sessions;
    return [...unreadRows].sort((a, b) => b.lastModified - a.lastModified);
  }, [unreadOnly, unreadRows, sessions]);

  // The open conversation is ALWAYS rendered: a deep link, an unread toast or any older thread lands
  // outside the window, and a list without the active row highlights nothing and never scrolls to it.
  const activeRow = activeSessionId && !filtered.some((s) => s.sessionId === activeSessionId)
    ? byId.get(activeSessionId)
    : undefined;

  useEffect(() => {
    if (activeRef.current) {
      activeRef.current.scrollIntoView({ block: 'nearest' });
    }
  }, [activeSessionId, filtered, activeRow]);

  useEffect(() => {
    getToken().then(t => t ? fetch('/api/version', { headers: { Authorization: `Bearer ${t}` } }) : null).then(r => r?.json()).then(d => d && setVersion(d.version)).catch(() => {});
  }, []);

  // Version skew is SILENT otherwise: a `dist/client` left stale by a deploy keeps serving a client
  // written against an older API shape, which discards the new response and renders an empty list —
  // no error, no log (the list routes are quiet on 200). Surface it instead of debugging a ghost.
  const stale = !!version && version !== 'unknown' && CLIENT_BUILD_VERSION !== 'dev' && version !== CLIENT_BUILD_VERSION;
  useEffect(() => {
    if (stale) console.warn(`[shraga] stale client bundle: built from v${CLIENT_BUILD_VERSION}, server runs v${version} — rebuild dist/client`);
  }, [stale, version]);

  function renderRow(s: Session) {
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
  }

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
            unread{unreadCount > 0 && <span className="inline-block w-1.5 h-1.5 ml-1 rounded-full bg-blue-500 align-middle" />}
          </button>
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="px-2 pb-2 space-y-0.5">
          {filtered.length === 0 && !activeRow && (
            <p className="text-xs text-muted-foreground px-3 py-6 text-center">
              {loading ? 'Loading…' : unreadOnly ? 'No unread conversations' : 'No conversations yet'}
            </p>
          )}
          {activeRow && renderRow(activeRow)}
          {filtered.map(renderRow)}
          {!unreadOnly && cursor && (
            <button
              onClick={loadMore}
              disabled={loading}
              className="w-full text-[11px] text-muted-foreground hover:text-foreground py-2 rounded-lg hover:bg-accent/50 transition-colors disabled:opacity-50"
            >
              {loading ? 'Loading…' : 'Show older'}
            </button>
          )}
        </div>
      </ScrollArea>

      <div className="px-4 py-2 flex flex-col items-center gap-1">
        <MachineStats socket={socket ?? null} getToken={getToken} />
        {slots.sidebarExtras?.()}
        {version && (
          stale ? (
            <button
              onClick={() => location.reload()}
              title={`This page was built from v${CLIENT_BUILD_VERSION}, the server runs v${version} — reload to update`}
              className="text-[10px] text-amber-400 hover:text-amber-300 text-center underline decoration-dotted"
            >
              ⚠️ stale page (v{CLIENT_BUILD_VERSION} → v{version}) · reload
            </button>
          ) : (
            <div className="text-[10px] text-muted-foreground/50 text-center">v{version}</div>
          )
        )}
      </div>
    </div>
  );
}
