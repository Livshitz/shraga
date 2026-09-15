// Server-side subscription gate + upstream cache. Uses a REAL local HTTP server as "upstream" and
// REAL credential files on disk, so the assertions are about the module's behaviour end to end and
// not about a mock's shape. Every test counts actual upstream requests.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ClaudeUsageReader, claudeUsage, claudeUsageFor } from '../claude-usage.ts';

// Captured verbatim from a live 200 (api.anthropic.com/api/oauth/usage) on a Max box.
const BODY = {
  limits: [
    { kind: 'session', group: 'session', percent: 5, severity: 'normal', resets_at: '2026-08-27T20:50:00.087873+00:00', is_active: true },
    { kind: 'weekly_all', group: 'weekly', percent: 0, severity: 'normal', resets_at: '2026-09-01T21:00:00.087899+00:00', is_active: false },
  ],
};

let server: ReturnType<typeof Bun.serve>;
let endpoint = '';
let hits = 0;
let status = 200;
let payload: unknown = BODY;
let delayMs = 0;
let retryAfter: string | null = null;
let dir = '';

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    async fetch() {
      hits++;
      if (delayMs) await Bun.sleep(delayMs);
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (retryAfter) headers['retry-after'] = retryAfter;
      return new Response(JSON.stringify(payload), { status, headers });
    },
  });
  endpoint = `http://127.0.0.1:${server.port}/usage`;
  dir = await mkdtemp(path.join(tmpdir(), 'claude-usage-'));
});
afterAll(async () => { server.stop(true); await rm(dir, { recursive: true, force: true }); });
afterEach(() => { hits = 0; status = 200; payload = BODY; delayMs = 0; retryAfter = null; });

/** Write a credentials file and return a reader pointed at it + the fake upstream. */
async function reader(creds: unknown, name = `c${Math.random().toString(36).slice(2)}.json`) {
  const p = path.join(dir, name);
  await writeFile(p, typeof creds === 'string' ? creds : JSON.stringify(creds));
  // No keychain seam is ever the real `security` binary in this suite.
  return new ClaudeUsageReader({ credentialsPath: p, endpoint, cachePath: CACHE(), readKeychain: NEVER_KEYCHAIN });
}

const MISSING = () => path.join(dir, 'does-not-exist.json');
/** A private mirror file per reader: the suite must never read or write the real DATA_DIR one. */
const CACHE = () => path.join(dir, `cache-${Math.random().toString(36).slice(2)}.json`);
/** Poll a condition to a hard deadline — for state a best-effort background write produces. */
async function until(cond: () => boolean | Promise<boolean>, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the condition');
    await Bun.sleep(2);
  }
}
const NEVER_KEYCHAIN = async () => { throw new Error('keychain must not be consulted here'); };

const OK_CREDS = { claudeAiOauth: { accessToken: 'tok', scopes: ['user:inference', 'user:profile'], subscriptionType: 'max' } };

describe('subscription gate', () => {
  it('reads usage when the token carries user:profile', async () => {
    const r = await reader(OK_CREDS);
    const u = await r.get();
    expect(u?.subscriptionType).toBe('max');
    expect(u?.limits.map(l => l.kind)).toEqual(['session', 'weekly_all']);
    expect(hits).toBe(1);
  });

  it('makes ZERO upstream calls when the token lacks user:profile', async () => {
    const r = await reader({ claudeAiOauth: { accessToken: 'tok', scopes: ['user:inference'], subscriptionType: 'max' } });
    expect(await r.get()).toBeNull();
    expect(hits).toBe(0); // the gate is the point: no token, no request
  });

  it('makes ZERO upstream calls when scopes are missing entirely', async () => {
    const r = await reader({ claudeAiOauth: { accessToken: 'tok' } });
    expect(await r.get()).toBeNull();
    expect(hits).toBe(0);
  });

  it('makes ZERO upstream calls when there is no credentials file (API-key deployment)', async () => {
    const r = new ClaudeUsageReader({ credentialsPath: MISSING(), endpoint, platform: 'linux', cachePath: CACHE(), readKeychain: NEVER_KEYCHAIN });
    expect(await r.get()).toBeNull();
    expect(hits).toBe(0);
  });

  it('makes ZERO upstream calls on a malformed credentials file', async () => {
    const r = await reader('{ not json');
    expect(await r.get()).toBeNull();
    expect(hits).toBe(0);
  });

  it('makes ZERO upstream calls when claudeAiOauth has no accessToken', async () => {
    const r = await reader({ claudeAiOauth: { scopes: ['user:profile'] } });
    expect(await r.get()).toBeNull();
    expect(hits).toBe(0);
  });
});

describe('upstream failure is fail-closed', () => {
  it('returns null on a non-200 (403 = API-key-ish token)', async () => {
    status = 403;
    const r = await reader(OK_CREDS);
    expect(await r.get()).toBeNull();
    expect(hits).toBe(1);
  });

  it('returns null when the 200 body carries no limits[]', async () => {
    payload = { limits: [] };
    const r = await reader(OK_CREDS);
    expect(await r.get()).toBeNull();
  });

  it('drops limit entries with a non-numeric percent', async () => {
    payload = { limits: [{ kind: 'session', percent: 'lots' }, BODY.limits[0]] };
    const r = await reader(OK_CREDS);
    expect((await r.get())?.limits).toHaveLength(1);
  });
});

describe('last known-good reading survives a failure', () => {
  /** Reader over a real creds file with a short TTL, so a second get() actually re-fetches. */
  async function shortTtl() {
    const p = path.join(dir, `lg${Math.random().toString(36).slice(2)}.json`);
    await writeFile(p, JSON.stringify(OK_CREDS));
    return new ClaudeUsageReader({ credentialsPath: p, endpoint, ttlMs: 1, cachePath: CACHE(), readKeychain: NEVER_KEYCHAIN });
  }

  it('stamps a fresh reading with fetchedAt and no stale flag', async () => {
    const u = await (await shortTtl()).get();
    expect(u?.stale).toBeUndefined();
    expect(Number.isNaN(Date.parse(u!.fetchedAt))).toBe(false);
  });

  it('keeps serving the last good numbers, flagged stale, after a 500', async () => {
    const r = await shortTtl();
    const first = await r.get();
    await Bun.sleep(5);
    status = 500;
    const second = await r.get();
    expect(second?.limits).toEqual(first!.limits);
    expect(second?.stale).toBe(true);
    expect(second?.fetchedAt).toBe(first!.fetchedAt); // the AGE is the point — not re-stamped
  });

  it('keeps serving the last good numbers while in 429 cooldown, without touching upstream', async () => {
    const r = await shortTtl();
    await r.get();
    await Bun.sleep(5);
    status = 429;
    expect((await r.get())?.stale).toBe(true);
    const afterCooldown = hits;
    expect((await r.get())?.stale).toBe(true);
    expect(hits).toBe(afterCooldown); // cooldown short-circuits before any request
  });

  it('survives a restart: a new reader serves the previous process\'s reading while upstream is down', async () => {
    const shared = CACHE();
    const creds = path.join(dir, `restart-${Math.random().toString(36).slice(2)}.json`);
    await writeFile(creds, JSON.stringify(OK_CREDS));
    const first = await new ClaudeUsageReader({ credentialsPath: creds, endpoint, cachePath: shared, readKeychain: NEVER_KEYCHAIN }).get();
    // The mirror is written fire-and-forget so a disk stall can never delay a client poll — which
    // means get() can resolve BEFORE the file exists. A restart is only observable once it does.
    await until(() => Bun.file(shared).exists());

    status = 500; // the box comes back up into a rate-limited / failing upstream
    const afterRestart = await new ClaudeUsageReader({ credentialsPath: creds, endpoint, cachePath: shared, readKeychain: NEVER_KEYCHAIN }).get();
    expect(afterRestart?.limits).toEqual(first!.limits);
    expect(afterRestart?.stale).toBe(true);
    expect(afterRestart?.fetchedAt).toBe(first!.fetchedAt);
  });

  it('says WHY it is stale: a 429 carries the reason and when it will retry', async () => {
    const r = await shortTtl();
    await r.get();
    await Bun.sleep(5);
    status = 429; retryAfter = '3600'; payload = { error: { type: 'rate_limit_error', message: 'Rate limited. Please try again later.' } };
    const u = await r.get();
    expect(u?.stale).toBe(true);
    expect(u?.error).toContain('429');
    expect(u?.error).toContain('Rate limited');
    expect(Date.parse(u!.retryAt!) - Date.now()).toBeGreaterThan(3_500_000);
  });

  it('a success clears the recorded failure', async () => {
    const r = await shortTtl();
    status = 500;
    await r.get();
    status = 200;
    await Bun.sleep(5);
    const u = await r.get();
    expect(u?.stale).toBeUndefined();
    expect(u?.error).toBeUndefined();
  });

  it('makes ZERO upstream calls with an expired token, and says so on the stale reading', async () => {
    const p = path.join(dir, `exp${Math.random().toString(36).slice(2)}.json`);
    await writeFile(p, JSON.stringify(OK_CREDS));
    const r = new ClaudeUsageReader({ credentialsPath: p, endpoint, ttlMs: 1, cachePath: CACHE(), readKeychain: NEVER_KEYCHAIN });
    await r.get();
    await writeFile(p, JSON.stringify({ claudeAiOauth: { ...OK_CREDS.claudeAiOauth, expiresAt: Date.now() - 1000 } }));
    await Bun.sleep(5);
    const before = hits;
    const u = await r.get();
    expect(hits).toBe(before);
    expect(u?.stale).toBe(true);
    expect(u?.error).toContain('expired');
  });

  it('still answers null when there was never a good reading', async () => {
    status = 500;
    const r = await shortTtl();
    expect(await r.get()).toBeNull();
  });
});

describe('agent-reported rate limits (SDK rate_limit_event)', () => {
  const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;

  it('paints a rejected window at 100% over a days-old endpoint reading, with zero extra calls', async () => {
    const r = await reader(OK_CREDS);
    await r.get();
    r.observeRateLimit({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: inAnHour() });
    const u = await r.get();
    const session = u?.limits.find(l => l.kind === 'session');
    expect(session?.percent).toBe(100);
    expect(session?.severity).toBe('exceeded');
    expect(u?.limits.find(l => l.kind === 'weekly_all')?.percent).toBe(0); // other rows untouched
    expect(hits).toBe(1);
  });

  it('adds a row for an exhausted window the endpoint did not report', async () => {
    const r = await reader(OK_CREDS);
    r.observeRateLimit({ status: 'rejected', rateLimitType: 'seven_day_opus', resetsAt: inAnHour() });
    const opus = (await r.get())?.limits.find(l => l.scopeLabel === 'Opus');
    expect(opus?.percent).toBe(100);
  });

  it('an allowed event, or the reset passing, clears the mark', async () => {
    const r = await reader(OK_CREDS);
    r.observeRateLimit({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: inAnHour() });
    r.observeRateLimit({ status: 'allowed', rateLimitType: 'five_hour', resetsAt: inAnHour() });
    expect((await r.get())?.limits.find(l => l.kind === 'session')?.percent).toBe(5);
    r.observeRateLimit({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: Math.floor(Date.now() / 1000) - 1 });
    expect((await r.get())?.limits.find(l => l.kind === 'session')?.percent).toBe(5);
  });

  it('never conjures a gauge for a box with no reading', async () => {
    const r = await reader({ claudeAiOauth: { accessToken: 'tok', scopes: ['user:inference'] } });
    r.observeRateLimit({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: inAnHour() });
    expect(await r.get()).toBeNull();
  });
});

describe('cache + in-flight dedupe', () => {
  it('collapses a concurrent stampede into ONE upstream call', async () => {
    delayMs = 25; // hold every caller inside fetchUsage at once
    const r = await reader(OK_CREDS);
    const all = await Promise.all(Array.from({ length: 20 }, () => r.get()));
    expect(hits).toBe(1);
    expect(all.every(u => u?.subscriptionType === 'max')).toBe(true);
  });

  it('serves later calls from the cache within the TTL', async () => {
    const r = await reader(OK_CREDS);
    await r.get(); await r.get(); await r.get();
    expect(hits).toBe(1);
  });

  it('caches a FAILURE too — a 403 box must not re-hit upstream on every client poll', async () => {
    status = 403;
    const r = await reader(OK_CREDS);
    expect(await r.get()).toBeNull();
    expect(await r.get()).toBeNull();
    expect(hits).toBe(1);
  });

  it('re-fetches once the TTL has expired', async () => {
    const r = await reader(OK_CREDS);
    r.options.ttlMs = 1;
    await r.get();
    await Bun.sleep(10);
    await r.get();
    expect(hits).toBe(2);
  });

  // A 429 is the one failure that must NOT be retried on the ordinary TTL: doing so is what pinned a
  // prod box to 25 straight 429s in a day. It gets its own escalating cooldown instead.
  it('backs off past the TTL after a 429, and escalates on each consecutive one', async () => {
    status = 429;
    const r = await reader(OK_CREDS);
    r.options.ttlMs = 1;
    r.options.rateLimitBackoffMs = [50, 10_000];

    expect(await r.get()).toBeNull();
    await Bun.sleep(10); // TTL expired, cooldown has not
    expect(await r.get()).toBeNull();
    expect(hits).toBe(1);

    await Bun.sleep(50); // first rung elapsed -> one more probe, which climbs to the second rung
    expect(await r.get()).toBeNull();
    expect(hits).toBe(2);
    await Bun.sleep(60);
    expect(await r.get()).toBeNull();
    expect(hits).toBe(2);
  });

  it('honours a longer Retry-After, and a success resets the ladder', async () => {
    const r = await reader(OK_CREDS);
    r.options.ttlMs = 1;
    r.options.rateLimitBackoffMs = [10];

    status = 429; retryAfter = '1'; // 1s beats the 10ms rung
    expect(await r.get()).toBeNull();
    await Bun.sleep(30);
    expect(await r.get()).toBeNull();
    expect(hits).toBe(1);
  });

  it('does not wedge: a failed in-flight call is cleared, the next TTL window fetches again', async () => {
    status = 500;
    const r = await reader(OK_CREDS);
    r.options.ttlMs = 1;
    await Promise.all([r.get(), r.get()]);
    expect(hits).toBe(1);
    await Bun.sleep(10);
    status = 200;
    expect((await r.get())?.subscriptionType).toBe('max');
    expect(hits).toBe(2);
  });
});

// macOS keeps Claude Code's OAuth credentials in the login Keychain and writes NO credentials file,
// so on darwin an absent file is not proof of an API-key deployment.
describe('macOS keychain fallback', () => {
  const KC = (secret: unknown) => async () => (typeof secret === 'string' || secret === null ? secret : JSON.stringify(secret));
  const darwin = (readKeychain: any, credentialsPath = MISSING()) =>
    new ClaudeUsageReader({ credentialsPath, endpoint, platform: 'darwin', cachePath: CACHE(), readKeychain });

  it('reads usage from the keychain when the credentials file is absent', async () => {
    const u = await darwin(KC(OK_CREDS)).get();
    expect(u?.subscriptionType).toBe('max');
    expect(u?.limits.map(l => l.kind)).toEqual(['session', 'weekly_all']);
    expect(hits).toBe(1);
  });

  it('never consults the keychain on linux — the file is the only source there', async () => {
    let consulted = false;
    const r = new ClaudeUsageReader({
      credentialsPath: MISSING(), cachePath: CACHE(), endpoint, platform: 'linux',
      readKeychain: async () => { consulted = true; return JSON.stringify(OK_CREDS); },
    });
    expect(await r.get()).toBeNull();
    expect(consulted).toBe(false);
    expect(hits).toBe(0);
  });

  it('prefers the file: a present, valid file means the keychain is never consulted', async () => {
    const p = path.join(dir, 'prefer.json');
    await writeFile(p, JSON.stringify(OK_CREDS));
    let consulted = false;
    const r = darwin(async () => { consulted = true; return null; }, p);
    expect((await r.get())?.subscriptionType).toBe('max');
    expect(consulted).toBe(false);
  });

  it('applies the SAME user:profile gate to a keychain token — zero upstream calls', async () => {
    const r = darwin(KC({ claudeAiOauth: { accessToken: 'tok', scopes: ['user:inference'], subscriptionType: 'max' } }));
    expect(await r.get()).toBeNull();
    expect(hits).toBe(0);
  });

  it.each([
    ['an empty read (locked keychain / missing binary / no such item)', KC(null)],
    ['whitespace-only output', KC('   \n ')],
    ['unparseable JSON', KC('{ not json')],
    ['a keychain payload with no claudeAiOauth', KC({ other: 1 })],
    ['a reader that rejects (spawn failure / timeout)', async () => { throw new Error('timed out'); }],
  ])('fails closed on %s', async (_label, readKeychain) => {
    const r = darwin(readKeychain);
    expect(await r.get()).toBeNull();
    expect(hits).toBe(0);
  });

  it('re-reads the keychain every poll — a rotated token is never served from a field', async () => {
    let n = 0;
    const r = darwin(async () => { n++; return JSON.stringify(OK_CREDS); });
    r.options.ttlMs = 1;
    await r.get();
    await Bun.sleep(10);
    await r.get();
    expect(n).toBe(2);
    expect(hits).toBe(2);
  });
});

describe('claudeUsageFor (per-viewer accounts)', () => {
  it('null → the box default singleton', () => {
    expect(claudeUsageFor(null)).toBe(claudeUsage);
  });

  it('a routed dir → its own reader on that dir\'s files, cached per dir, never the keychain', async () => {
    const a = path.join(dir, 'users', 'c-a', '.claude');
    const ra = claudeUsageFor(a);
    expect(ra).not.toBe(claudeUsage);
    expect(claudeUsageFor(a)).toBe(ra);
    expect(claudeUsageFor(path.join(dir, 'users', 'c-b', '.claude'))).not.toBe(ra);
    expect(ra.options).toMatchObject({
      credentialsPath: path.join(a, '.credentials.json'),
      accountPath: path.join(a, '.claude.json'),
      cachePath: path.join(a, 'shraga-usage-last.json'),
    });
    expect(await ra.options.readKeychain(ra.options)).toBeNull();
  });

  it('reads the routed account end to end and keeps its own rate-limit state', async () => {
    const a = path.join(dir, 'users', 'c-e2e', '.claude');
    await mkdir(a, { recursive: true });
    await writeFile(path.join(a, '.credentials.json'), JSON.stringify(OK_CREDS));
    await writeFile(path.join(a, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'routed@example.com' } }));
    const ra = claudeUsageFor(a);
    ra.options.endpoint = endpoint;
    ra.options.platform = 'darwin'; // the keychain seam would be reachable on a Mac — it must answer null
    expect((await ra.get())?.account).toBe('routed@example.com');
    ra.observeRateLimit({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: Math.floor(Date.now() / 1000) + 3600 });
    expect((await ra.get())?.limits.find(l => l.kind === 'session')?.percent).toBe(100);
    expect(hits).toBe(1);
    const other = claudeUsageFor(path.join(dir, 'users', 'c-none', '.claude'));
    other.options.endpoint = endpoint;
    expect(await other.get()).toBeNull(); // no files → no gauge, and no borrowing another login
    expect(hits).toBe(1);
  });
});
