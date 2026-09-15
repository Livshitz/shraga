/** Backend-health classifier + tiny store.
 *
 *  WHY this exists: a broken backend used to be INVISIBLE in the UI. When something other than shraga
 *  answered the app's port (e.g. another project's dev server bound `127.0.0.1:3033` while shraga held
 *  `*:3033` — macOS routes the loopback name to the MORE SPECIFIC bind, so the proxy fed every request
 *  to the wrong process), the foreign server 404'd `/api/config`, `/api/workspace` and refused the `/ws`
 *  upgrade. The UI rendered a normal-looking EMPTY shell: no workspace, no terminals, no error. Every
 *  clue was in the browser console and nothing reached the screen.
 *
 *  The load-bearing signal is {@link SHRAGA_VERSION_HEADER}: the shraga server stamps it on EVERY
 *  response including 404/401/5xx (src/server/boot.ts). So a response WITHOUT it did not come from
 *  shraga at all — which turns an ambiguous "some 404" into the exact diagnosis "something else is
 *  serving this port".
 *
 *  Producers report here from the SHARED helpers (`apiFetch`, `api`, `AgentSocket`) so every existing
 *  call site benefits with no call-site change. The single consumer is <BackendStatusBanner />.
 */
import { logger } from '@/lib/debug';

const log = logger.forComponent('BackendHealth');

/** Identity header stamped by the shraga server on every response. Lowercase: `Headers` is
 *  case-insensitive, but keeping it lowercase avoids any doubt about what we're matching. */
export const SHRAGA_VERSION_HEADER = 'x-shraga-version';

export type BackendFaultKind = 'wrong-backend' | 'server-error' | 'offline' | 'ws-down';

export interface BackendFault {
  kind: BackendFaultKind;
  /** One-line headline for the banner. */
  title: string;
  /** Actionable next step — what the user should actually go do. */
  hint: string;
  /** The request that exposed the fault, when there is one. */
  path?: string;
  status?: number;
}

/** Fault sources are tracked SEPARATELY: HTTP recovering must not erase a still-broken WebSocket
 *  (that is exactly the "terminals stay blank while the page looks fine" half of the incident). */
type Source = 'http' | 'ws';
const faults: Partial<Record<Source, BackendFault>> = {};
const raisedAt: Partial<Record<Source, number>> = {};

/** A raised fault does NOT vanish on the very next good response. The app polls continuously (pty cwd,
 *  workspace, layout), so a single interleaved success would otherwise erase the banner milliseconds
 *  after it appeared — leaving a user staring at a flicker they can neither read nor act on. Recovery
 *  must therefore be CONFIRMED: several consecutive good responses AND a minimum time on screen. */
/** ...and the SAME reasoning governs the WebSocket. An ordinary reconnect blip closes and re-opens in
 *  a couple of seconds (backoff is ~1s * 2^attempt + jitter); painting and erasing an amber banner
 *  inside that window is the flicker described above, not information. So a close is given
 *  `wsGraceMs` to recover before it becomes a fault at all — which still catches the case that
 *  motivated the feature, a socket that never comes back (including one wedged in CONNECTING, where
 *  counting reconnect ATTEMPTS would never trip) — and a recovered socket serves the same
 *  `minDwellMs` before the banner is taken down. */
const DEFAULT_TIMING = { okStreakToClear: 3, minDwellMs: 5_000, wsGraceMs: 5_000 };
type Timing = typeof DEFAULT_TIMING;
let timing: Timing = { ...DEFAULT_TIMING };
let okStreak = 0;
/** The single pending ws timer: a delayed RAISE while no ws fault is shown, a delayed CLEAR while one
 *  is (`faults.ws` disambiguates, and every path that changes that state cancels it first). */
let wsTimer: ReturnType<typeof setTimeout> | null = null;
function cancelWsTimer() {
  if (wsTimer) { clearTimeout(wsTimer); wsTimer = null; }
}

/** Worst-first. `wrong-backend` outranks everything: when the port is hijacked the 404s and the dead
 *  socket are SYMPTOMS, and showing either of those instead would send the user down the wrong path. */
const PRECEDENCE: BackendFaultKind[] = ['wrong-backend', 'offline', 'server-error', 'ws-down'];

type Listener = (fault: BackendFault | null) => void;
const listeners = new Set<Listener>();

export function currentFault(): BackendFault | null {
  const present = (Object.values(faults) as BackendFault[]).filter(Boolean);
  if (present.length === 0) return null;
  return present.sort((a, b) => PRECEDENCE.indexOf(a.kind) - PRECEDENCE.indexOf(b.kind))[0];
}

function emit() {
  const f = currentFault();
  listeners.forEach((l) => l(f));
}

export function subscribeBackendHealth(listener: Listener): () => void {
  listeners.add(listener);
  listener(currentFault());
  return () => { listeners.delete(listener); };
}

function set(source: Source, fault: BackendFault) {
  const prev = faults[source];
  faults[source] = fault;
  // Restart the dwell when the fault CHANGES KIND too: a wrong-backend that supersedes an older
  // server-error is a new message and needs its own time on screen, not the predecessor's leftovers.
  if (prev?.kind !== fault.kind) raisedAt[source] = Date.now();
  if (source === 'http') okStreak = 0;
  // Log the transition only, not every repeat — a broken backend is polled continuously.
  if (prev?.kind !== fault.kind || prev?.path !== fault.path || prev?.status !== fault.status) {
    log.warn(`${fault.kind}: ${fault.title}`, { path: fault.path, status: fault.status });
  }
  emit();
}

function clear(source: Source) {
  if (!faults[source]) return;
  log.info(`${source} recovered`);
  delete faults[source];
  delete raisedAt[source];
  emit();
}

/** Describe the origin the app believes it is talking to, for the wrong-backend message. */
function originLabel(): string {
  try { return window.location.origin; } catch { return 'this origin'; }
}

/**
 * Classify a COMPLETED HTTP response from the shraga API. Call for ok and !ok alike — a wrong backend
 * can answer `200` just as easily as `404`, so the identity header is checked first, unconditionally.
 *
 * `expect` lists statuses this CALL SITE treats as a normal, handled outcome (e.g. the pty-cwd poller,
 * for which 404 means "that pane is gone" and is swallowed by design). An expected status is not a
 * fault: raising a banner for a by-design 404 is the cry-wolf failure this whole module exists to
 * avoid. It is checked AFTER the identity header, so a hijacker answering 404 is still caught.
 */
export function reportApiResponse(path: string, res: Response, expect?: readonly number[]): void {
  if (!res.headers.has(SHRAGA_VERSION_HEADER)) {
    set('http', {
      kind: 'wrong-backend',
      title: `${originLabel()} is being served by something that is not Shraga.`,
      hint:
        'Another process is almost certainly bound to the app port and shadowing the real server ' +
        '(a more specific 127.0.0.1 bind wins over Shraga’s wildcard bind). Find it with ' +
        '`lsof -nP -iTCP:<port> -sTCP:LISTEN`, stop it, then retry.',
      path,
      status: res.status,
    });
    return;
  }
  // Genuine shraga auth responses are the ORDINARY login/permission flow — never a banner. Checked
  // after the header so a hijacker that answers 401 is still caught above.
  if (res.status === 401 || res.status === 403) return;
  // Handled by the caller — neither a fault nor evidence of recovery.
  if (expect?.includes(res.status)) return;

  if (!res.ok) {
    set('http', {
      kind: 'server-error',
      title: `Shraga returned ${res.status} for ${path}.`,
      hint: 'The server is reachable but this request failed. Retry; if it persists, check the server logs.',
      path,
      status: res.status,
    });
    return;
  }
  okStreak++;
  if (faults.http && okStreak >= timing.okStreakToClear && Date.now() - (raisedAt.http ?? 0) >= timing.minDwellMs) {
    clear('http');
  }
}

/** Classify a request that never produced a response: network down, server unreachable, or aborted.
 *
 *  `timedOut` says the HELPER's OWN deadline fired (`apiFetch`'s `timeoutMs` controller). It is the
 *  only thing that separates a genuine wedged server from a CALLER-initiated `abort()` — both surface
 *  as an indistinguishable `AbortError`. A caller abort is ordinary control flow, not a fault: the tab
 *  palette re-issues its search on every keystroke and aborts the in-flight one, so raising here
 *  painted a red "cannot reach the server" banner for plain typing. Raise NOTHING for it.
 */
export function reportApiFailure(path: string, err: unknown, opts?: { timedOut?: boolean }): void {
  const aborted = (err as { name?: string } | null)?.name === 'AbortError';
  if (aborted && !opts?.timedOut) return;
  set('http', {
    kind: 'offline',
    title: opts?.timedOut ? `Request to ${path} timed out.` : `Cannot reach the Shraga server.`,
    hint: opts?.timedOut
      ? 'The server accepted the connection but did not answer in time. It may be overloaded or wedged.'
      : 'The network is down, or nothing is listening on the app port. Check your connection and that the server is running.',
    path,
  });
}

/** WebSocket health, reported by {@link AgentSocket}. A dead socket is why terminals and live updates
 *  silently stop; without this the panes just stay blank.
 *
 *  A close does NOT raise on its own — it starts the grace window (see {@link DEFAULT_TIMING}). Only a
 *  socket still down when the window expires is a fault the user can act on. */
export function reportWsDown(code?: number): void {
  // Already on screen: a re-close during the recovery dwell just keeps the banner up.
  if (faults.ws) { cancelWsTimer(); return; }
  // Grace already running from an earlier close in the same outage — don't restart it, or a socket
  // that flaps every few seconds would push the deadline out forever and never raise.
  if (wsTimer) return;
  const raise = () => {
    wsTimer = null;
    set('ws', {
      kind: 'ws-down',
      title: 'Live connection lost — terminals and streaming updates are offline.',
      hint:
        code === 1006
          ? 'The connection was refused or dropped without a close handshake, which usually means the ' +
            'WebSocket upgrade never reached Shraga. Reconnecting…'
          : 'Reconnecting…',
      status: code,
    });
  };
  if (timing.wsGraceMs <= 0) raise();
  else wsTimer = setTimeout(raise, timing.wsGraceMs);
}

export function reportWsUp(): void {
  cancelWsTimer(); // a blip that recovered inside the grace window never earned a banner
  if (!faults.ws) return;
  const remaining = timing.minDwellMs - (Date.now() - (raisedAt.ws ?? 0));
  if (remaining <= 0) { clear('ws'); return; }
  wsTimer = setTimeout(() => { wsTimer = null; clear('ws'); }, remaining);
}

/** Test seam — drop all state, and optionally shrink the timings so a test needn't wait seconds. */
export function __resetBackendHealth(overrides?: Partial<Timing>): void {
  cancelWsTimer();
  timing = { ...DEFAULT_TIMING, ...overrides };
  delete faults.http;
  delete faults.ws;
  delete raisedAt.http;
  delete raisedAt.ws;
  okStreak = 0;
  emit();
}
