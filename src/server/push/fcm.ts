// FCM (Android) sender — HTTP v1 with a Google service-account OAuth token.
// HTTP only, no firebase-admin SDK (house rule). Same SA → OAuth pattern as
// mcp-firebase / mcp-google-drive. Ported from appwrap/examples/push-relay.
import { createSign } from 'node:crypto';
import type { PushMessage } from './apns.ts';

const env = (k: string) => process.env[k] || '';

export interface FcmResult {
  status: number;
  reason?: string;
}

interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id?: string;
}

function loadServiceAccount(): ServiceAccount | null {
  const raw = env('FCM_SERVICE_ACCOUNT_JSON')
    || (env('FCM_SERVICE_ACCOUNT_B64') ? Buffer.from(env('FCM_SERVICE_ACCOUNT_B64'), 'base64').toString('utf8') : '');
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ServiceAccount;
  } catch (err) {
    console.error('[push] FCM service account parse failed:', err);
    return null;
  }
}

/** True when FCM credentials are present (independent of PUSH_ENABLED). */
export function fcmConfigured(): boolean {
  return !!loadServiceAccount();
}

function projectId(sa: ServiceAccount): string {
  return env('FCM_PROJECT_ID') || sa.project_id || '';
}

const b64url = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');

// ── OAuth access token from the SA JWT (RS256), cached < 50min ──
let tokCache: { tok: string; at: number } | null = null;
async function accessToken(sa: ServiceAccount): Promise<string | null> {
  if (tokCache && Date.now() - tokCache.at < 50 * 60_000) return tokCache.tok;
  const iat = Math.floor(Date.now() / 1000);
  const head = b64url({ alg: 'RS256', typ: 'JWT' });
  const claim = b64url({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat,
    exp: iat + 3600,
  });
  const sig = createSign('RSA-SHA256').update(`${head}.${claim}`).sign(sa.private_key).toString('base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${head}.${claim}.${sig}`,
  }).catch((err) => { console.error('[push] FCM oauth fetch failed:', err); return null; });
  if (!res || !res.ok) {
    if (res) console.error('[push] FCM oauth rejected:', res.status, (await res.text()).slice(0, 200));
    return null;
  }
  const j = (await res.json()) as { access_token?: string };
  if (!j.access_token) return null;
  tokCache = { tok: j.access_token, at: Date.now() };
  return j.access_token;
}

// FCM data fields must be string→string.
function stringifyData(data?: Record<string, unknown>): Record<string, string> | undefined {
  if (!data) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) out[k] = typeof v === 'string' ? v : JSON.stringify(v);
  return out;
}

/** 404 (NOT_FOUND) or an UNREGISTERED error → the token is dead and should be pruned. */
export function isFcmTokenDead(status: number, reason?: string): boolean {
  if (status === 404) return true;
  return !!reason && /UNREGISTERED|registration-token-not-registered/i.test(reason);
}

export async function sendFcm(token: string, msg: PushMessage): Promise<FcmResult> {
  const sa = loadServiceAccount();
  if (!sa) return { status: 0, reason: 'no_service_account' };
  const pid = projectId(sa);
  if (!pid) return { status: 0, reason: 'no_project_id' };
  const at = await accessToken(sa);
  if (!at) return { status: 0, reason: 'no_access_token' };

  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${pid}/messages:send`, {
    method: 'POST',
    headers: { authorization: `Bearer ${at}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      message: {
        token,
        notification: { title: msg.title, body: msg.body },
        ...(msg.data ? { data: stringifyData(msg.data) } : {}),
      },
    }),
  }).catch((err) => { console.error('[push] FCM send fetch failed:', err); return null; });

  if (!res) return { status: 0, reason: 'fetch_failed' };
  return { status: res.status, reason: res.ok ? undefined : (await res.text()).slice(0, 200) };
}
