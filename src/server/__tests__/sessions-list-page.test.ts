import { describe, it, expect } from 'bun:test';
import { toListItem, pageSessions, sessionCursor, isOwnSession, type SessionMeta } from '../sessions.ts';

function meta(over: Partial<SessionMeta>): SessionMeta {
  return {
    sessionId: 's', title: 't', userEmail: 'a@b.c', userName: 'a', uid: 'u',
    createdAt: 0, lastModified: 0, ...over,
  };
}

/** Same order getAllSessions() produces, so the cursor predicate matches the list it pages. */
function sorted(list: SessionMeta[]): SessionMeta[] {
  return [...list].sort((a, b) => b.lastModified - a.lastModified || (a.sessionId < b.sessionId ? 1 : a.sessionId > b.sessionId ? -1 : 0));
}

describe('session list shape', () => {
  it('ships only what the sidebar renders — never the server bookkeeping', () => {
    const item = toListItem(meta({
      sessionId: 'abc', title: 'hi', userName: 'elya', lastModified: 5,
      runStatus: 'running', scheduleRunStatus: 'ok', lastStopReason: 'error',
      slackContext: { type: 'dm', userName: 'e' },
      // The 555 KB the old endpoint shipped to every browser on every load:
      triggeredSkills: ['a', 'b'], seenSlackTs: ['1.0', '2.0'],
      // …plus per-session config the list has no use for.
      directives: { model: 'opus' } as SessionMeta['directives'], visibleTo: ['x@y.z'], uid: 'u1', userEmail: 'u@x.y',
    }));
    expect(Object.keys(item).sort()).toEqual(
      ['lastModified', 'lastStopReason', 'runStatus', 'scheduleRunStatus', 'sessionId', 'slackContext', 'title', 'userName'],
    );
  });

  it('omits absent optionals rather than sending nulls', () => {
    expect(Object.keys(toListItem(meta({ sessionId: 'a' }))).sort()).toEqual(['lastModified', 'sessionId', 'title', 'userName']);
  });
});

describe('pageSessions', () => {
  // Deliberately full of lastModified ties: a timestamp-only cursor loses records here.
  const all = sorted(Array.from({ length: 137 }, (_, i) => meta({ sessionId: `s${i}`, lastModified: Math.floor(i / 4) })));

  it('walks the whole list exactly once across pages', () => {
    const seen: string[] = [];
    let before: string | undefined;
    for (let guard = 0; guard < 100; guard++) {
      const page = pageSessions(all, { limit: 20, before });
      seen.push(...page.sessions.map((s) => s.sessionId));
      if (!page.nextCursor) break;
      before = page.nextCursor;
    }
    expect(seen).toEqual(all.map((s) => s.sessionId)); // no gaps, no repeats, same order
    expect(new Set(seen).size).toBe(137);
  });

  it('ends with a null cursor on the last page', () => {
    expect(pageSessions(all, { limit: 200 }).nextCursor).toBeNull();
    expect(pageSessions(all.slice(0, 20), { limit: 20 }).nextCursor).toBeNull();
  });

  it('orders the cursor consistently with the list order', () => {
    for (let i = 1; i < all.length; i++) expect(sessionCursor(all[i]) < sessionCursor(all[i - 1])).toBe(true);
  });
});

describe('the `mine` stamp', () => {
  // The trimmed row drops uid/visibleTo, so the client cannot re-derive ownership — the server has
  // to say so, or the unread view and its dot silently stop respecting the mine/all filter.
  const own = meta({ sessionId: 'own', uid: 'me' });
  const shared = meta({ sessionId: 'shared', uid: 'other', visibleTo: ['me@x.y'] });
  const foreign = meta({ sessionId: 'foreign', uid: 'other' });

  it('matches the old client-side isMine predicate', () => {
    expect(isOwnSession(own, 'me', 'me@x.y')).toBe(true);
    expect(isOwnSession(shared, 'me', 'me@x.y')).toBe(true);
    expect(isOwnSession(foreign, 'me', 'me@x.y')).toBe(false);
  });

  it('is absent unless asked for, so the row shape is unchanged for other callers', () => {
    expect('mine' in toListItem(own)).toBe(false);
    expect(toListItem(own, true).mine).toBe(true);
    expect(toListItem(foreign, false).mine).toBe(false);
  });

  it('is stamped on every paged row, including under filter=all', () => {
    const page = pageSessions(sorted([own, shared, foreign]), { limit: 10, mine: (s) => isOwnSession(s, 'me', 'me@x.y') });
    expect(Object.fromEntries(page.sessions.map((s) => [s.sessionId, s.mine]))).toEqual({ own: true, shared: true, foreign: false });
  });
});
