// PushModule — provider-agnostic send: resolve a user's tokens, route to APNs/FCM,
// prune dead tokens. Gated OFF unless PUSH_ENABLED=true AND creds for at least one
// provider are present (zero behavior change otherwise).
import { sendApns, apnsConfigured, apnsTopic, isApnsTokenDead, type PushMessage } from './apns.ts';
import { sendFcm, fcmConfigured, isFcmTokenDead } from './fcm.ts';
import { listForUid, removeToken, touchToken } from './store.ts';

const env = (k: string) => process.env[k] || '';

/** Master gate: feature flag ON + at least one provider configured. */
export function pushEnabled(): boolean {
  if (env('PUSH_ENABLED') !== 'true') return false;
  return apnsConfigured() || fcmConfigured();
}

export class PushModuleOptions {
  /** Senders are injectable so triggers/tests can stub them; defaults hit the real providers. */
  sendApns = sendApns;
  sendFcm = sendFcm;
}

export class PushModule {
  public options: PushModuleOptions;

  public constructor(options?: Partial<PushModuleOptions>) {
    this.options = { ...new PushModuleOptions(), ...options };
  }

  public enabled(): boolean {
    return pushEnabled();
  }

  /** Send a notification to every device a user has registered; prune dead tokens. */
  public async send(uid: string, msg: PushMessage): Promise<void> {
    if (!this.enabled()) return;
    const tokens = listForUid(uid);
    if (!tokens.length) return;
    for (const t of tokens) {
      try {
        if (t.platform === 'apns') {
          const r = await this.options.sendApns(t.token, t.topic || apnsTopic(), msg);
          if (r.status >= 200 && r.status < 300) {
            touchToken(uid, t.token);
          } else if (isApnsTokenDead(r.status, r.reason)) {
            console.warn(`[push] pruning dead apns token for ${uid.slice(0, 8)} (${r.status} ${r.reason})`);
            removeToken(uid, t.token);
          } else {
            console.warn(`[push] apns send failed for ${uid.slice(0, 8)}: ${r.status} ${r.reason}`);
          }
        } else {
          const r = await this.options.sendFcm(t.token, msg);
          if (r.status >= 200 && r.status < 300) {
            touchToken(uid, t.token);
          } else if (isFcmTokenDead(r.status, r.reason)) {
            console.warn(`[push] pruning dead fcm token for ${uid.slice(0, 8)} (${r.status})`);
            removeToken(uid, t.token);
          } else {
            console.warn(`[push] fcm send failed for ${uid.slice(0, 8)}: ${r.status} ${r.reason}`);
          }
        }
      } catch (err) {
        console.error(`[push] send error for ${uid.slice(0, 8)} (${t.platform}):`, err);
      }
    }
  }
}
