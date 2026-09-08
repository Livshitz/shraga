/**
 * The conversation-list state machine, driven through a real React render.
 *
 * These lock the three things that regressed when /api/sessions became paged: a global broadcast
 * must not collapse the user's paged depth, a "Show older" resolving after a filter toggle must not
 * land in the other list, and a by-id hydrated row must not keep its fetch-time snapshot forever.
 */
// happy-dom's registrator installs window, document AND the web globals — fetch, Response,
// Request, Headers — onto globalThis for the WHOLE bun process, which shares one module registry
// across every test file. Left registered, every later file that speaks real HTTP is talking to a
// DOM emulation instead of bun's runtime: measured 2026-09-08, this file alone failed 52 tests in
// webhook-lane, spa-catchall, claude-usage, self-upgrade and createShraga on CI, and reproduced on
// no dev machine because it depends on file order and the installed happy-dom. Hand the globals
// back when this file is done.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register();

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'bun:test';

afterAll(async () => { await GlobalRegistrator.unregister(); });
import { createElement, useState, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useSessionList, PAGE_SIZE, type SessionRow } from '../hooks/useSessionList.ts';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/** A fake index: `mine` rows are every third one, matching what the server would stamp. */
function makeIndex(n: number): SessionRow[] {
  return Array.from({ length: n }, (_, i) => ({
    sessionId: `s${String(i).padStart(4, '0')}`,
    title: `t${i}`,
    userName: 'u',
    lastModified: 1_000_000 - i,
    mine: i % 3 === 0,
  }));
}

const ALL = makeIndex(500);
const MINE = ALL.filter((s) => s.mine);

const cursorOf = (s: SessionRow) => `${String(s.lastModified).padStart(16, '0')}.${s.sessionId}`;

let calls: string[] = [];
/** Requests parked here resolve only when the test says so — that is how a race gets staged. */
let gate: ((v: unknown) => void)[] = [];
let gateNext = false;

function install() {
  calls = []; gate = []; gateNext = false;
  (globalThis as any).fetch = async (url: string) => {
    calls.push(url);
    const q = new URLSearchParams(url.split('?')[1] ?? '');
    let body: { sessions: SessionRow[]; nextCursor: string | null };
    if (q.get('ids')) {
      const want = new Set(q.get('ids')!.split(','));
      // Hydration re-reads: bump lastModified so a stale row is visible as a stale row.
      body = { sessions: ALL.filter((s) => want.has(s.sessionId)).map((s) => ({ ...s, title: `${s.title}#${hydrateGen}` })), nextCursor: null };
    } else {
      const list = q.get('filter') === 'mine' ? MINE : ALL;
      const before = q.get('before');
      const rest = before ? list.filter((s) => cursorOf(s) < before) : list;
      const limit = Number(q.get('limit'));
      const page = rest.slice(0, limit);
      body = { sessions: page, nextCursor: rest.length > page.length ? cursorOf(page[page.length - 1]) : null };
    }
    if (gateNext) { gateNext = false; await new Promise((r) => gate.push(r)); }
    return { ok: true, json: async () => body } as unknown as Response;
  };
}

let hydrateGen = 0;
const getToken = async () => 'tok';

/** Probe component: exposes the hook's state and lets the test change its inputs. */
let ctl: { setFilter: (f: 'mine' | 'all') => void; bump: () => void; setIds: (ids: string[]) => void };
let snap: ReturnType<typeof useSessionList>;

function Probe() {
  const [filter, setFilter] = useState<'mine' | 'all'>('all');
  const [refreshKey, setRefreshKey] = useState(0);
  const [ids, setIds] = useState<string[]>([]);
  ctl = { setFilter, bump: () => setRefreshKey((k) => k + 1), setIds };
  snap = useSessionList({ getToken, filter, refreshKey, hydrateIds: ids });
  return null;
}

let root: Root; let host: HTMLElement;

async function flush() { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); }

beforeEach(async () => {
  install();
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => { root = createRoot(host); root.render(createElement(Probe)); });
  await flush();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('useSessionList', () => {
  it('loads one page on mount', () => {
    expect(snap.sessions.length).toBe(PAGE_SIZE);
    expect(snap.sessions[0].sessionId).toBe('s0000');
    expect(snap.cursor).not.toBeNull();
  });

  it('D2 — a refresh reloads the paged DEPTH, not page 1', async () => {
    for (let i = 0; i < 3; i++) { await act(async () => snap.loadMore()); await flush(); }
    expect(snap.sessions.length).toBe(PAGE_SIZE * 4);

    const before = calls.length;
    await act(async () => ctl.bump()); // what session_messages_changed does, to every socket
    await flush();

    expect(snap.sessions.length).toBe(PAGE_SIZE * 4); // NOT collapsed to 50
    expect(snap.sessions.map((s) => s.sessionId)).toEqual(ALL.slice(0, 200).map((s) => s.sessionId));
    // …and it costs a bounded walk of what was loaded, not a full-index fetch.
    expect(calls.length - before).toBe(4);
    expect(calls.slice(before).every((u) => u.includes('limit=50'))).toBe(true);
    expect(snap.cursor).not.toBeNull(); // paging still continues from the deep end
  });

  it('D2 — depth resets to one page when the scope changes', async () => {
    await act(async () => snap.loadMore()); await flush();
    expect(snap.sessions.length).toBe(PAGE_SIZE * 2);
    await act(async () => ctl.setFilter('mine')); await flush();
    expect(snap.sessions.length).toBe(PAGE_SIZE);
    expect(snap.sessions.every((s) => s.mine)).toBe(true);
  });

  it('D3 — a "Show older" resolving after a filter toggle is dropped, cursor included', async () => {
    gateNext = true;
    await act(async () => snap.loadMore()); // parked in flight
    await flush();
    expect(gate.length).toBe(1);

    await act(async () => ctl.setFilter('mine')); // toggle while it is in flight
    await flush();
    const scopedCursor = snap.cursor;
    expect(snap.sessions.every((s) => s.mine)).toBe(true);

    await act(async () => { gate.forEach((r) => r(null)); gate = []; }); // stale page lands now
    await flush();

    expect(snap.sessions.every((s) => s.mine)).toBe(true); // no foreign rows appended
    expect(snap.sessions.length).toBe(PAGE_SIZE);
    expect(snap.cursor).toBe(scopedCursor); // and the wrong filter's cursor was not installed
  });

  it('D5 — hydrated rows are re-read on refresh instead of freezing at fetch time', async () => {
    const far = ALL[400].sessionId; // well outside the loaded window
    hydrateGen = 1;
    await act(async () => ctl.setIds([far])); await flush();
    expect(snap.byId.get(far)?.title).toBe('t400#1');

    hydrateGen = 2;
    await act(async () => ctl.bump()); await flush();
    expect(snap.byId.get(far)?.title).toBe('t400#2'); // refreshed, not the first snapshot
  });

  it('D5 — a paged row still wins over a hydrated one', async () => {
    hydrateGen = 9;
    await act(async () => ctl.setIds([ALL[0].sessionId])); await flush();
    expect(snap.byId.get(ALL[0].sessionId)?.title).toBe('t0'); // the page's copy, not "t0#9"
  });
});

import { scopeUnread } from '../components/Sidebar.tsx';

describe('D4 — unread scoping', () => {
  const rows = new Map<string, SessionRow>([
    ['a', { ...ALL[0], sessionId: 'a', mine: true }],
    ['b', { ...ALL[1], sessionId: 'b', mine: false }], // someone else's session, owner replied in it
  ]);
  const unreads = { a: 1, b: 1, gone: 1 } as Record<string, unknown>;

  it('hides an unread on a session that is not mine under "mine"', () => {
    expect(scopeUnread(unreads, rows, 'mine').map((s) => s.sessionId)).toEqual(['a']);
  });

  it('shows both under "all", and never an id with no row', () => {
    expect(scopeUnread(unreads, rows, 'all').map((s) => s.sessionId)).toEqual(['a', 'b']);
  });
});
