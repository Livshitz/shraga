import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { DATA_DIR, APP_ROOT } from './paths.ts';
import type { McpServerConfig, McpConfig, McpHttpServerConfig } from './mcp.ts';

/** Shorthand for vendor-dir MCPs (auto-resolves command/args from vendor/{name}) */
export interface McpShorthandEntry {
  dir?: string;
  command?: string;
  args?: string[];
  env?: string[];
}

/** Full MCP config (command, args, env with values) — for non-vendor MCPs */
export interface McpFullEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
}

/** HTTP MCP config — persistent sidecar, not spawned per-query */
export interface McpHttpEntry {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  /** Vendor dir to auto-start as HTTP sidecar (resolved to vendor/{dir}) */
  dir?: string;
  /** Port for the sidecar process */
  port?: number;
}

export type McpEntry = McpShorthandEntry | McpFullEntry | McpHttpEntry;

function isHttpEntry(entry: McpEntry): entry is McpHttpEntry {
  return (entry as any).type === 'http';
}

function isFullEntry(entry: McpEntry): entry is McpFullEntry {
  return 'command' in entry && !Array.isArray((entry as any).env) && !isHttpEntry(entry);
}

export interface AgentSettings {
  model?: string;
  engine?: string;
  systemPrompt?: string;
  allowedTools?: string[];
  permissionMode?: string;
  maxTurns?: number;
  skillDiscovery?: boolean;
  thinking?: 'adaptive' | 'enabled' | 'disabled';
  effort?: 'low' | 'medium' | 'high' | 'max';
}

export interface ShragaConfig {
  /** @deprecated Use `mcps` instead */
  vendorMcps?: Record<string, McpShorthandEntry>;
  mcps?: Record<string, McpEntry>;
  /** Public origin this deployment is reachable at, e.g. `https://agent.example.com`.
   *  Used to build absolute session links for out-of-band notifications (push, alerts)
   *  that have no incoming request to derive it from. Falls back to `$PUBLIC_ORIGIN`. */
  publicOrigin?: string;
}

export interface HttpSidecarSpec {
  name: string;
  dir: string;
  port: number;
  url: string;
}

export function defineConfig(config: ShragaConfig): ShragaConfig {
  return config;
}

/**
 * Config filenames, in precedence order. `shraga.config.ts` is canonical; `unclaw.config.ts` is
 * the legacy name kept for back-compat — existing deployments have that file in their data dir,
 * and dropping it would silently fall back to an empty config (losing every global MCP).
 * Seeding is guarded on BOTH names (see seed.ts) so a fresh canonical file can never shadow a
 * populated legacy one.
 */
export const CONFIG_FILENAMES = ['shraga.config.ts', 'unclaw.config.ts'] as const;

/** First config file that exists in the data dir, or null when none is present. */
export function resolveConfigPath(): string | null {
  for (const name of CONFIG_FILENAMES) {
    const p = path.join(DATA_DIR, name);
    if (existsSync(p)) return p;
  }
  return null;
}

let _cached: ShragaConfig | null = null;
/** Config file the cache was built from, and its `mtimeMs:size` stamp. */
let _cachedPath: string | null = null;
let _cachedStamp = '';
/** Stamp of the last version we failed to load — so a broken config logs once, not per call. */
let _failedStamp = '';
/** True once we've reported that a previously-present config file went missing (log once, not per call). */
let _missingLogged = false;

const _require = createRequire(import.meta.url);

function stampOf(file: string): string {
  try {
    const st = statSync(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return '';
  }
}

/**
 * Load the config module SYNCHRONOUSLY, bypassing the runtime module cache.
 *
 * Busting `_cached` alone is not enough: `await import(p)` returns the SAME module object for a
 * path already loaded, so an edited file is never re-evaluated (measured on Bun 1.3.10).
 * `require` + a `require.cache` delete does re-evaluate — and being sync, it lets the sync
 * consumers (`getGlobalMcpsFromConfig`, `getPublicOrigin`, …) pick up an edit with no call-site
 * changes anywhere.
 *
 * Throws on a broken config; callers keep the last-good value.
 */
function readConfigSync(configPath: string): ShragaConfig {
  // A 0-byte file is a TRUNCATED/FAILED WRITE, not an authored "no MCPs": `require` hands back `{}`
  // for it without throwing, which would silently drop every global MCP. Fail loudly instead so the
  // caller keeps the last-good value — and, because the stamp is not advanced, recovers by itself
  // the moment the real content lands.
  if (statSync(configPath).size === 0) {
    throw new Error('config file is empty (0 bytes) — refusing to load it over the last-good config');
  }
  try {
    // Delete by the RESOLVED key: the cache is keyed by the realpath, and DATA_DIR is often a
    // symlinked path (macOS /var -> /private/var, or a symlinked data dir), so deleting the
    // literal path silently misses and the stale module is returned.
    const cache = _require.cache as Record<string, unknown> | undefined;
    if (cache) {
      delete cache[_require.resolve(configPath)];
      delete cache[configPath];
    }
  } catch {
    // A runtime without a mutable require.cache: fall through — the load below may still be fresh,
    // and loadShragaConfig()'s async fallback covers the stale case.
  }
  const mod = _require(configPath);
  return (mod?.default ?? {}) as ShragaConfig;
}

/**
 * Re-read the config when the file changed on disk (mtime+size), so editing `shraga.config.ts`
 * takes effect without restarting the process — the way editing `data/mcps/<uid>.json` already
 * does. Returns the load error, or null.
 *
 * Fully synchronous, so two concurrent turns can never interleave into a torn cache.
 */
function refreshConfig(): unknown {
  const configPath = resolveConfigPath();
  if (!configPath) {
    // Cold start with no config at all: an empty config is the honest answer.
    if (_cached === null) { _cached = {}; _cachedPath = null; _cachedStamp = ''; return null; }
    // We HAD a config and the file is now gone — deleted, renamed, or a checkout/mount blip.
    // Resetting the cache here would silently drop EVERY global MCP from a running process, with
    // no log to explain it. Keep the last-good value (same policy as a config that fails to parse),
    // say so once, and leave _cachedPath/_cachedStamp intact so a re-appearing file recovers.
    if (_cachedPath !== null && !_missingLogged) {
      _missingLogged = true;
      console.error(
        `[config] ${path.basename(_cachedPath)} is GONE from ${DATA_DIR} —`,
        'KEEPING the last-good config in memory (global MCPs preserved)',
      );
    }
    return null;
  }
  _missingLogged = false;
  const stamp = stampOf(configPath);
  if (_cached !== null && configPath === _cachedPath && stamp === _cachedStamp) return null;
  try {
    _cached = readConfigSync(configPath);
    _cachedPath = configPath;
    _cachedStamp = stamp;
    _failedStamp = '';
    return null;
  } catch (e) {
    if (_failedStamp !== stamp) {
      _failedStamp = stamp;
      console.error(
        `[config] failed to load ${path.basename(configPath)}:`,
        e instanceof Error ? e.message : String(e),
        _cached === null ? '— using an EMPTY config' : '— KEEPING the last-good config in memory',
      );
    }
    // Never leave the process with no config, and never poison the cache with a broken file:
    // keep the last-good value, and deliberately do NOT advance _cachedStamp so the next call
    // retries (a fixed file recovers on its own).
    if (_cached === null) { _cached = {}; _cachedPath = configPath; _cachedStamp = ''; }
    return e;
  }
}

/** Drop the cache so the next read re-evaluates the config file unconditionally. */
export function invalidateShragaConfig(): void {
  _cached = null;
  _cachedPath = null;
  _cachedStamp = '';
  _failedStamp = '';
}

export async function loadShragaConfig(): Promise<ShragaConfig> {
  const err = refreshConfig();
  if (err) {
    // `require` cannot load every valid ESM config (top-level await). Retry through the async
    // loader — cache-busted, since a plain re-import of a loaded path returns the stale module.
    const configPath = resolveConfigPath();
    if (configPath) {
      try {
        const stamp = stampOf(configPath);
        const mod = await import(`${configPath}?stamp=${encodeURIComponent(stamp)}`);
        // We just awaited, so the world may have moved: another caller can have loaded a NEWER
        // config synchronously while this import was in flight. Committing unconditionally would
        // overwrite it with the older value AND stamp it as current — a lost update that hands the
        // stale config to both callers. Commit only when the file on disk is still the version we
        // imported and the cache has not already reached it.
        if (stampOf(configPath) === stamp && _cachedStamp !== stamp) {
          _cached = mod.default ?? {};
          _cachedPath = configPath;
          _cachedStamp = stamp;
          _failedStamp = '';
        }
      } catch {
        // Already logged by refreshConfig; last-good (or {}) stands.
      }
    }
  }
  return _cached ?? {};
}

export function getShragaConfigSync(): ShragaConfig {
  refreshConfig();
  return _cached ?? {};
}

/** This deployment's public origin, without a trailing slash — data-dir config first, then
 *  `$PUBLIC_ORIGIN`. Empty when unconfigured: callers MUST omit the link rather than fall back
 *  to a locally-derived host, which is unreachable from wherever the notification is read. */
export function getPublicOrigin(): string {
  const origin = getShragaConfigSync().publicOrigin ?? process.env.PUBLIC_ORIGIN ?? '';
  return origin.trim().replace(/\/+$/, '');
}

/** Absolute link to a session in the web UI, or `undefined` when no public origin is configured. */
export function getSessionUrl(sessionId: string | undefined): string | undefined {
  const origin = getPublicOrigin();
  if (!origin || !sessionId) return undefined;
  return `${origin}/?session=${encodeURIComponent(sessionId)}`;
}

/** Resolve global MCPs from the data-dir config (both shorthand vendor entries and full entries) */
export function getGlobalMcpsFromConfig(): McpConfig {
  const ucConfig = getShragaConfigSync();
  const entries = ucConfig.mcps ?? ucConfig.vendorMcps ?? {};
  const result: McpConfig = {};

  for (const [name, entry] of Object.entries(entries)) {
    if (isHttpEntry(entry)) {
      const { dir: _dir, port: _port, ...httpConfig } = entry;
      result[name] = httpConfig satisfies McpHttpServerConfig;
    } else if (isFullEntry(entry)) {
      const full = entry;
      result[name] = { type: 'stdio', ...full } satisfies McpServerConfig;
    } else {
      const shorthand = entry as McpShorthandEntry;
      const vendorDir = path.join(APP_ROOT, 'vendor', shorthand.dir ?? name);
      const command = shorthand.command ?? 'bun';
      const args = shorthand.args ?? ['run', path.join(vendorDir, 'src/mcp/cli.ts'), '--stdio'];
      const env: Record<string, string> = {};
      if (Array.isArray(shorthand.env)) {
        for (const key of shorthand.env) env[key] = '';
      } else if (shorthand.env && typeof shorthand.env === 'object') {
        // object form: explicit name->value (or $PLACEHOLDER resolved by env-resolve). A malformed
        // env must never crash MCP setup for ALL chat turns — degrade gracefully.
        for (const [k, v] of Object.entries(shorthand.env)) env[k] = typeof v === 'string' ? v : '';
      }
      result[name] = { type: 'stdio', command, args, env } satisfies McpServerConfig;
    }
  }

  return result;
}

/** Extract HTTP sidecar specs that need to be auto-started */
export function getHttpSidecarSpecs(): HttpSidecarSpec[] {
  const ucConfig = getShragaConfigSync();
  const entries = ucConfig.mcps ?? {};
  const specs: HttpSidecarSpec[] = [];

  for (const [name, entry] of Object.entries(entries)) {
    if (!isHttpEntry(entry) || !entry.dir) continue;
    if (entry.enabled === false) continue;
    const urlPort = new URL(entry.url).port;
    const port = entry.port ?? (urlPort ? parseInt(urlPort) : 3846);
    specs.push({ name, dir: entry.dir, port, url: entry.url });
  }

  return specs;
}
