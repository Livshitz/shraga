// APNs (iOS) sender — token-based (.p8) auth over HTTP/2.
//
// CRITICAL: this MUST use node:http2, NOT fetch. Bun's fetch returns
// `Malformed_HTTP_Response` against api.push.apple.com and never reaches Apple
// (mocked unit tests still pass — so this path is only trustworthy when verified
// with a LIVE dummy-token probe → expect HTTP 400 BadDeviceToken).
//
// Ported from appwrap/examples/push-relay/src/server.ts; adds a pooled
// ClientHttp2Session and dead-token classification.
import { connect, type ClientHttp2Session } from 'node:http2';
import { createSign } from 'node:crypto';

const env = (k: string) => process.env[k] || '';

export interface PushMessage {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export interface ApnsResult {
  status: number;
  id?: string;
  reason?: string;
}

/** True when APNs credentials are present (independent of PUSH_ENABLED). */
export function apnsConfigured(): boolean {
  return !!(env('APNS_KEY_P8_B64') && env('APNS_KEY_ID') && env('APNS_TEAM_ID'));
}

export function apnsTopic(): string {
  return env('APNS_TOPIC');
}

function apnsHost(): string {
  return env('APNS_ENV') === 'production' ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com';
}

const b64url = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');

// ── ES256 provider JWT (kid=APNS_KEY_ID, iss=APNS_TEAM_ID), cached < 50min ──
let jwtCache: { jwt: string; at: number } | null = null;
function apnsJwt(): string {
  if (jwtCache && Date.now() - jwtCache.at < 50 * 60_000) return jwtCache.jwt;
  const key = Buffer.from(env('APNS_KEY_P8_B64'), 'base64').toString('utf8');
  const iat = Math.floor(Date.now() / 1000);
  const head = b64url({ alg: 'ES256', kid: env('APNS_KEY_ID') });
  const body = b64url({ iss: env('APNS_TEAM_ID'), iat });
  const sig = createSign('SHA256').update(`${head}.${body}`).sign({ key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  jwtCache = { jwt: `${head}.${body}.${sig}`, at: Date.now() };
  return jwtCache.jwt;
}

// ── Pooled HTTP/2 session (one per host, reconnect on close/error) ──
let session: ClientHttp2Session | null = null;
function getSession(): ClientHttp2Session {
  if (session && !session.closed && !session.destroyed) return session;
  const s = connect(apnsHost());
  s.on('error', (e: any) => {
    console.error('[push] apns session error:', e?.message || e);
    if (session === s) session = null;
  });
  s.on('close', () => { if (session === s) session = null; });
  session = s;
  return s;
}

function parseReason(data: string): string | undefined {
  if (!data) return undefined;
  try { return JSON.parse(data).reason; } catch { return data.slice(0, 120); }
}

/** A 410, or BadDeviceToken / Unregistered / DeviceTokenNotForTopic → the token is dead and should be pruned. */
export function isApnsTokenDead(status: number, reason?: string): boolean {
  if (status === 410) return true;
  return reason === 'BadDeviceToken' || reason === 'Unregistered' || reason === 'DeviceTokenNotForTopic';
}

export function sendApns(token: string, topic: string, msg: PushMessage): Promise<ApnsResult> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: ApnsResult) => { if (settled) return; settled = true; resolve(r); };

    let client: ClientHttp2Session;
    try { client = getSession(); } catch (e: any) { return done({ status: 0, reason: String(e?.message || e) }); }

    const payload = JSON.stringify({ aps: { alert: { title: msg.title, body: msg.body }, sound: 'default' }, ...(msg.data || {}) });
    let req;
    try {
      req = client.request({
        ':method': 'POST',
        ':path': `/3/device/${token}`,
        authorization: `bearer ${apnsJwt()}`,
        'apns-topic': topic,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'content-type': 'application/json',
      });
    } catch (e: any) {
      session = null;
      return done({ status: 0, reason: String(e?.message || e) });
    }

    let status = 0, id: string | undefined, data = '';
    req.on('response', (h: any) => { status = h[':status']; id = h['apns-id']; });
    req.on('data', (c: Buffer) => (data += c));
    // Resolve at `end` so a non-200 surfaces APNs's `reason` (e.g. BadDeviceToken) instead of losing it.
    req.on('end', () => done({ status, id, reason: parseReason(data) }));
    req.on('error', (e: any) => { session = null; done({ status: 0, reason: String(e?.message || e) }); });
    req.end(payload);
  });
}
