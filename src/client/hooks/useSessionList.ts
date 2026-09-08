import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/** Mirrors the server's SessionListItem — the trimmed row shape /api/sessions returns. */
export interface SessionRow {
  sessionId: string;
  title: string;
  userName: string;
  lastModified: number;
  slackContext?: { type: 'dm' | 'channel' | 'mention'; channelName?: string; userName?: string };
  runStatus?: 'running' | 'idle';
  lastStopReason?: 'max_turns_reached' | 'error' | 'aborted';
  scheduleRunStatus?: 'running' | 'ok' | 'error' | 'aborted';
  /** Server-stamped: owned by (or explicitly shared with) the caller. */
  mine?: boolean;
}

export interface SessionPage {
  sessions: SessionRow[];
  nextCursor: string | null;
}

export type ChatsFilter = 'mine' | 'all';

/** Chat rows fetched per request — the list is unbounded and every row is real DOM. */
export const PAGE_SIZE = 50;

interface Options {
  getToken: () => Promise<string | null>;
  filter: ChatsFilter;
  refreshKey?: number;
  /** Ids that must have a row even when they sit outside the loaded window (active + unread). */
  hydrateIds: string[];
}

/**
 * The conversation list's paging/refresh state machine, kept out of the component so it can be
 * driven directly by a test. /api/sessions is paged and trimmed (it used to ship the whole 6.76 MB
 * index); `sessions` is the loaded window, newest first, scoped to `filter` by the SERVER — `mine`
 * is a predicate over the whole 12k index and cannot be honestly evaluated inside one page.
 */
export function useSessionList({ getToken, filter, refreshKey, hydrateIds }: Options) {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Rows fetched by id because they sit OUTSIDE the loaded window: the active conversation, and any
  // unread one. The unread map arrives complete over the socket (`unread_sync`), so hydrating by id
  // is what keeps the unread filter from silently searching only the first page.
  const [extras, setExtras] = useState<Record<string, SessionRow>>({});
  const requestedRef = useRef<Set<string>>(new Set());
  const acRef = useRef<AbortController | null>(null);
  const moreAcRef = useRef<AbortController | null>(null);
  // Read inside async resolves, where the captured `filter` may already be stale.
  const filterRef = useRef(filter);
  filterRef.current = filter;
  // How many rows the user has actually paged into view. A refresh must reload THIS much, not just
  // page 1: `session_messages_changed` is broadcast to EVERY socket (any Slack message, any
  // scheduler run, anyone's turn ending), so on a busy box a page-1 reset fires near-continuously
  // and collapses a user who clicked "Show older" five times back to 50 rows.
  const depthRef = useRef(PAGE_SIZE);
  // Reset by the consumer when the scope changes — a different scope is a different list.
  const prevFilter = useRef(filter);
  if (prevFilter.current !== filter) { prevFilter.current = filter; depthRef.current = PAGE_SIZE; }

  const fetchSessions = useCallback(async (query: Record<string, string>, signal?: AbortSignal): Promise<SessionPage | null> => {
    const token = await getToken();
    if (!token || signal?.aborted) return null;
    const r = await fetch(`/api/sessions?${new URLSearchParams(query)}`, { signal, headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return null;
    const page = (await r.json()) as SessionPage;
    return Array.isArray(page?.sessions) ? page : null;
  }, [getToken]);

  /**
   * Re-read the first `depth` rows of the current scope, walking as many server pages as that takes
   * (the server caps `limit`, so a depth beyond one page is a short sequential walk — bounded by
   * what the user actually paged in, never by the 12k index).
   */
  const fetchWindow = useCallback(async (depth: number, f: ChatsFilter, signal: AbortSignal): Promise<SessionPage | null> => {
    const acc: SessionRow[] = [];
    let before: string | undefined;
    let nextCursor: string | null = null;
    while (acc.length < depth) {
      const q: Record<string, string> = { filter: f, limit: String(Math.min(PAGE_SIZE, depth - acc.length)) };
      if (before) q.before = before;
      const page = await fetchSessions(q, signal);
      if (!page) return null;
      acc.push(...page.sessions);
      nextCursor = page.nextCursor;
      if (!nextCursor || !page.sessions.length) break;
      before = nextCursor;
    }
    return { sessions: acc, nextCursor };
  }, [fetchSessions]);

  useEffect(() => {
    acRef.current?.abort();
    moreAcRef.current?.abort(); // a "Show older" in flight belongs to the list we are replacing
    const ac = new AbortController();
    acRef.current = ac;
    setLoading(true);
    // Hydrated rows are re-read too: `extras` is fetch-time data (title, lastModified, runStatus)
    // and without this a by-id row keeps its first snapshot for the life of the page. Cleared HERE,
    // synchronously at commit, not in the fetch's .then() — doing it on resolve lost the mount race
    // against the by-id hydration and left the deep-linked active session with no row at all.
    requestedRef.current.clear();
    setExtras({});
    fetchWindow(depthRef.current, filter, ac.signal)
      .then((page) => {
        if (!page || ac.signal.aborted) return;
        setSessions(page.sessions);
        setCursor(page.nextCursor);
      })
      .catch(() => {})
      .finally(() => { if (!ac.signal.aborted) setLoading(false); });
    return () => ac.abort();
  }, [fetchWindow, filter, refreshKey]);

  const loadMore = useCallback(() => {
    if (!cursor || loading) return;
    moreAcRef.current?.abort();
    const ac = new AbortController();
    moreAcRef.current = ac;
    const forFilter = filterRef.current; // resolving under a different scope must not append
    setLoading(true);
    fetchSessions({ filter: forFilter, limit: String(PAGE_SIZE), before: cursor }, ac.signal)
      .then((page) => {
        if (!page || ac.signal.aborted || forFilter !== filterRef.current) return;
        setSessions((prev) => {
          const have = new Set(prev.map((s) => s.sessionId));
          const next = [...prev, ...page.sessions.filter((s) => !have.has(s.sessionId))];
          depthRef.current = Math.max(PAGE_SIZE, next.length);
          return next;
        });
        setCursor(page.nextCursor);
      })
      .catch(() => {})
      .finally(() => { if (!ac.signal.aborted) setLoading(false); });
  }, [cursor, loading, fetchSessions]);

  const byId = useMemo(() => {
    const m = new Map<string, SessionRow>();
    for (const s of Object.values(extras)) m.set(s.sessionId, s);
    for (const s of sessions) m.set(s.sessionId, s); // a paged row wins over a hydrated one
    return m;
  }, [sessions, extras]);

  // Hydrate the ids the loaded window doesn't cover. `requestedRef` stops this looping on an id the
  // server never returns (e.g. a deleted session still in the unread map).
  const hydrateKey = hydrateIds.join(',');
  useEffect(() => {
    const want = hydrateIds.filter((id) => !!id && !byId.has(id) && !requestedRef.current.has(id)).slice(0, 200);
    if (!want.length) return;
    for (const id of want) requestedRef.current.add(id);
    let cancelled = false;
    fetchSessions({ ids: want.join(',') })
      .then((page) => {
        if (!page || cancelled) return;
        setExtras((prev) => {
          const next = { ...prev };
          for (const s of page.sessions) next[s.sessionId] = s;
          return next;
        });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [hydrateKey, byId, fetchSessions]);

  return { sessions, cursor, loading, byId, loadMore };
}
