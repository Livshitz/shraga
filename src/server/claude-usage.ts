// Claude Code subscription usage, read from Anthropic's OAuth usage endpoint using the credentials
// the Claude Code CLI maintains on this box. Fails CLOSED: every error path returns null, and the
// caller renders nothing — a broken or zeroed gauge is worse than no gauge.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const TAG = '[claude-usage]';

/** The endpoint gates on the OAuth token carrying this scope; without it it answers
 *  403 permission_error and the deployment is effectively API-key-only for our purposes. */
const REQUIRED_SCOPE = 'user:profile';

/** One limit window as the endpoint reports it. `resetsAt` is passed through verbatim: the caller
 *  derives any human label from it. NEVER label a `weekly_*` kind "weekly"/"7 days" — that window
 *  actually rolls on a ~72h cadence, so only resets_at tells the truth. */
export interface ClaudeUsageLimit {
  kind: string;
  group: string;
  percent: number;
  severity: string;
  resetsAt: string | null;
  /** Present on scoped limits, e.g. a per-model window. */
  scopeLabel?: string;
}

export interface ClaudeUsage {
  subscriptionType: string | null;
  limits: ClaudeUsageLimit[];
}

export class ClaudeUsageOptions {
  credentialsPath = path.join(homedir(), '.claude', '.credentials.json');
  endpoint = 'https://api.anthropic.com/api/oauth/usage';
  /** How long a completed upstream result (success OR failure) is reused for. Concurrent callers are
   *  deduped separately onto one in-flight request, so a reload storm or a wall of open tabs costs at
   *  most one upstream call per window — this endpoint answers 429 aggressively. Failures are cached
   *  on the same terms, so a 403/API-key box does not retry on every client poll. */
  ttlMs = 60_000;
  timeoutMs = 8_000;
  /** macOS stores Claude Code's OAuth credentials in the login Keychain and writes NO credentials
   *  file, so on darwin an absent file is not proof of an API-key deployment — we look there second.
   *  Linux keeps the file as the only source; we never shell out there. */
  platform: string = process.platform;
  keychainService = 'Claude Code-credentials';
  /** A locked keychain can block (or prompt) indefinitely — never let that stall a client poll. */
  keychainTimeoutMs = 3_000;
  /** Seam: hands back the raw secret string, or null on ANY failure. Tests inject here so the suite
   *  never shells out to the real `security` binary. */
  readKeychain: (options: ClaudeUsageOptions) => Promise<string | null> = readKeychainSecret;
}

/** `security` writes the secret to stdout with -w. The value is never logged or returned upward;
 *  only the parsed, scope-gated accessToken leaves this module. */
async function readKeychainSecret(options: ClaudeUsageOptions): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('security', ['find-generic-password', '-s', options.keychainService, '-w'], {
      timeout: options.keychainTimeoutMs,
      killSignal: 'SIGKILL',
      encoding: 'utf8',
    });
    return stdout.trim() || null;
  } catch (err) {
    // Missing binary, non-zero exit (no such item), locked keychain, timeout — all the same answer.
    console.debug(`${TAG} keychain lookup failed: ${(err as Error).message}`);
    return null;
  }
}

export class ClaudeUsageReader {
  public options: ClaudeUsageOptions;
  private cache: { at: number; value: ClaudeUsage | null } | null = null;
  /** The one upstream request currently in flight, shared by every caller that arrives while it runs.
   *  Without this the TTL is useless against a stampede: the cache is only written once the request
   *  RESOLVES, so N simultaneous callers all miss and all hit upstream. */
  private inflight: Promise<ClaudeUsage | null> | null = null;

  public constructor(options?: Partial<ClaudeUsageOptions>) {
    this.options = { ...new ClaudeUsageOptions(), ...options };
  }

  /** null => this box is not on a Claude subscription, or we could not prove that it is. */
  async get(): Promise<ClaudeUsage | null> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < this.options.ttlMs) return this.cache.value;
    if (this.inflight) return this.inflight;
    // Clear inflight before the value is handed out, so a rejection can never wedge the reader:
    // the next call past the TTL starts a fresh request.
    this.inflight = this.fetchUsage()
      .then((value) => { this.cache = { at: Date.now(), value }; return value; })
      .finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async fetchUsage(): Promise<ClaudeUsage | null> {
    const creds = await this.readCredentials();
    if (!creds) return null;

    try {
      const res = await fetch(this.options.endpoint, {
        headers: {
          Authorization: `Bearer ${creds.accessToken}`,
          'anthropic-beta': 'oauth-2025-04-20',
          // MANDATORY. Without a claude-code/<version> UA the endpoint drops us into an aggressively
          // rate-limited bucket and answers 429 persistently.
          'User-Agent': `claude-code/${claudeCodeVersion()}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
      if (!res.ok) {
        console.warn(`${TAG} usage endpoint returned ${res.status}; hiding widget`);
        return null;
      }
      const body: any = await res.json();
      const limits = Array.isArray(body?.limits) ? body.limits.map(toLimit).filter(Boolean) as ClaudeUsageLimit[] : [];
      if (!limits.length) {
        console.warn(`${TAG} usage response carried no limits[]; hiding widget`);
        return null;
      }
      return { subscriptionType: creds.subscriptionType, limits };
    } catch (err) {
      console.warn(`${TAG} usage lookup failed:`, (err as Error).message);
      return null;
    }
  }

  /** Re-read per poll from whichever source holds them — the token lives ~8h and Claude Code
   *  refreshes it in place, so nothing here may be cached in a field. File first, Keychain second. */
  private async readCredentials(): Promise<{ accessToken: string; subscriptionType: string | null } | null> {
    let fileAbsent = false;
    try {
      return parseCredentials(await readFile(this.options.credentialsPath, 'utf8'), 'credentials file');
    } catch (err) {
      // ENOENT is the ordinary API-key deployment on Linux, not a fault — keep it quiet at debug level.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        fileAbsent = true;
        console.debug(`${TAG} no credentials file at ${this.options.credentialsPath}`);
      } else {
        console.warn(`${TAG} could not read credentials:`, (err as Error).message);
      }
    }

    if (!fileAbsent || this.options.platform !== 'darwin') return null;
    // The seam is contractually fail-closed, but readCredentials runs OUTSIDE fetchUsage's try —
    // an unexpected rejection here would surface as a 500 rather than a hidden widget.
    const secret = await this.options.readKeychain(this.options).catch((err: Error) => {
      console.warn(`${TAG} keychain reader threw:`, err.message);
      return null;
    });
    if (!secret) {
      console.debug(`${TAG} keychain held no "${this.options.keychainService}" secret (API-key deployment)`);
      return null;
    }
    return parseCredentials(secret, 'keychain');
  }
}

/** The ONE gate, shared by both sources: a usable accessToken carrying user:profile. Never throws —
 *  every rejection is a logged null, i.e. hidden widget and zero upstream calls. */
function parseCredentials(raw: string, source: string): { accessToken: string; subscriptionType: string | null } | null {
  let oauth: any;
  try {
    oauth = JSON.parse(raw)?.claudeAiOauth;
  } catch {
    console.warn(`${TAG} ${source} did not hold valid JSON; hiding widget`);
    return null;
  }
  if (!oauth?.accessToken || typeof oauth.accessToken !== 'string') {
    console.debug(`${TAG} ${source} carried no claudeAiOauth accessToken; hiding widget`);
    return null;
  }
  if (!Array.isArray(oauth.scopes) || !oauth.scopes.includes(REQUIRED_SCOPE)) {
    console.warn(`${TAG} oauth token lacks the ${REQUIRED_SCOPE} scope; hiding widget`);
    return null;
  }
  return { accessToken: oauth.accessToken, subscriptionType: oauth.subscriptionType ?? null };
}

function toLimit(l: any): ClaudeUsageLimit | null {
  if (!l || typeof l.percent !== 'number' || !Number.isFinite(l.percent)) return null;
  return {
    kind: String(l.kind ?? 'unknown'),
    group: String(l.group ?? 'unknown'),
    percent: Math.max(0, Math.min(100, Math.round(l.percent))),
    severity: String(l.severity ?? 'normal'),
    resetsAt: typeof l.resets_at === 'string' ? l.resets_at : null,
    scopeLabel: l.scope?.model?.display_name ?? undefined,
  };
}

let cachedVersion: string | null = null;
/** Best effort — the endpoint gates on the `claude-code/` PREFIX, not the exact number, so a stale
 *  fallback still keeps us out of the throttled bucket. */
function claudeCodeVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const require = createRequire(import.meta.url);
    cachedVersion = require('@anthropic-ai/claude-agent-sdk/package.json').version || '2.0.0';
  } catch { cachedVersion = '2.0.0'; }
  return cachedVersion!;
}

export const claudeUsage = new ClaudeUsageReader();
