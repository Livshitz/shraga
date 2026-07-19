import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { dataPath, APP_ROOT } from './paths.ts';
import { dataSync } from './data-sync.ts';
import { getGlobalMcpsFromConfig } from './shraga-config.ts';

const MCP_DIR = dataPath('mcps');

export interface McpStdioServerConfig {
  /** When false, server stays in config for UI / sync but is omitted from the Claude SDK. Default: true. */
  enabled?: boolean;
  /** Claude Code CLI expects stdio transports to declare type (see --mcp-config validation). */
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpHttpServerConfig {
  enabled?: boolean;
  type: 'http';
  url: string;
  headers?: Record<string, string>;
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

export type McpConfig = Record<string, McpServerConfig>;

function loadJson(file: string): McpConfig {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return {};
  }
}

function mcpPath(uid: string) {
  return path.join(MCP_DIR, `${uid}.json`);
}

export function getGlobalMcpConfig(): McpConfig {
  return getGlobalMcpsFromConfig();
}

export function getUserMcpConfig(uid: string): McpConfig {
  return loadJson(mcpPath(uid));
}

function isHttpConfig(s: McpServerConfig): s is McpHttpServerConfig {
  return s.type === 'http';
}

/** Resolve env values: empty → process.env[same key], "$VAR" → process.env[VAR] */
function resolveEnv(config: McpConfig): McpConfig {
  const resolved: McpConfig = {};
  for (const [name, server] of Object.entries(config)) {
    if (isHttpConfig(server)) { resolved[name] = server; continue; }
    if (!server.env) { resolved[name] = server; continue; }
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(server.env)) {
      // env values can be null/undefined/non-string if a config was edited by hand
      // or synced from another instance — coerce defensively so resolution never throws.
      if (v == null || v === '') {
        env[k] = process.env[k] || '';
      } else if (typeof v !== 'string') {
        env[k] = String(v);
      } else if (v.startsWith('$')) {
        env[k] = process.env[v.slice(1)] || '';
      } else {
        env[k] = v;
      }
    }
    // Env-gate: a server that DECLARES env keys but resolves them all empty isn't configured for
    // this deployment (e.g. an MCP that needs STRIPE_SECRET_KEY when none is set) — skip it instead
    // of mounting → failing every turn. Servers with no declared env, or any value present, pass.
    if (Object.keys(env).length > 0 && Object.values(env).every((v) => !v)) {
      console.log(`[mcp] ${name}: skipped — required env (${Object.keys(env).join(', ')}) not set in this deployment`);
      continue;
    }
    resolved[name] = { ...server, env };
  }
  return resolved;
}

const MASK_CHAR = '••••';

function maskValue(v: string): string {
  if (!v || v.length <= 8) return MASK_CHAR;
  return `${v.slice(0, 4)}${MASK_CHAR}${v.slice(-4)}`;
}

function isMasked(v: string): boolean {
  return v.includes(MASK_CHAR);
}

/** Mask env values for client display */
export function maskEnvValues(config: McpConfig): McpConfig {
  const masked: McpConfig = {};
  for (const [name, server] of Object.entries(config)) {
    if (isHttpConfig(server)) { masked[name] = server; continue; }
    if (!server.env) { masked[name] = server; continue; }
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(server.env)) {
      env[k] = v ? maskValue(v) : '';
    }
    masked[name] = { ...server, env };
  }
  return masked;
}

/** Merge incoming config, preserving original values for masked fields */
export function mergeWithOriginal(incoming: McpConfig, original: McpConfig): McpConfig {
  const merged: McpConfig = {};
  for (const [name, server] of Object.entries(incoming)) {
    if (isHttpConfig(server)) { merged[name] = server; continue; }
    if (!server.env) { merged[name] = server; continue; }
    const orig = original[name];
    const origEnv = (orig && !isHttpConfig(orig) ? orig.env : undefined) || {};
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(server.env)) {
      if (!isMasked(v)) {
        env[k] = v;
        continue;
      }
      const saved = origEnv[k];
      env[k] =
        saved != null && saved !== ''
          ? saved
          : (process.env[k] || '');
    }
    merged[name] = { ...server, env };
  }
  return merged;
}

/** Global MCPs merged with per-user overrides (raw, no env resolution) */
export function getRawMcpConfig(uid: string): McpConfig {
  return { ...getGlobalMcpConfig(), ...getUserMcpConfig(uid) };
}

/** Ensure stdio MCP entries match CLI schema (avoids silent drops / validation issues). */
function withStdioType(config: McpConfig): McpConfig {
  const out: McpConfig = {};
  for (const [name, server] of Object.entries(config)) {
    if (isHttpConfig(server)) { out[name] = server; continue; }
    if (server.command && !server.type) out[name] = { type: 'stdio', ...server };
    else out[name] = server;
  }
  return out;
}

/** Canonical path baked into MCP env when prod has the file deployed (cwd = app dir). */
const GOOGLE_SA_DEPLOY_REL = './secrets/google-service-account.json';

/**
 * Resolve GOOGLE_SERVICE_ACCOUNT for any MCP that declares it in env.
 * - Inline JSON when env starts with `{`.
 * - Fall back to `secrets/google-service-account.json` when the path is bogus.
 */
function finalizeGoogleServiceAccountCredentials(config: McpConfig): McpConfig {
  const jsonFromEnv = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  const defaultAbs = path.join(APP_ROOT, 'secrets/google-service-account.json');
  const defaultExists = existsSync(defaultAbs);

  let result = { ...config };
  for (const [name, entry] of Object.entries(result)) {
    if (isHttpConfig(entry)) continue;
    if (!entry.env || !('GOOGLE_SERVICE_ACCOUNT' in entry.env)) continue;

    const accountFromResolve = entry.env.GOOGLE_SERVICE_ACCOUNT?.trim() ?? '';

    if (jsonFromEnv?.startsWith('{')) {
      result = { ...result, [name]: { ...entry, env: { ...entry.env, GOOGLE_SERVICE_ACCOUNT: jsonFromEnv } } };
      continue;
    }

    if (accountFromResolve.startsWith('{')) continue;

    const raw = accountFromResolve;
    const pathOk =
      raw &&
      !raw.includes('${') &&
      existsSync(path.isAbsolute(raw) ? raw : path.resolve(APP_ROOT, raw.replace(/^\.\//, '')));

    if (pathOk) continue;
    if (!defaultExists) continue;

    result = { ...result, [name]: { ...entry, env: { ...entry.env, GOOGLE_SERVICE_ACCOUNT: GOOGLE_SA_DEPLOY_REL } } };
  }

  return result;
}

/**
 * For MCP entries that declare FIREBASE_DATABASE_URL + FIREBASE_SERVICE_ACCOUNT_JSON in env:
 * resolve from FIREBASE_CONFIG_* JSON blobs when the dedicated env vars are empty.
 */
function finalizeFirebaseCredentials(config: McpConfig): McpConfig {
  let result = { ...config };
  for (const [name, entry] of Object.entries(result)) {
    if (isHttpConfig(entry)) continue;
    if (!entry.env || !('FIREBASE_DATABASE_URL' in entry.env)) continue;

    const patches: Record<string, string> = {};
    const isEmpty = (v?: string) => !v || v.startsWith('${');

    if (isEmpty(entry.env.FIREBASE_DATABASE_URL)) {
      const suffix = name.includes('lab') ? 'LAB' : name.includes('prod') ? 'PROD' : '';
      const configKeys = suffix
        ? [`FIREBASE_CONFIG_${suffix}`, `VITE_FIREBASE_CONFIG_${suffix}`, 'FIREBASE_CONFIG']
        : ['FIREBASE_CONFIG'];
      const configJson = configKeys.map(k => process.env[k]).find(v => v?.trim());
      if (configJson) try {
        const parsed = JSON.parse(configJson);
        if (parsed.databaseURL) patches.FIREBASE_DATABASE_URL = parsed.databaseURL;
      } catch { /* not valid JSON */ }
    }

    if (isEmpty(entry.env.FIREBASE_SERVICE_ACCOUNT_JSON)) {
      const suffix = name.includes('lab') ? 'LAB' : name.includes('prod') ? 'PROD' : '';
      const saKeys = suffix
        ? [`FIREBASE_SERVICE_ACCOUNT_JSON_${suffix}`, 'FIREBASE_SERVICE_ACCOUNT_JSON']
        : ['FIREBASE_SERVICE_ACCOUNT_JSON'];
      const sa = saKeys.map(k => process.env[k]).find(v => v?.trim());
      if (sa) patches.FIREBASE_SERVICE_ACCOUNT_JSON = sa;
    }

    if (Object.keys(patches).length) {
      result = { ...result, [name]: { ...entry, env: { ...entry.env, ...patches } } };
    }
  }
  return result;
}

/** Full merged MCP config (includes `enabled: false` entries) for API/UI. */
export function getResolvedMcpConfig(uid: string): McpConfig {
  return finalizeFirebaseCredentials(
    finalizeGoogleServiceAccountCredentials(
      resolveEnv(
        withStdioType(
          getRawMcpConfig(uid),
        ),
      ),
    ),
  );
}

/** Strip disabled servers and drop `enabled` before passing to Claude Code (unknown keys can break validation). */
function activeMcpConfigForSdk(config: McpConfig): McpConfig {
  const out: McpConfig = {};
  for (const [name, server] of Object.entries(config)) {
    if (server.enabled === false) continue;
    const sdkServer = { ...server };
    delete (sdkServer as { enabled?: boolean }).enabled;
    out[name] = sdkServer;
  }
  return out;
}

/** Active MCPs only — used by agent, schedulers, webhooks, CLI sync. */
export function getMcpConfig(uid: string): McpConfig {
  return activeMcpConfigForSdk(getResolvedMcpConfig(uid));
}

/** Resolved, SDK-ready GLOBAL mcp config (no per-user overlay) — for boot/background catalog warm-up.
 *  The slow/shared servers are global, so warming this
 *  populates their catalog entries off the turn path. Per-user-only servers warm on first use. */
export function getGlobalMcpConfigForSdk(): McpConfig {
  return activeMcpConfigForSdk(
    finalizeFirebaseCredentials(
      finalizeGoogleServiceAccountCredentials(
        resolveEnv(
          withStdioType(
            getGlobalMcpConfig(),
          ),
        ),
      ),
    ),
  );
}

export function saveMcpConfig(uid: string, config: McpConfig): void {
  mkdirSync(MCP_DIR, { recursive: true });
  writeFileSync(mcpPath(uid), JSON.stringify(config, null, 2));
  dataSync.trackWrite(`mcps/${uid}.json`);
}

