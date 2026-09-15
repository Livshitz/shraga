import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  SHRAGA_VERSION_HEADER,
  reportApiFailure,
  __resetBackendHealth,
  currentFault,
  reportApiResponse,
  reportWsDown,
  reportWsUp,
} from '../backendHealth.ts';

/**
 * The classifier is the whole product here: it decides whether a user sees a scary banner. Two failure
 * modes are worse than having no banner at all, and both are covered below —
 *   1. CRY WOLF: painting a fault for traffic that is failing BY DESIGN (the pty-cwd poller 404s for
 *      every closed pane, ~every 3s, and the caller swallows it deliberately).
 *   2. FLAPPING: erasing a real fault on the next interleaved successful poll, so the banner appears
 *      and vanishes faster than it can be read.
 */

/** Minimal Response stand-in — only `headers.has`, `status` and `ok` are read by the classifier. */
function res(status: number, opts: { shraga?: boolean } = {}): Response {
  const shraga = opts.shraga !== false;
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { has: (h: string) => shraga && h.toLowerCase() === SHRAGA_VERSION_HEADER },
  } as unknown as Response;
}

const CWD = '/api/sessions/s1/ptys/p1/cwd';

let now = 1_000_000;
const realNow = Date.now;

beforeEach(() => {
  now = 1_000_000;
  Date.now = () => now;
  __resetBackendHealth();
});
afterEach(() => {
  Date.now = realNow;
  __resetBackendHealth();
});

describe('backendHealth — cry-wolf guards', () => {
  test('a by-design 404 the caller expects raises NO fault', () => {
    // Regression: before `expect`, every dead terminal pane painted an amber "Shraga returned 404".
    for (let i = 0; i < 5; i++) reportApiResponse(CWD, res(404), [404]);
    expect(currentFault()).toBeNull();
  });

  test('the SAME 404 raises a fault when the caller does not expect it', () => {
    reportApiResponse('/api/workspace', res(404));
    expect(currentFault()?.kind).toBe('server-error');
  });

  test('401/403 from the real server are the ordinary login flow, not a fault', () => {
    reportApiResponse('/api/config', res(401));
    reportApiResponse('/api/config', res(403));
    expect(currentFault()).toBeNull();
  });

  test('a 5xx still raises a fault', () => {
    reportApiResponse('/api/workspace', res(500));
    expect(currentFault()?.kind).toBe('server-error');
  });
});

describe('backendHealth — wrong backend', () => {
  test('a response WITHOUT the identity header is wrong-backend, even when it is 200', () => {
    reportApiResponse('/api/config', res(200, { shraga: false }));
    expect(currentFault()?.kind).toBe('wrong-backend');
  });

  test('an EXPECTED status from a foreign server is still wrong-backend', () => {
    // The hijacker 404s everything, including the poller's benign path — the header check must win.
    reportApiResponse(CWD, res(404, { shraga: false }), [404]);
    expect(currentFault()?.kind).toBe('wrong-backend');
  });

  test('wrong-backend outranks a concurrent dead socket', () => {
    __resetBackendHealth({ wsGraceMs: 0 }); // raise the socket fault synchronously; grace is covered below
    reportWsDown(1006);
    reportApiResponse('/api/config', res(200, { shraga: false }));
    expect(currentFault()?.kind).toBe('wrong-backend');
  });
});

describe('backendHealth — stability', () => {
  test('a single interleaved successful poll does NOT erase the banner', () => {
    reportApiResponse('/api/config', res(200, { shraga: false }));
    expect(currentFault()?.kind).toBe('wrong-backend');

    now += 100;
    reportApiResponse(CWD, res(200));
    expect(currentFault()?.kind).toBe('wrong-backend'); // would have been null before the fix
  });

  test('recovery needs BOTH a success streak and a minimum dwell', () => {
    reportApiResponse('/api/config', res(200, { shraga: false }));

    // Streak reached, but the banner has been up for milliseconds — too fast to read.
    now += 100;
    for (let i = 0; i < 3; i++) reportApiResponse('/api/workspace', res(200));
    expect(currentFault()?.kind).toBe('wrong-backend');

    // Dwell satisfied AND the streak still standing -> genuine recovery clears it.
    now += 6_000;
    reportApiResponse('/api/workspace', res(200));
    expect(currentFault()).toBeNull();
  });

  test('a fault mid-streak restarts the confirmation', () => {
    reportApiResponse('/api/config', res(200, { shraga: false }));
    now += 6_000;
    reportApiResponse('/api/workspace', res(200));
    reportApiResponse('/api/workspace', res(200));
    reportApiResponse('/api/config', res(200, { shraga: false })); // still broken -> streak resets
    reportApiResponse('/api/workspace', res(200));
    expect(currentFault()?.kind).toBe('wrong-backend');
  });

  test('an expected 404 is neutral — it neither faults nor counts toward recovery', () => {
    reportApiResponse('/api/config', res(200, { shraga: false }));
    now += 6_000;
    for (let i = 0; i < 10; i++) reportApiResponse(CWD, res(404), [404]);
    expect(currentFault()?.kind).toBe('wrong-backend');
  });

  test('HTTP recovery does not erase a still-dead websocket', () => {
    __resetBackendHealth({ wsGraceMs: 0 });
    reportWsDown(1006);
    now += 6_000;
    for (let i = 0; i < 3; i++) reportApiResponse('/api/workspace', res(200));
    expect(currentFault()?.kind).toBe('ws-down');
    reportWsUp();
    expect(currentFault()).toBeNull();
  });
});

/** `reportApiFailure` is the `offline` classifier — the path with no Response to inspect. */
describe('backendHealth — request that never produced a response', () => {
  /** A rejection shaped like what `fetch` actually throws. */
  const abortErr = () => Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });

  test('a CALLER-initiated abort raises NOTHING', () => {
    // Regression: the tab-search palette aborts its in-flight request on EVERY keystroke and on close.
    // Reporting that as a fault painted a red "cannot reach the server" banner for ordinary typing.
    for (let i = 0; i < 5; i++) reportApiFailure('/api/tabs/search?q=ab', abortErr());
    expect(currentFault()).toBeNull();
  });

  test("the helper's OWN timeout is a real fault and is loud", () => {
    reportApiFailure('/api/workspace', abortErr(), { timedOut: true });
    const f = currentFault();
    expect(f?.kind).toBe('offline');
    expect(f?.title).toContain('timed out');
  });

  test('a genuine network error is offline, and says so', () => {
    reportApiFailure('/api/config', new TypeError('Failed to fetch'));
    const f = currentFault();
    expect(f?.kind).toBe('offline');
    expect(f?.title).toContain('Cannot reach');
  });

  test('a caller abort does not erase an already-raised fault', () => {
    reportApiFailure('/api/config', new TypeError('Failed to fetch'));
    reportApiFailure('/api/tabs/search?q=abc', abortErr());
    expect(currentFault()?.kind).toBe('offline');
  });
});

describe('backendHealth — websocket stability', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  test('an ordinary reconnect blip is INVISIBLE', async () => {
    __resetBackendHealth({ wsGraceMs: 40 });
    reportWsDown(1006);
    expect(currentFault()).toBeNull(); // nothing yet — the socket may still recover
    await sleep(10);
    reportWsUp(); // recovered well inside the grace window
    await sleep(60); // ...and the grace deadline passing must not resurrect it
    expect(currentFault()).toBeNull();
  });

  test('a socket that never comes back DOES raise, after the grace window', async () => {
    __resetBackendHealth({ wsGraceMs: 30 });
    reportWsDown(1006);
    await sleep(60);
    expect(currentFault()?.kind).toBe('ws-down');
  });

  test('a flapping socket still raises — repeated closes must not push the deadline out', async () => {
    __resetBackendHealth({ wsGraceMs: 40 });
    for (let i = 0; i < 4; i++) {
      reportWsDown(1006);
      await sleep(15);
    }
    expect(currentFault()?.kind).toBe('ws-down');
  });

  test('a raised ws banner serves a minimum dwell before recovery takes it down', async () => {
    __resetBackendHealth({ wsGraceMs: 0, minDwellMs: 5_000 });
    reportWsDown(1006);
    expect(currentFault()?.kind).toBe('ws-down');

    now += 100;
    reportWsUp(); // too fast to read — the banner stays
    expect(currentFault()?.kind).toBe('ws-down');

    now += 6_000;
    reportWsUp();
    expect(currentFault()).toBeNull();
  });
});
