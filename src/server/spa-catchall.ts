import path from 'path';
import { existsSync } from 'fs';
import type express from 'express';
import { getSpaShell } from './spa-shell.ts';

// Non-page prefixes that must fall through to a real 404 (JSON/API/transport), never the SPA shell.
function isNonPagePath(p: string): boolean {
  return p.startsWith('/api/') || p.startsWith('/mcp') || p.startsWith('/uploads') ||
    p.startsWith('/internal/') || p.startsWith('/.well-known');
}

/**
 * Register the SPA catch-all (`app.get('*')`) as the LAST GET route so it serves the built
 * index.html for client routes/deep links (/oauth/authorize, /cli-auth, /session/x, …) while
 * letting unmatched API/MCP/upload/internal/oauth-metadata paths fall through to a real 404.
 *
 * Idempotent + re-placeable: each call splices out any prior catch-all layer, so it can be called
 * again after a later mountFeatures() (passive→active promotion) and still sit behind those routes.
 * In dev (no built dist) it is a no-op — Vite serves the SPA and a catch-all would 404-shadow it.
 *
 * EXPRESS 4 COUPLING: uses the bare `app.get('*')` route and Express's private `_router.stack`.
 * A future express@5 bump breaks this LOUDLY (path-to-regexp v8 rejects `'*'`), not silently —
 * re-verify the promotion-path ordering if express is ever upgraded.
 */
export function registerSpaCatchAll(app: express.Express, distPath: string): void {
  if (!existsSync(distPath)) return;
  const indexHtml = path.join(distPath, 'index.html');
  // For app.get(), the layer's `handle` is the Route's dispatcher — our tagged handler lives inside
  // `layer.route.stack[*].handle`. Match on that so re-registration removes the stale catch-all.
  const stack = (app as any)._router?.stack as Array<{ route?: { stack?: Array<{ handle?: { __spaCatchAll?: boolean } }> } }> | undefined;
  if (stack) {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i]?.route?.stack?.some((h) => h?.handle?.__spaCatchAll)) stack.splice(i, 1);
    }
  }
  const handler: express.RequestHandler = (req, res, next) => {
    if (isNonPagePath(req.path)) return next();
    // Serve the shell with the runtime web-config injected (cached). This is the SINGLE HTML-page
    // path — `/` falls through here too (express.static is mounted with `index: false`).
    res.type('html').send(getSpaShell(indexHtml));
  };
  (handler as { __spaCatchAll?: boolean }).__spaCatchAll = true;
  app.get('*', handler);
}
