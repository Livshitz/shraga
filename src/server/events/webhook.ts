// Generic verified-webhook → event bridge.
//
// A vendor webhook can't present shraga auth (it carries the vendor's OWN
// signature), so it can't hit the auth-gated POST /api/events/:source. Instead
// declare it as data: registerWebhook(app, { source, verify }) mounts a PUBLIC
// POST /api/webhooks/<source>, and on a passing `verify` calls emitEvent(source).
//
// The ONLY per-vendor piece is `verify` — dispatch, dedup, and typing are generic.
// The raw request bytes (needed for HMAC) are read from req.rawBody, which the
// global express.json({ verify }) in index.ts stashes for every request.
import type { IRouter, Request, Response } from 'express';
import { emitEvent } from './bus.ts';
import type { PayloadOf } from './types.ts';

export interface WebhookOptions<K extends string> {
  /** Event source name → the bus source + `/api/webhooks/<source>` path. */
  source: K;
  /** Verify the vendor's signature over the RAW body. Return any FALSY value
   *  (false/undefined/null/'') to reject (400). Return `true` to accept
   *  (payload = normalize?.(req) ?? parsed body), or return the payload object
   *  directly. Receives the raw bytes for HMAC. */
  verify: (req: Request, raw: string) => boolean | PayloadOf<K>;
  /** Optional payload shaper when `verify` returns `true` (defaults to req.body). */
  normalize?: (req: Request) => PayloadOf<K>;
  /** Optional dedup id extractor (retried deliveries). Defaults to body.id. */
  eventId?: (payload: PayloadOf<K>, req: Request) => string | undefined;
  /** Override the mount path (default `/api/webhooks/<source>`). */
  path?: string;
}

function rawBodyOf(req: Request): string {
  const buf = (req as unknown as { rawBody?: unknown }).rawBody;
  return buf instanceof Buffer ? buf.toString('utf8') : '';
}

/** Mount a public webhook route that verifies the vendor's signature, then emits a
 *  typed event. Returns the mounted path. */
export function registerWebhook<K extends string>(router: IRouter, opts: WebhookOptions<K>): string {
  const path = opts.path ?? `/api/webhooks/${opts.source}`;
  router.post(path, (req: Request, res: Response) => {
    const raw = rawBodyOf(req);
    let result: boolean | PayloadOf<K>;
    try {
      result = opts.verify(req, raw);
    } catch (err) {
      console.error(`[webhook] verify threw for "${opts.source}":`, err);
      return res.status(400).json({ error: 'verification failed' });
    }
    // Reject on ANY falsy result — a `verify` written as "return the payload, or
    // nothing on failure" yields undefined/null/''/0 on a bad signature; those must
    // NOT fall through and emit an unauthenticated event.
    if (!result) return res.status(400).json({ error: 'bad signature' });

    const payload: PayloadOf<K> = result === true ? (opts.normalize?.(req) ?? (req.body as PayloadOf<K>)) : result;
    const id = opts.eventId
      ? opts.eventId(payload, req)
      : ((payload as { id?: unknown } | null)?.id != null ? String((payload as { id?: unknown }).id) : undefined);

    emitEvent(opts.source, payload, { id });
    res.json({ received: true });
  });
  console.log(`[webhook] mounted POST ${path} → emitEvent("${opts.source}")`);
  return path;
}
