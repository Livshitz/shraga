// Server feature seam — the drop-in point for optional add-ons.
//
// The core mounts only the seam; it registers NOTHING here. An optional add-on (a downstream
// distribution or a private module) imports this and calls registerFeature({...}) for each
// add-on surface BEFORE the server starts, then those get
// mounted at the one `mountFeatures()` call in index.ts. This keeps add-on code entirely out of
// the core tree while giving it a clean, typed way in.
//
// Deeper than the data-side `*.ext.ts` extensions (which are just routes): a feature gets the
// live app + broadcast + auth so it can wire websockets, background workers, recovery, etc.

import type { Express, RequestHandler } from 'express';

export interface FeatureContext {
  app: Express;
  requireAuth: RequestHandler;
  /** Push a server event to all connected clients (same fn the core uses). */
  broadcast: (event: object) => void;
  /** True in passive/standby mode — features should skip background writers/consumers. */
  passive: boolean;
}

export interface ServerFeature {
  readonly name: string;
  /** Mount routes/handlers/consumers. Throwing is contained (logged, other features still load). */
  register(ctx: FeatureContext): void;
  /** Optional: resume an interrupted session for this feature's channel (called by recovery). */
  resumeSession?(session: unknown, prompt: string): Promise<void> | void;
  /**
   * Optional: client-facing capability flags this feature contributes to `/api/features`.
   * A static map or a getter (evaluated per request, so it can honor env). Merged OVER the core
   * flags. This is how an add-on surface turns itself on WITHOUT the core naming it — the core
   * declares none; an add-on's feature declares its own flag (e.g. `{ someSurface: true }`).
   */
  readonly flags?: Record<string, boolean> | (() => Record<string, boolean>);
  /**
   * Optional: sidecar WebSocket proxy routes this feature contributes (url-prefix → localhost port).
   * Merged into the core WS proxy table so a feature's daemon socket is reachable WITHOUT the core
   * naming the prefix. Same generic bridge as `flags`.
   */
  readonly sidecarRoutes?: Record<string, number>;
  /**
   * Optional: MCP server names that must ALWAYS be handed to an engine which narrows its MCP set for
   * speed (rather than only when the prompt happens to mention them). A feature that depends on one
   * of its own MCP servers declares it here, so the core never has to name it. Static or a getter
   * (evaluated per call, so it can honor env) — same shape as `flags`.
   */
  readonly alwaysMcp?: string[] | (() => string[]);
}

const registry: ServerFeature[] = [];

/** Register an add-on feature. Called by an optional add-on before startup. Idempotent by name. */
export function registerFeature(feature: ServerFeature): void {
  if (registry.some((f) => f.name === feature.name)) return;
  registry.push(feature);
}

/** Mount all registered features. The single seam call in index.ts. */
export function mountFeatures(ctx: FeatureContext): void {
  for (const f of registry) {
    try {
      f.register(ctx);
      console.log(`[features] mounted ${f.name}`);
    } catch (err) {
      console.error(`[features] failed to mount ${f.name}:`, (err as Error)?.stack || err);
    }
  }
}

/** Merge every registered feature's contributed capability flags. Merged OVER core flags in
 *  `/api/features` so an add-on feature's declaration wins. The core contributes nothing here. */
export function collectFeatureFlags(): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const f of registry) {
    if (!f.flags) continue;
    Object.assign(out, typeof f.flags === 'function' ? f.flags() : f.flags);
  }
  return out;
}

/** Merge every registered feature's sidecar WS proxy routes (prefix → port). Folded into the
 *  core WS proxy table after startup so feature daemons are reachable. */
export function collectSidecarRoutes(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of registry) if (f.sidecarRoutes) Object.assign(out, f.sidecarRoutes);
  return out;
}

/** Every MCP server name registered features insist on always having. The core contributes NONE, so
 *  an engine that narrows its MCP set starts from empty and names no add-on server itself. */
export function collectAlwaysMcp(): Set<string> {
  const out = new Set<string>();
  for (const f of registry) {
    if (!f.alwaysMcp) continue;
    for (const n of typeof f.alwaysMcp === 'function' ? f.alwaysMcp() : f.alwaysMcp) out.add(n);
  }
  return out;
}

/** Let a registered feature resume its own interrupted sessions (used by crash recovery). */
export function resumeFeatureSession(channel: string, session: unknown, prompt: string): boolean {
  const f = registry.find((x) => x.name === channel && x.resumeSession);
  if (!f) return false;
  Promise.resolve(f.resumeSession!(session, prompt)).catch((err) =>
    console.error(`[features] ${channel} resume failed:`, (err as Error).message),
  );
  return true;
}
