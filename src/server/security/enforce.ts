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
// - secret files: a GUARANTEE only for restricted profiles (no Bash, no Grep, path-checked file tools). For full
//   profiles (owner/operator) it is BEST-EFFORT: they have Bash, which reads any file, and the engine's legacy
//   SENSITIVE_BASH_PATTERNS sit in canUseTool, which auto-approved Bash never reaches. OS-level isolation is plan step 8.
import type { HookCallback, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
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

/** Never available to a restricted (non-`*`) profile, even when listed: Bash runs anything, and Grep reads the
 *  contents of every file it opens, so neither can be gated per file (see Secret paths). */
const FULL_ONLY_TOOLS = new Set(['Bash', 'Grep']);

/** Built-in tools the profile makes available: `'all'` for `*`, else its names minus escalate/MCP ids/full-only tools. */
export function builtinTools(p: Pick<Profile, 'tools' | 'mcps'>): 'all' | string[] {
  if (p.tools.includes('*')) return 'all';
  const names = p.tools.filter(t => t !== ESCALATE_TOOL && !t.startsWith('mcp__') && !FULL_ONLY_TOOLS.has(t));
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

// ── Secret paths ─────────────────────────────────────────────────────────────
// What each profile class is promised:
// - RESTRICTED (tools without `*`): a guarantee. No Bash/Grep (FULL_ONLY_TOOLS); every file tool's path is matched
//   literally and by realpath; nothing under /proc or /sys; Glob only inside the workspace root, and it lists names only
//   (contents stay behind the Read gate).
// - FULL (owner/operator): best-effort. Bash is auto-approved before canUseTool, so no path deny here (nor the engine's
//   SENSITIVE_BASH_PATTERNS) can stop `cat .env`; the file-tool deny stops accidents. Plan step 8 is the OS-level fix.
// The SDK skips canUseTool for auto-approved Read/Glob too, so TurnGuard.check (PreToolUse hook) is the gate that holds.
//
// Two lists. SENSITIVE_PATH_PATTERNS is the pre-enforcement list, used VERBATIM by the engine's canUseTool when the flag
// is OFF (snapshot-tested). SECRET_PATH_PATTERNS is the enforcement list: real secret files only, so owners can still
// work on `.env.example`, `claude-credentials.ts`, `docs/secrets/` or `*.env.ts`.
export const SENSITIVE_PATH_PATTERNS: readonly RegExp[] = [
  /\.env($|\.)/i, /secrets?\//i, /credentials/i, /\.pem$/i, /\.key$/i,
  /service.account.*\.json/i, /\/\.claude\/credentials/i,
];
const SERVER_SECRET_NAMES = ['.internal-token', '.mcp-oauth-secret', '.local-auth-secret', 'api-keys.json', 'oauth-clients.json', 'users.json']
  .map(n => n.replace(/[.]/g, '\\.')).join('|');
export const SECRET_PATH_PATTERNS: readonly RegExp[] = [
  /(?:^|\/)\.env(?:\.(?!(?:example|sample|template)$)[^/]+)?$/i, // .env, .env.local — not .env.example/.sample/.template
  /(?:^|\/)\.credentials\.json$/i, // Claude CLI OAuth: ~/.claude/, workspace/users/*/.claude/
  /\.(?:pem|key)$/i,
  /(?:^|\/)[^/]*service[-_.]?account[^/]*\.json$/i,
  new RegExp(`(?:^|/)(?:${SERVER_SECRET_NAMES})$`, 'i'),
  /(?:^|\/)shraga-mcp-[^/]*(?:\/|$)/i, // engine/mcp-config-file.ts mkdtemp dir: another turn's MCP servers + their env
  /^\/proc\/.+\/environ$/, // any process/task env, e.g. /proc/1/task/1/environ
];
/** Restricted profiles: all kernel pseudo-files (environ, cmdline, mem, …), not just environ. */
const SYSTEM_PATH_RE = /^\/(?:proc|sys)(?:\/|$)/;
/** Bash (full profiles only): server credential file names as command words. Best-effort, see above. */
const SECRET_FILE_CMD_RE = new RegExp(`(?:^|[\\s/'"=])(?:${SERVER_SECRET_NAMES})(?:$|[\\s'";|&)])`, 'i');
const GLOB_CHAR = /[*?[\]{}]/;

/** The literal path, its absolute form, and its realpath (deepest existing ancestor resolved, the rest re-appended). */
function pathForms(p: string, cwd: string): string[] {
  const abs = path.resolve(cwd, p.startsWith('~/') ? path.join(homedir(), p.slice(2)) : p);
  const forms = [p, abs];
  for (let head = abs, tail = ''; ;) {
    try { forms.push(path.join(realpathSync(head), tail)); break; } catch { /* not there yet: resolve the parent */ }
    const parent = path.dirname(head);
    if (parent === head) break;
    tail = path.join(path.basename(head), tail);
    head = parent;
  }
  return forms;
}

/** A glob's search base: the pattern joined to its root, cut at the first wildcard segment. */
function globBase(pattern: string, root: string | undefined): { joined: string; prefix: string; rest: string } {
  const joined = root && !path.isAbsolute(pattern) ? path.join(root, pattern) : pattern;
  const segs = joined.split('/');
  const i = segs.findIndex(s => GLOB_CHAR.test(s));
  if (i < 0) return { joined, prefix: joined, rest: '' };
  return { joined, prefix: segs.slice(0, i).join('/') || (joined.startsWith('/') ? '/' : '.'), rest: segs.slice(i).join('/') };
}

/** Glob forms: literal, joined, realpath'd base + rest, and a "de-wildcarded" copy of each so `**\/.env*` reads as the
 *  `.env` it targets. A wildcard at a segment START becomes `x` (`*.env.ts` is `x.env.ts`, not the dotfile);
 *  elsewhere it is dropped; `[ab]` becomes its first char. */
function globForms(pattern: string, root: string | undefined, cwd: string): string[] {
  const { joined, prefix, rest } = globBase(pattern, root);
  const forms = rest ? [pattern, joined, ...pathForms(prefix, cwd).map(f => path.join(f, rest))] : pathForms(joined, cwd);
  const plain = (f: string) => f.replace(/\[!?([^\]])[^\]]*\]/g, '$1').replace(/(^|\/)[*?]+/g, '$1x').replace(/[*?]+/g, '');
  return [...forms, ...forms.map(plain)];
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

/** Would this call read/write/list a secret path? File tools match literal + realpath; Glob/Grep match their search root
 *  and filename pattern (Grep's `pattern` is a content regex, not a path). `restricted` adds /proc and /sys. Bash: server
 *  credential file names only — best-effort, a full profile's Bash can always reach a file some other way. */
export function touchesSecretPath(tool: string, input: Record<string, unknown>, cwd: string = process.cwd(), restricted = false): boolean {
  if (tool === 'Bash') return SECRET_FILE_CMD_RE.test(String(input.command ?? ''));
  const secret = (forms: string[]) => forms.some(f => SECRET_PATH_PATTERNS.some(re => re.test(f)) || (restricted && SYSTEM_PATH_RE.test(f)));
  const root = str(input.path);
  const pattern = tool === 'Glob' ? str(input.pattern) : tool === 'Grep' ? str(input.glob) : undefined;
  if (pattern && secret(globForms(pattern, root, cwd))) return true;
  return [str(input.file_path), str(input.notebook_path), root].some(p => p !== undefined && secret(pathForms(p, cwd)));
}

/** Restricted profiles: does this Glob search outside the workspace root (`cwd`)? Its base is realpath-checked; any
 *  `..` segment in the pattern counts as outside. */
export function globOutsideWorkspace(input: Record<string, unknown>, cwd: string = process.cwd()): boolean {
  const pattern = str(input.pattern) ?? '';
  if (pattern.split('/').includes('..')) return true;
  const real = (p: string) => pathForms(p, cwd).at(-1)!;
  const ws = real(cwd);
  const base = real(globBase(pattern, str(input.path) ?? cwd).prefix);
  return base !== ws && !base.startsWith(ws.endsWith(path.sep) ? ws : ws + path.sep);
}

// ── Turn guard ───────────────────────────────────────────────────────────────

export type GateResult = { allow: true } | { allow: false; message: string };

export class TurnGuardOptions {
  runtime!: SecurityRuntime;
  principal!: Principal;
  sessionId?: string;
  /** The caller's own role/rank at turn start (SecurityRuntime.decide → resolvePrincipal, the single resolution path). */
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

  /** Gate one tool call. Audits tool.allow / tool.deny (deduped per session+tool+role per window). Never throws.
   *  `cwd` is the workspace root: it resolves relative paths and bounds a restricted Glob (the hook passes the CLI's). */
  public check(tool: string, input: Record<string, unknown> = {}, cwd?: string): GateResult {
    const { runtime, principal, sessionId, log } = this.options;
    let eff: Resolved;
    try { eff = this.current(); } catch (e: any) {
      log.error(`[security] effective-role lookup failed — denying ${tool}: ${e.message}`);
      return { allow: false, message: 'Tool use is unavailable right now (security check failed).' };
    }
    const restricted = !eff.profile.tools.includes('*');
    const reason = touchesSecretPath(tool, input, cwd, restricted) ? 'secret-path'
      : !profileAllowsTool(eff.profile, tool) ? 'profile'
        : restricted && tool === 'Glob' && globOutsideWorkspace(input, cwd) ? 'outside-workspace' : undefined;
    const base = { principal: principal.id, role: eff.role, sessionId, target: tool };
    try {
      runtime.record(!reason
        ? { type: 'tool.allow', ...base }
        : { type: 'tool.deny', ...base, reason, meta: { profile: eff.profileName, rank: eff.rank } },
      `tool.${reason ? 'deny' : 'allow'}|${sessionId ?? ''}|${tool}|${eff.role}`);
    } catch (e: any) { log.error(`[security] tool audit failed: ${e.message}`); }
    if (!reason) return { allow: true };
    log.log(`[security] Denied ${tool} for ${principal.id} (role=${eff.role} profile=${eff.profileName} ${reason}) session=${sessionId ?? 'new'}`);
    if (reason === 'secret-path') return { allow: false, message: 'Credential and secret files are not accessible.' };
    if (reason === 'outside-workspace') return { allow: false, message: `Glob is limited to the workspace for role "${eff.role}".` };
    const hint = allowsEscalate(eff.profile) ? ` Use the ${ESCALATE_TOOL} tool to hand this request to an owner.` : '';
    return { allow: false, message: `Tool ${tool} is not available to role "${eff.role}" in this session.${hint}` };
  }

  /** PreToolUse hook: the gate on every call, including auto-approved (`allowedTools`) tools. */
  public hook(): HookCallback {
    return async (input) => {
      if (input.hook_event_name !== 'PreToolUse') return {};
      const { tool_name, tool_input } = input as PreToolUseHookInput;
      const r = this.check(tool_name, (tool_input ?? {}) as Record<string, unknown>, (input as PreToolUseHookInput).cwd || undefined);
      if (r.allow) return {};
      return { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: r.message } };
    };
  }
}
