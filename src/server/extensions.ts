// Generic loader for deployment-specific HTTP routes ("extensions").
//
// Drop a `*.ext.ts` file into the data dir's `extensions/` folder that exports a
// default `register(router, ctx)` function and it's mounted — into a persistent
// Router that is itself mounted BEFORE the SPA catch-all (`app.get('*')`). That
// ordering is the whole trick: a route registered after the catch-all is silently
// swallowed → returns SPA HTML.
//
// HOT-RELOAD: NEW `*.ext.ts` files are picked up at runtime (a dir watch re-scans)
// — no server restart needed. Because routes are added to the already-mounted
// Router, they're reachable immediately and still sit before the catch-all.
// CAVEAT: EDITING an already-loaded file does NOT hot-reload (ESM module cache;
// re-importing would stack duplicate handlers) — that still needs a restart.
//
// Keeps one-off / per-deployment flows that must live on this instance's own
// public URL (OAuth/manifest callbacks, webhooks) OUT of shared `src/`.
// See the self-aware skill, "Where one-off / custom code goes".
import express, { type Express, type Router as ExpressRouter, type RequestHandler } from 'express';
import { existsSync, readdirSync, watch } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { dataPath } from './paths.ts';
import { requireAuth } from './auth.ts';
import { emitEvent } from './events/bus.ts';
import { registerWebhook, type WebhookOptions } from './events/webhook.ts';

export interface ExtensionContext {
  /** Resolve a path inside the active data dir (e.g. ctx.dataPath('github-app.json')). */
  dataPath: (p: string) => string;
  /** Express middleware enforcing auth (bearer / api-key / internal token / ?token=). */
  requireAuth: RequestHandler;
  /** Prefixed logger. */
  log: (...a: unknown[]) => void;
  /** The root Express app, for the rare extension needing app-level middleware. */
  app: Express;
  /** Publish an event onto the bus → fires matching `event`-trigger schedules.
   *  Use after verifying a vendor webhook's own signature. */
  emitEvent: (source: string, payload: unknown, opts?: { id?: string }) => void;
  /** Declare a vendor webhook as data: mounts a PUBLIC POST /api/webhooks/<source>
   *  that runs `verify` (the only per-vendor piece) → emitEvent. Returns the path. */
  registerWebhook: <K extends string>(opts: WebhookOptions<K>) => string;
}

/** A programmatic extension: the same shape as a `*.ext.ts` file's default export. */
export type ExtRegisterFn = (router: ExpressRouter, ctx: ExtensionContext) => void | Promise<void>;

const loaded = new Set<string>();
let extRouter: ExpressRouter | null = null;
let ctx: ExtensionContext | null = null;
const pendingProgrammatic: ExtRegisterFn[] = [];

/** Reset the module-global router/ctx/registry. For tests: `extRouter`, `ctx` and `loaded` are
 *  process-globals, so a test file that boots a second createShraga server in the same bun process
 *  inherits the PRIOR file's router — and a pre-start `registerExtension`/`registerWebhook` (which
 *  mounts immediately once `extRouter && ctx` are set, see registerExtension) then lands on the DEAD
 *  router instead of queueing for the new one → the new server 404s. bun's cross-file order is not
 *  stable across platforms (a Linux CI order that macOS never hits), so a test that boots a server
 *  must reset first to be hermetic. Mirrors clearTurnContext() in turn-context.ts. Test-only. */
export function __resetExtensionsForTest(): void {
  extRouter = null;
  ctx = null;
  loaded.clear();
  pendingProgrammatic.length = 0;
}

async function runProgrammatic(fn: ExtRegisterFn): Promise<void> {
  try {
    await fn(extRouter!, ctx!);
    console.log('[extensions] mounted programmatic extension');
  } catch (err) {
    console.error('[extensions] programmatic register failed:', (err as Error)?.stack || err);
  }
}

/**
 * Programmatic equivalent of dropping a `data/extensions/*.ext.ts` file. Funnels through the SAME
 * persistent Router + ExtensionContext (mounted before the SPA catch-all), so a webhook/callback
 * registered this way is reachable exactly like a file-based one. If called before loadExtensions()
 * (the usual case — createShraga queues these pre-boot), it runs when the router is ready.
 */
export async function registerExtension(fn: ExtRegisterFn): Promise<void> {
  if (extRouter && ctx) return runProgrammatic(fn);
  pendingProgrammatic.push(fn);
}

async function mountFile(dir: string, f: string): Promise<void> {
  if (loaded.has(f) || !extRouter || !ctx) return;
  loaded.add(f); // claim before the await, so overlapping scans can't double-mount the same file
  try {
    const mod = await import(pathToFileURL(path.join(dir, f)).href);
    const register = mod.default ?? mod.register;
    if (typeof register !== 'function') {
      loaded.delete(f); // release so a fixed file is retried on its next change event
      console.warn(`[extensions] ${f}: no default export (register fn) — skipped`);
      return;
    }
    // Routes register onto the persistent Router (mounted before the catch-all).
    await register(extRouter, ctx);
    console.log(`[extensions] mounted ${f}`);
  } catch (err) {
    loaded.delete(f); // import/register threw — allow a retry on the next change
    console.error(`[extensions] failed to mount ${f}:`, (err as Error)?.stack || err);
  }
}

async function scan(dir: string): Promise<void> {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.ext.ts')).sort()) {
    await mountFile(dir, f);
  }
}

export async function loadExtensions(app: Express): Promise<void> {
  extRouter = express.Router();
  app.use(extRouter); // BEFORE the SPA catch-all (loadExtensions is called before it in index.ts)
  ctx = {
    dataPath,
    requireAuth: requireAuth as unknown as RequestHandler,
    log: (...a) => console.log('[extensions]', ...a),
    app,
    emitEvent,
    // Mount on the extension Router (before the SPA catch-all) so hot-loaded
    // webhooks are reachable too — never on `app` directly.
    registerWebhook: (opts) => registerWebhook(extRouter!, opts),
  };

  // Flush programmatic extensions first (they mount ahead of file-based drop-ins, before the catch-all).
  for (const fn of pendingProgrammatic.splice(0)) await runProgrammatic(fn);

  const dir = path.resolve(dataPath('extensions'));
  await scan(dir);

  // Hot-reload: re-scan when a *.ext.ts file appears at runtime (debounced).
  if (existsSync(dir)) {
    try {
      let t: ReturnType<typeof setTimeout> | null = null;
      watch(dir, (_evt, filename) => {
        if (!filename || !String(filename).endsWith('.ext.ts')) return;
        if (t) clearTimeout(t);
        t = setTimeout(() => {
          scan(dir).catch((err) => console.error('[extensions] rescan failed:', (err as Error).message));
        }, 300);
      });
      console.log('[extensions] watching for new *.ext.ts (hot-reload of new files, no restart)');
    } catch (err) {
      console.warn('[extensions] dir watch unavailable (new files need a restart):', (err as Error).message);
    }
  }
}
