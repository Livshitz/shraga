// Generic inbound event endpoint: POST /api/events/:source
//
// For trusted callers that can present shraga auth (API key `uck_…`, bearer, or the
// internal token). The body becomes the event payload; an optional `X-Event-Id`
// header dedupes retries. Vendor webhooks that can't send shraga auth (Stripe,
// GitHub, …) should instead live in a data-side extension that verifies the
// vendor's own signature and calls ctx.emitEvent() server-side.
import type { Express, RequestHandler } from 'express';
import { emitEvent } from './bus.ts';

export function registerEventRoutes(app: Express, requireAuth: RequestHandler): void {
  app.post('/api/events/:source', requireAuth, (req, res) => {
    const source = String(req.params.source || '').trim();
    if (!source) return res.status(400).json({ error: 'Missing source' });
    const id = typeof req.headers['x-event-id'] === 'string' ? req.headers['x-event-id'] : undefined;
    const evt = emitEvent(source, req.body ?? {}, { id });
    res.json({ ok: true, source, at: evt.at });
  });
}
