// Server-side subscription gate + upstream cache. Uses a REAL local HTTP server as "upstream" and
// REAL credential files on disk, so the assertions are about the module's behaviour end to end and
// not about a mock's shape. Every test counts actual upstream requests.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ClaudeUsageReader } from '../claude-usage.ts';

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
let dir = '';

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    async fetch() {
      hits++;
      if (delayMs) await Bun.sleep(delayMs);
      return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
    },
  });
  endpoint = `http://127.0.0.1:${server.port}/usage`;
  dir = await mkdtemp(path.join(tmpdir(), 'claude-usage-'));
});
afterAll(async () => { server.stop(true); await rm(dir, { recursive: true, force: true }); });
afterEach(() => { hits = 0; status = 200; payload = BODY; delayMs = 0; });

/** Write a credentials file and return a reader pointed at it + the fake upstream. */
async function reader(creds: unknown, name = `c${Math.random().toString(36).slice(2)}.json`) {
  const p = path.join(dir, name);
  await writeFile(p, typeof creds === 'string' ? creds : JSON.stringify(creds));
  return new ClaudeUsageReader({ credentialsPath: p, endpoint });
}

const OK_CREDS = { claudeAiOauth: { accessToken: 'tok', scopes: ['user:inference', 'user:profile'], subscriptionType: 'max' } };

describe('subscription gate', () => {
  it('reads usage when the token carries user:profile', async () => {
    const r = await reader(OK_CREDS);
    const u = await r.get();
    expect(u?.subscriptionType).toBe('max');
    expect(u?.limits.map(l => l.kind)).toEqual(['session', 'weekly_all']);
    expect(u?.limits[0].isActive).toBe(true);
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
    const r = new ClaudeUsageReader({ credentialsPath: path.join(dir, 'does-not-exist.json'), endpoint });
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
