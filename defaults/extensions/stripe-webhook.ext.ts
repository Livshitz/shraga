// Example: a vendor webhook → event-trigger bridge, via the generic helper.
//
// A vendor (Stripe here) can't send shraga auth, so its webhook can't hit the
// generic POST /api/events/:source endpoint. Instead this extension declares a
// webhook as DATA: ctx.registerWebhook({ source, verify }) mounts a PUBLIC route
// that verifies the vendor's OWN signature and, on success, emits the event —
// firing any enabled schedule with trigger { kind:'event', source:'stripe' }.
//
// The ONLY per-vendor code is `verify`. Dispatch, dedup (by event id), the route,
// and typing are all generic (src/server/events/webhook.ts).
//
// Pair it with a schedule (see the scheduler skill):
//   { "trigger": { "kind":"event", "source":"stripe", "match":{ "type":"invoice.paid" } },
//     "task": { "kind":"prompt", "prompt":"An invoice was paid — thank the customer." } }
//
// DORMANT until STRIPE_WEBHOOK_SECRET is set — no route is registered without it,
// so this ships harmlessly enabled. Swap the verifier for any vendor's scheme.
import type { Express, Request } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';

// Minimal local shape of the loader's ctx (see src/server/extensions.ts).
interface WebhookOptions {
  source: string;
  verify: (req: Request, raw: string) => boolean | unknown;
  normalize?: (req: Request) => unknown;
  eventId?: (payload: unknown, req: Request) => string | undefined;
  path?: string;
}
interface ExtensionContext {
  dataPath: (p: string) => string;
  requireAuth: any;
  log: (...a: unknown[]) => void;
  app: Express;
  emitEvent: (source: string, payload: unknown, opts?: { id?: string }) => void;
  registerWebhook: (opts: WebhookOptions) => string;
}

/** Minimal Stripe `Stripe-Signature` verification (t=…,v1=…) over the raw body. */
function verifyStripeSig(raw: string, header: string, secret: string): boolean {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')) as [string, string][]);
  const t = parts.t, v1 = parts.v1;
  if (!t || !v1) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
  try { return timingSafeEqual(Buffer.from(expected), Buffer.from(v1)); } catch { return false; }
}

export default function register(_app: Express, ctx: ExtensionContext) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    ctx.log('stripe-webhook extension dormant (set STRIPE_WEBHOOK_SECRET to enable)');
    return;
  }

  // Stripe authenticates via its own signature, not shraga auth. The raw request
  // bytes are read from req.rawBody (stashed by the global express.json in index.ts);
  // `verify` returns true iff the signature matches. Payload = the parsed body, and
  // its `id` dedupes Stripe's retries — both handled generically by registerWebhook.
  const path = ctx.registerWebhook({
    source: 'stripe',
    // Keep the original public path (Stripe's dashboard points at /webhooks/stripe).
    path: '/webhooks/stripe',
    verify: (req, raw) => verifyStripeSig(raw, String(req.headers['stripe-signature'] ?? ''), secret),
  });

  ctx.log(`stripe-webhook extension ready — POST ${path} → emitEvent("stripe")`);
}
