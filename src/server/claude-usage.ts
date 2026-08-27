// Claude Code subscription usage, read from Anthropic's OAuth usage endpoint using the credentials
// the Claude Code CLI maintains on this box. Fails CLOSED: every error path returns null, and the
// caller renders nothing — a broken or zeroed gauge is worse than no gauge.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

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
    // Re-read the file EVERY time: accessToken lives ~8h and the Claude Code SDK rewrites this file
    // when it refreshes. A token cached in memory goes stale; a fresh file read never does.
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

  private async readCredentials(): Promise<{ accessToken: string; subscriptionType: string | null } | null> {
    try {
      const raw = await readFile(this.options.credentialsPath, 'utf8');
      const oauth = JSON.parse(raw)?.claudeAiOauth;
      if (!oauth?.accessToken || typeof oauth.accessToken !== 'string') return null;
      if (!Array.isArray(oauth.scopes) || !oauth.scopes.includes(REQUIRED_SCOPE)) {
        console.warn(`${TAG} oauth token lacks the ${REQUIRED_SCOPE} scope; hiding widget`);
        return null;
      }
      return { accessToken: oauth.accessToken, subscriptionType: oauth.subscriptionType ?? null };
    } catch (err) {
      // ENOENT is the ordinary API-key deployment, not a fault — keep it quiet at debug level.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') console.debug(`${TAG} no credentials file at ${this.options.credentialsPath} (API-key deployment)`);
      else console.warn(`${TAG} could not read credentials:`, (err as Error).message);
      return null;
    }
  }
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
