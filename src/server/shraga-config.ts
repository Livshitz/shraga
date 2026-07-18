import { existsSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths.ts';
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

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..');

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

export async function loadShragaConfig(): Promise<ShragaConfig> {
  if (_cached) return _cached;
  const configPath = resolveConfigPath();
  if (!configPath) {
    _cached = {};
    return _cached;
  }
  try {
    const mod = await import(configPath);
    _cached = mod.default ?? {};
  } catch (e) {
    console.error(`[config] failed to load ${path.basename(configPath)}:`, e instanceof Error ? e.message : String(e));
    _cached = {};
  }
  // Every path above assigns _cached a non-null value; `?? {}` satisfies the type
  // without changing behavior (mirrors getShragaConfigSync below).
  return _cached ?? {};
}

export function getShragaConfigSync(): ShragaConfig {
  if (!_cached) console.warn('[config] getShragaConfigSync called before loadShragaConfig — returning empty config');
  return _cached ?? {};
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
      const vendorDir = path.join(PROJECT_ROOT, 'vendor', shorthand.dir ?? name);
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
