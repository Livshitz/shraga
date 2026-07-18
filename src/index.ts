// Shraga — public library surface.
//
// The FIRST-CLASS way to consume Shraga: `import { createShraga } from 'shraga'`, configure with
// typed options, register/extend programmatically through the same seams the built-ins use
// (features, engines, the event bus, verified webhooks, data-side extensions), then `start()`.
//
//   import { createShraga } from 'shraga';
//   const app = createShraga({ port: 3032, dataDir: './data', authProvider: 'local' });
//   app.registerFeature(myFeature);
//   app.on('gmail', (payload) => { … });
//   await app.start();
//   // … app.stop() to shut down.
//
// The run-from-source entry (`src/server/index.ts`, used by prod `bun run src/server/index.ts`) and
// the `shraga` CLI both dogfood this exact surface — createShraga(fromEnv()).start(). File-based
// `data/extensions/*.ext.ts` drop-ins and `SHRAGA_OVERLAY` keep working: they reach the SAME
// programmatic registries, just via a different door.

// Type-only imports below: importing this module must NOT eagerly load the server graph (which
// resolves DATA_DIR at import time). The runtime boot is a dynamic import inside start(), AFTER
// options have been mapped onto the environment.
import type { BootRegistrations, ServerHandle } from './server/boot.ts';
import type { ServerFeature, FeatureContext } from './server/features.ts';
import type { AgentEngine, EngineModel, EngineStreamOpts } from './server/engine/types.ts';
import type { ExtRegisterFn, ExtensionContext } from './server/extensions.ts';
import type { WebhookOptions } from './server/events/webhook.ts';
import type { ShragaEvent, ShragaEventMap, PayloadOf } from './server/events/types.ts';

export type {
  ServerHandle,
  ServerFeature,
  FeatureContext,
  AgentEngine,
  EngineModel,
  EngineStreamOpts,
  ExtRegisterFn,
  ExtensionContext,
  WebhookOptions,
  ShragaEvent,
  ShragaEventMap,
  PayloadOf,
};

/** Typed configuration for a Shraga instance. Follows the repo's ModuleOptions convention:
 *  defaults live here and are merged with the caller's partial. Anything not modelled is still
 *  reachable via `env` (Shraga is heavily env-driven) — those are set before the server boots. */
export class ShragaOptions {
  /** HTTP/WS port. Default 3032 (or PORT env). */
  port?: number;
  /** Data directory (flat-file storage root). Default ./data (or DATA_DIR env). */
  dataDir?: string;
  /** Auth backend. 'local' (default) = username/password; 'firebase' needs the firebase add-on. */
  authProvider?: 'local' | 'firebase';
  /** Directory of the built client to serve (index.html + assets). Default = shraga's shipped
   *  `dist/client`. A consumer shipping its own UI (e.g. the EE client build) points this at its
   *  own dist. Precedence: this option > SHRAGA_CLIENT_DIR env > default. */
  clientDir?: string;
  /** Passive mode — HTTP serving only, no schedulers/consumers/background writers (standby twins). */
  passive?: boolean;
  /** Install process SIGTERM/SIGINT handlers (default true — the standalone server/CLI wants them).
   *  A library embedder owning its own lifecycle sets false and uses stop(). */
  installSignalHandlers?: boolean = true;
  /** OPT-IN runtime plug-and-play (default false). When true, the ServerHandle returned by start()
   *  can register extensions/webhooks and subscribe to events AFTER boot (they mount on the live
   *  extension Router / event bus). When false, those handle methods throw. Pre-start registration is
   *  unaffected either way. Features & engines are NEVER runtime-registerable (they mount at boot). */
  runtimeRegistration?: boolean = false;
  /** Arbitrary extra environment to apply before boot (e.g. ANTHROPIC_API_KEY, SHRAGA_FEAT_*). */
  env?: Record<string, string>;
}

export interface ShragaInstance {
  /** Register a server feature (routes/WS/consumers) — the same seam Slack uses. */
  registerFeature(feature: ServerFeature): this;
  /** Register a pluggable agent engine (runtime). */
  registerEngine(engine: AgentEngine): this;
  /** Register a programmatic extension — the same shape as a data/extensions/*.ext.ts default export. */
  registerExtension(fn: ExtRegisterFn): this;
  /** Declare a verified vendor webhook (public POST /api/webhooks/<source> → typed event). */
  registerWebhook<K extends string>(opts: WebhookOptions<K>): this;
  /** Subscribe to a typed event source on the in-process bus. */
  on<K extends string>(source: K, handler: (payload: PayloadOf<K>, evt: ShragaEvent<K>) => void): this;
  /** Publish an event onto the bus (after start()). */
  emit<K extends string>(source: K, payload: PayloadOf<K>): this;
  /** Boot HTTP + WS. Resolves once listening. Idempotent — repeated calls return the same handle. */
  start(): Promise<ServerHandle>;
  /** Drain and shut down without exiting the process. */
  stop(): Promise<void>;
  /** The live Express app (advanced use) — available after start(). */
  readonly app: ServerHandle['app'] | undefined;
  /** Publish onto the bus directly (advanced use) — available after start(). */
  readonly emitEvent: ServerHandle['emitEvent'] | undefined;
}

class Shraga implements ShragaInstance {
  public options: ShragaOptions;
  private reg: Required<BootRegistrations> = { features: [], engines: [], extensions: [], eventSubs: [] };
  private handle: ServerHandle | null = null;
  private starting: Promise<ServerHandle> | null = null;

  constructor(options?: Partial<ShragaOptions>) {
    this.options = { ...new ShragaOptions(), ...options };
    // Map options onto the environment NOW, before any server module (which resolves DATA_DIR /
    // AUTH_PROVIDER at import time) can load. start()'s dynamic import happens strictly after this.
    this.applyEnv();
  }

  private applyEnv(): void {
    const o = this.options;
    if (o.port != null) process.env.PORT = String(o.port);
    if (o.dataDir != null) process.env.DATA_DIR = o.dataDir;
    if (o.authProvider != null) process.env.AUTH_PROVIDER = o.authProvider;
    if (o.clientDir != null) process.env.SHRAGA_CLIENT_DIR = o.clientDir;
    if (o.passive != null) process.env.SHRAGA_PASSIVE = o.passive ? '1' : '0';
    if (o.installSignalHandlers === false) process.env.SHRAGA_INSTALL_SIGNALS = '0';
    if (o.runtimeRegistration != null) process.env.SHRAGA_RUNTIME_REGISTRATION = o.runtimeRegistration ? '1' : '0';
    for (const [k, v] of Object.entries(o.env ?? {})) process.env[k] = v;
  }

  private assertNotStarted(what: string): void {
    if (this.handle || this.starting) throw new Error(`[shraga] ${what} must be called before start()`);
  }

  registerFeature(feature: ServerFeature): this { this.assertNotStarted('registerFeature'); this.reg.features.push(feature); return this; }
  registerEngine(engine: AgentEngine): this { this.assertNotStarted('registerEngine'); this.reg.engines.push(engine); return this; }
  registerExtension(fn: ExtRegisterFn): this { this.assertNotStarted('registerExtension'); this.reg.extensions.push(fn); return this; }

  registerWebhook<K extends string>(opts: WebhookOptions<K>): this {
    this.assertNotStarted('registerWebhook');
    // A webhook is just an extension that mounts a verified route on the extension router (before the
    // SPA catch-all) — identical to a file-based webhook. Reuse the seam; don't invent a parallel one.
    this.reg.extensions.push((_router, ctx: ExtensionContext) => { ctx.registerWebhook(opts); });
    return this;
  }

  on<K extends string>(source: K, handler: (payload: PayloadOf<K>, evt: ShragaEvent<K>) => void): this {
    this.assertNotStarted('on');
    this.reg.eventSubs.push({ source, handler: handler as (payload: unknown, evt: unknown) => void });
    return this;
  }

  emit<K extends string>(source: K, payload: PayloadOf<K>): this {
    if (!this.handle) throw new Error('[shraga] emit() requires start() first');
    this.handle.emitEvent(source, payload);
    return this;
  }

  async start(): Promise<ServerHandle> {
    if (this.handle) return this.handle;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const { bootServer } = await import('./server/boot.ts');
      this.handle = await bootServer(this.reg);
      return this.handle;
    })();
    return this.starting;
  }

  async stop(): Promise<void> {
    if (this.handle) { await this.handle.stop(); this.handle = null; }
    this.starting = null;
  }

  get app() { return this.handle?.app; }
  get emitEvent() { return this.handle?.emitEvent; }
}

/** Create a Shraga instance. Configure it, register/extend, then `await instance.start()`. */
export function createShraga(options?: Partial<ShragaOptions>): ShragaInstance {
  return new Shraga(options);
}

/** Derive options from the environment (PORT / DATA_DIR / AUTH_PROVIDER / SHRAGA_PASSIVE). The
 *  run-from-source entry and the CLI pass this straight into createShraga. */
export function fromEnv(): Partial<ShragaOptions> {
  const passive = process.env.SHRAGA_PASSIVE ?? process.env.UNCLAW_PASSIVE;
  const runtimeReg = process.env.SHRAGA_RUNTIME_REGISTRATION;
  return {
    port: process.env.PORT ? Number(process.env.PORT) : undefined,
    dataDir: process.env.DATA_DIR || undefined,
    authProvider: (process.env.AUTH_PROVIDER as 'local' | 'firebase' | undefined) || undefined,
    clientDir: process.env.SHRAGA_CLIENT_DIR || undefined,
    passive: passive === '1' || passive === 'true' ? true : undefined,
    runtimeRegistration: runtimeReg === '1' || runtimeReg === 'true' ? true : undefined,
  };
}
