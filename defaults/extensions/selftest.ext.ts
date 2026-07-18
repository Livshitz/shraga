// Server-extension self-test + canonical example.
//
// Ships ENABLED on every shraga as both:
//   (a) a copy-paste example of the extension contract, and
//   (b) a regression harness for the two failure modes that have bitten this
//       codebase — routes silently swallowed by the SPA catch-all, and
//       browser-navigated routes wrongly gated by bearer-only auth.
//
// Regression smoke test (works without a restart — drop/edit a file, then curl):
//   curl -s https://<host>/api/extensions/selftest
//        → {"ok":true,...}                         (JSON, NOT the SPA HTML)
//   curl -s -o /dev/null -w '%{http_code}' https://<host>/api/extensions/selftest/whoami
//        → 401                                     (auth ran; NOT a 200 SPA fallthrough)
//   curl -s -H "Authorization: Bearer <token>" https://<host>/api/extensions/selftest/whoami
//        → {"ok":true,"user":{...}}
//
// If the public route returns `<!doctype html> … Shraga`, the loader/route-order
// regressed (the route landed after app.get('*')). If /whoami returns that HTML
// instead of 401, requireAuth isn't running (also a route-order regression).
import type { Express, Request, Response } from 'express';

// Minimal local shape of the loader's ctx (see src/server/extensions.ts).
interface ExtensionContext {
  dataPath: (p: string) => string;
  requireAuth: any;
  log: (...a: unknown[]) => void;
  app: Express;
}

export default function register(app: Express, ctx: ExtensionContext) {
  // PUBLIC route — proves the extension Router is mounted BEFORE the SPA catch-all.
  app.get('/api/extensions/selftest', (_req: Request, res: Response) => {
    res.json({ ok: true, ext: 'selftest', mountedBeforeCatchAll: true, ts: Date.now() });
  });

  // AUTH-GATED route — proves ctx.requireAuth runs (401 without a token, not SPA
  // HTML) and echoes the caller's own identity when authenticated.
  app.get('/api/extensions/selftest/whoami', ctx.requireAuth, (req: Request, res: Response) => {
    res.json({ ok: true, user: (req as any).user ?? null, ts: Date.now() });
  });

  ctx.log('selftest extension ready — GET /api/extensions/selftest');
}
