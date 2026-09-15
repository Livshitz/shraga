// Enforcement: apply the resolved profile at the ONE choke point, the engine's spawn config + per-call tool gate.
//
// Flag `SECURITY_ENFORCE` (env, read per call, default OFF). OFF ⇒ shadow mode: nothing here is consulted and the
// spawn config is exactly today's (engine-security.test.ts snapshots it). ON ⇒ streamChat builds a TurnGuard and
// the engine derives from its effective profile:
// - built-in tool AVAILABILITY (`tools`), not regex denies; MCP servers filtered BEFORE the config file is written;
// - the subprocess env from an allowlist, never minus-nothing `process.env` — and `env:["*"]` still drops the
//   server's own secrets (SERVER_SECRET_ENV);
// - a gate on EVERY tool call (PreToolUse hook + canUseTool) that re-reads the session floor, so a lower-rank
//   message landing mid-turn lowers the running turn. The hook is load-bearing: the SDK auto-approves
//   `allowedTools` WITHOUT calling canUseTool, whereas PreToolUse hooks fire for every call (hooks.ts relies on it).
import type { HookCallback, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import type { McpConfig } from '../mcp.ts';
import type { Principal } from './principal.ts';
import type { Profile, Resolved } from './policy.ts';
import type { SecurityRuntime } from './runtime.ts';

export function enforcing(): boolean {
  const v = process.env.SECURITY_ENFORCE?.trim().toLowerCase();
  return v === 'true' || v === '1';
}

// ── Tools / MCP ──────────────────────────────────────────────────────────────

/** In-process MCP server carrying `escalate` (security/escalate.ts); the model sees `mcp__security__escalate`. */
export const ESCALATE_SERVER = 'security';
export const ESCALATE_TOOL = 'escalate';
export const ESCALATE_TOOL_ID = `mcp__${ESCALATE_SERVER}__${ESCALATE_TOOL}`;

/** `escalate` is opt-in by name (reply-only). `*` profiles don't get it: they can act, not just ask. */
export const allowsEscalate = (p: Pick<Profile, 'tools'>) => p.tools.includes(ESCALATE_TOOL);
export const allowsMcpServer = (p: Pick<Profile, 'mcps'>, server: string) => p.mcps.includes('*') || p.mcps.includes(server);

/** Built-in tools the profile makes available: `'all'` for `*`, else its names minus escalate/MCP ids. */
export function builtinTools(p: Pick<Profile, 'tools' | 'mcps'>): 'all' | string[] {
  if (p.tools.includes('*')) return 'all';
  const names = p.tools.filter(t => t !== ESCALATE_TOOL && !t.startsWith('mcp__'));
  // ToolSearch only loads deferred MCP tool schemas — needed exactly when any MCP tool is reachable.
  if ((p.mcps.length || allowsEscalate(p)) && !names.includes('ToolSearch')) names.push('ToolSearch');
  return names;
}

/** May this tool (built-in name or `mcp__<server>__<tool>`) run under the profile? */
export function profileAllowsTool(p: Pick<Profile, 'tools' | 'mcps'>, tool: string): boolean {
  if (tool.startsWith('mcp__')) {
    const server = tool.slice(5).split('__')[0];
    if (server === ESCALATE_SERVER) return allowsEscalate(p);
    return allowsMcpServer(p, server) || p.tools.includes(tool);
  }
  const b = builtinTools(p);
  return b === 'all' || b.includes(tool);
}

export function filterMcpServers(servers: McpConfig | undefined, p: Pick<Profile, 'mcps'>): McpConfig {
  return Object.fromEntries(Object.entries(servers ?? {}).filter(([name]) => allowsMcpServer(p, name))) as McpConfig;
}

// ── Env ──────────────────────────────────────────────────────────────────────

/**
 * The server's OWN secrets — never in an agent subprocess, whatever the profile says (`env:["*"]` included). The
 * agent does its job with integration credentials (Slack/GitHub tokens, MCP server env); it never needs what signs
 * sessions, verifies webhooks or defines who owns the deployment.
 * - OWNERS: root of trust. INTERNAL_API_TOKEN: raw internal secret (the engine injects a SCOPED token instead).
 * - Signing/verification + OAuth client secrets: SLACK_SIGNING_SECRET, SLACK_CLIENT_SECRET, DATA_SYNC_WEBHOOK_SECRET
 *   and any `*_CLIENT_SECRET` / `*_SIGNING_SECRET` / `*_WEBHOOK_SECRET` / `*_JWT_SECRET` / `*_SESSION_SECRET` /
 *   `*_AUTH_SECRET` / `*_OAUTH_SECRET` / `*_COOKIE_SECRET` (downstream overlays follow the same naming).
 * - Firebase admin creds: FIREBASE_SERVICE_ACCOUNT_JSON[_<ENV>] (mcp.ts hands them to the Firebase MCP via its
 *   config file, not via the agent's env), GOOGLE_APPLICATION_CREDENTIALS.
 * - MCP OAuth / local-auth signing secrets live in data/ files, not env; the file gate below covers them.
 */
const SECRET_ENV_EXACT = new Set(['OWNERS', 'INTERNAL_API_TOKEN', 'DATA_SYNC_WEBHOOK_SECRET', 'GOOGLE_APPLICATION_CREDENTIALS']);
const SECRET_ENV_RE = /^FIREBASE_SERVICE_ACCOUNT_JSON(?:_[A-Z0-9]+)?$|(?:^|_)(?:CLIENT|SIGNING|WEBHOOK|JWT|SESSION|AUTH|OAUTH|COOKIE)_SECRET$/;
export const isServerSecretEnv = (key: string) => SECRET_ENV_EXACT.has(key) || SECRET_ENV_RE.test(key);

/** What any agent process needs to run at all: OS basics, network/TLS, and the CLI's own model credentials/config. */
const BASELINE_ENV = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LANGUAGE', 'TERM', 'TZ',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CONFIG_DIR', 'DEBUG_CLAUDE_AGENT_SDK',
  'BASH_DEFAULT_TIMEOUT_MS', 'BASH_MAX_TIMEOUT_MS', 'ENABLE_CLAUDEAI_MCP_SERVERS',
]);
const BASELINE_PREFIX = ['LC_', 'CLAUDE_CODE_'];
const isBaselineEnv = (k: string) => BASELINE_ENV.has(k) || BASELINE_PREFIX.some(p => k.startsWith(p));
/** Profile env entry: exact name, or `PREFIX_*`. */
const listed = (entries: string[], k: string) => entries.some(e => e === k || (e.length > 1 && e.endsWith('*') && k.startsWith(e.slice(0, -1))));

/** Subprocess env from the allowlist: baseline + the profile's names (`*` = all), minus server secrets, always. */
export function buildAgentEnv(source: Record<string, string | undefined>, p: Pick<Profile, 'env'>): Record<string, string> {
  const all = p.env.includes('*');
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined || isServerSecretEnv(k)) continue;
    if (all || isBaselineEnv(k) || listed(p.env, k)) out[k] = v;
  }
  return out;
}

/** Only `*` env profiles get the scoped INTERNAL_API_TOKEN (it authenticates HTTP calls back as the user). */
export const allowsInternalToken = (p: Pick<Profile, 'env'>) => p.env.includes('*') || p.env.includes('INTERNAL_API_TOKEN');

// ── Server credential files ────────────────────────────────────────────────────
// Reading one of these IS privilege escalation (forge an owner MCP/local token, replay the raw internal secret, lift
// api keys), so even a Read-only profile must not see them. Path/command backstop for the file tools + Bash, all
// profiles, enforcement only. (Grep over a parent dir is not covered — protected paths are the tamper step.)
const SECRET_FILE_RE = /(?:^|[\s/'"=])(?:\.internal-token|\.mcp-oauth-secret|\.local-auth-secret|api-keys\.json|oauth-clients\.json|users\.json)(?:$|[\s'";|&)])/;
export function touchesServerSecretFile(tool: string, input: Record<string, unknown>): boolean {
  if (tool === 'Bash') return SECRET_FILE_RE.test(String(input.command ?? ''));
  const p = input.file_path ?? input.path ?? input.notebook_path;
  return typeof p === 'string' && SECRET_FILE_RE.test(p);
}

// ── Turn guard ───────────────────────────────────────────────────────────────

export type GateResult = { allow: true } | { allow: false; message: string };

export class TurnGuardOptions {
  runtime!: SecurityRuntime;
  principal!: Principal;
  sessionId?: string;
  /** The caller's own role/rank (policy.resolve at turn start). */
  role!: string;
  rank!: number;
  /** Session floor lookup (sessions.getSessionFloor — a Map read). Undefined = no floor recorded. */
  floorOf: (sessionId: string) => number | undefined = () => undefined;
  log: Pick<Console, 'log' | 'error'> = console;
}

/** One turn's security context, handed to the engine. */
export class TurnGuard {
  public options: TurnGuardOptions;

  public constructor(options: Partial<TurnGuardOptions> & Pick<TurnGuardOptions, 'runtime' | 'principal' | 'role' | 'rank'>) {
    this.options = { ...new TurnGuardOptions(), ...options };
  }

  /** Effective role right now: policy.effective(session floor, caller role). Re-read on every call. */
  public current(): Resolved {
    const { runtime, sessionId, floorOf, role, rank } = this.options;
    const floor = sessionId ? floorOf(sessionId) : undefined;
    return runtime.policy.effective(floor ?? rank, role);
  }

  /** Gate one tool call. Audits tool.allow / tool.deny (deduped per session+tool+role per window). Never throws. */
  public check(tool: string, input: Record<string, unknown> = {}): GateResult {
    const { runtime, principal, sessionId, log } = this.options;
    let eff: Resolved;
    try { eff = this.current(); } catch (e: any) {
      log.error(`[security] effective-role lookup failed — denying ${tool}: ${e.message}`);
      return { allow: false, message: 'Tool use is unavailable right now (security check failed).' };
    }
    const secretFile = touchesServerSecretFile(tool, input);
    const allowed = !secretFile && profileAllowsTool(eff.profile, tool);
    const base = { principal: principal.id, role: eff.role, sessionId, target: tool };
    try {
      runtime.record(allowed
        ? { type: 'tool.allow', ...base }
        : { type: 'tool.deny', ...base, reason: secretFile ? 'server-secret-file' : 'profile', meta: { profile: eff.profileName, rank: eff.rank } },
      `tool.${allowed ? 'allow' : 'deny'}|${sessionId ?? ''}|${tool}|${eff.role}`);
    } catch (e: any) { log.error(`[security] tool audit failed: ${e.message}`); }
    if (allowed) return { allow: true };
    log.log(`[security] Denied ${tool} for ${principal.id} (role=${eff.role} profile=${eff.profileName}${secretFile ? ' server-secret-file' : ''}) session=${sessionId ?? 'new'}`);
    const hint = allowsEscalate(eff.profile) ? ` Use the ${ESCALATE_TOOL} tool to hand this request to an owner.` : '';
    return { allow: false, message: secretFile ? 'Server credential files are not accessible.' : `Tool ${tool} is not available to role "${eff.role}" in this session.${hint}` };
  }

  /** PreToolUse hook: the gate on every call, including auto-approved (`allowedTools`) tools. */
  public hook(): HookCallback {
    return async (input) => {
      if (input.hook_event_name !== 'PreToolUse') return {};
      const { tool_name, tool_input } = input as PreToolUseHookInput;
      const r = this.check(tool_name, (tool_input ?? {}) as Record<string, unknown>);
      if (r.allow) return {};
      return { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: r.message } };
    };
  }
}
