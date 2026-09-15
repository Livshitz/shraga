// Claude Code subscription usage, read from Anthropic's OAuth usage endpoint using the credentials
// the Claude Code CLI maintains on this box. Fails CLOSED: every error path returns null, and the
// caller renders nothing — a broken or zeroed gauge is worse than no gauge.
import { execFile } from 'node:child_process';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { dataPath } from './paths.ts';

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

/** A Claude login's identity — safe to persist and show (no secrets). */
export interface ClaudeLoginIdentity {
  email: string;
  /** `subscriptionType` from the login's credentials (e.g. `pro`, `max`); omitted when unknown. */
  plan?: string;
}

export interface ClaudeUsage {
  subscriptionType: string | null;
  /** Which Claude account these numbers belong to (email, else display name). A box can be signed in
   *  as somebody other than the person reading the gauge — say whose quota this is. */
  account: string | null;
  limits: ClaudeUsageLimit[];
  /** When these numbers were actually read from upstream (ISO). The client labels the gauge with it. */
  fetchedAt: string;
  /** True when this is the last known-good reading being served because the current attempt failed
   *  (429 cooldown, 403, network). The gauge stays VISIBLE and says how old it is. */
  stale?: boolean;
  /** Why the last refresh failed, in words (e.g. "rate limited by the usage endpoint (429)"). Set only
   *  alongside `stale` — a multi-day-old reading must say WHY it is old, not just that it is. */
  error?: string;
  /** When the next upstream attempt is due (ISO), if the failure told us (Retry-After / cooldown). */
  retryAt?: string;
}

/** The subset of the Agent SDK's `rate_limit_event.rate_limit_info` we consume. Observed live: it
 *  carries status/resetsAt/rateLimitType but NO utilization while allowed — so it can only ever say
 *  "this window is exhausted", never a percentage. That is exactly the reading the throttled usage
 *  endpoint fails to deliver when it matters most (the account at its limit). */
export interface RateLimitInfo {
  status: string;
  resetsAt?: number;
  rateLimitType?: string;
}

/** SDK rateLimitType -> the usage endpoint's window, so an exhausted window lands on the row it is. */
const RATE_LIMIT_WINDOW: Record<string, { kind: string; group: string; scopeLabel?: string }> = {
  five_hour: { kind: 'session', group: 'session' },
  seven_day: { kind: 'weekly_all', group: 'weekly' },
  seven_day_opus: { kind: 'weekly_scoped', group: 'weekly', scopeLabel: 'Opus' },
  seven_day_sonnet: { kind: 'weekly_scoped', group: 'weekly', scopeLabel: 'Sonnet' },
};

export class ClaudeUsageOptions {
  credentialsPath = path.join(homedir(), '.claude', '.credentials.json');
  endpoint = 'https://api.anthropic.com/api/oauth/usage';
  /** Claude Code's own config, the only place the signed-in account's identity is written. */
  accountPath = path.join(homedir(), '.claude.json');
  /** How long a completed upstream result (success OR failure) is reused for. Concurrent callers are
   *  deduped separately onto one in-flight request, so a reload storm or a wall of open tabs costs at
   *  most one upstream call per window — this endpoint answers 429 aggressively. Failures are cached
   *  on the same terms, so a 403/API-key box does not retry on every client poll. */
  ttlMs = 300_000;
  timeoutMs = 8_000;
  /** A 429 is not a transient blip here: retrying it on the ordinary TTL is what keeps a box wedged in
   *  the penalty box all day (25 straight 429s on prod). Each consecutive 429 climbs this ladder and a
   *  success drops back to the first rung; a `Retry-After` header wins over the rung when it is longer.
   *  Capped at 15m, not 30m: on a busy box (many CLI sessions sharing one account quota) upstream can
   *  answer 429 for hours with a ~73s Retry-After, and every attempt is a chance at the first reading
   *  that unhides the gauge. A failed attempt no longer costs the user anything — the last known-good
   *  reading stays on screen — so a slightly shorter ceiling is the better trade. */
  rateLimitBackoffMs = [60_000, 300_000, 600_000, 900_000];
  /** macOS stores Claude Code's OAuth credentials in the login Keychain and writes NO credentials
   *  file, so on darwin an absent file is not proof of an API-key deployment — we look there second.
   *  Linux keeps the file as the only source; we never shell out there. */
  platform: string = process.platform;
  /** Claude Code writes its OAuth blob under this service — but NEWER CLIs suffix it per profile
   *  (`Claude Code-credentials-<hash>`), leaving the bare name holding only mcpOAuth. Reading just the
   *  bare name is why the gauge silently vanished on an otherwise healthy box, so we enumerate. */
  keychainService = 'Claude Code-credentials';
  /** A locked keychain can block (or prompt) indefinitely — never let that stall a client poll. */
  keychainTimeoutMs = 3_000;
  /** Where the last known-good reading is mirrored, so a restart (deploy, self-upgrade) does not
   *  blank the gauge on a box whose upstream is rate-limited for the next hour. Identity + percentages
   *  only — never a token. */
  cachePath = dataPath('claude-usage-last.json');
  /** Seam: hands back the raw secret string, or null on ANY failure. Tests inject here so the suite
   *  never shells out to the real `security` binary. */
  readKeychain: (options: ClaudeUsageOptions) => Promise<string | null> = readKeychainSecret;
}

/** `security` writes the secret to stdout with -w. The value is never logged or returned upward;
 *  only the parsed, scope-gated accessToken leaves this module. */
async function readKeychainSecret(options: ClaudeUsageOptions): Promise<string | null> {
  for (const service of await keychainServices(options)) {
    try {
      const { stdout } = await execFileAsync('security', ['find-generic-password', '-s', service, '-w'], {
        timeout: options.keychainTimeoutMs,
        killSignal: 'SIGKILL',
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
      });
      const raw = stdout.trim();
      // The bare service often exists but holds only mcpOAuth — keep looking rather than failing here.
      if (raw && hasOauthToken(raw)) return raw;
    } catch (err) {
      // Missing binary, non-zero exit (no such item), locked keychain, timeout — all the same answer.
      console.debug(`${TAG} keychain lookup failed for "${service}": ${(err as Error).message}`);
    }
  }
  return null;
}

function hasOauthToken(raw: string): boolean {
  try {
    return typeof JSON.parse(raw)?.claudeAiOauth?.accessToken === 'string';
  } catch {
    return false;
  }
}

/** The bare service first (cheap, the common case), then any `<service>-<suffix>` items the keychain
 *  actually holds. `dump-keychain` without -d lists ATTRIBUTES only — no secrets, and no prompt. */
async function keychainServices(options: ClaudeUsageOptions): Promise<string[]> {
  const services = [options.keychainService];
  try {
    const { stdout } = await execFileAsync('security', ['dump-keychain'], {
      timeout: options.keychainTimeoutMs,
      killSignal: 'SIGKILL',
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    const re = new RegExp(`"svce"<blob>="(${escapeRe(options.keychainService)}[^"]*)"`, 'g');
    for (const m of stdout.matchAll(re)) if (!services.includes(m[1])) services.push(m[1]);
  } catch (err) {
    console.debug(`${TAG} keychain enumeration failed: ${(err as Error).message}`);
  }
  return services;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class ClaudeUsageReader {
  public options: ClaudeUsageOptions;
  private cache: { at: number; value: ClaudeUsage | null } | null = null;
  /** The one upstream request currently in flight, shared by every caller that arrives while it runs.
   *  Without this the TTL is useless against a stampede: the cache is only written once the request
   *  RESOLVES, so N simultaneous callers all miss and all hit upstream. */
  private inflight: Promise<ClaudeUsage | null> | null = null;
  /** While set in the future, `get()` answers null WITHOUT touching upstream — see rateLimitBackoffMs. */
  private cooldownUntil = 0;
  private rateLimitStreak = 0;
  /** The last reading that actually came back from upstream. Once we have proven this box IS on a
   *  subscription, a later failure (429 cooldown, 403, network blip) must NOT make the gauge vanish —
   *  a widget that flickers in and out reads as a bug. We keep serving this, flagged `stale`, and the
   *  client shows how old it is. Only a box that never had a good reading answers null. */
  private lastGood: { at: number; value: ClaudeUsage } | null = null;
  /** One-shot rehydrate of `lastGood` from disk, awaited by the first get(). */
  private restored: Promise<void> | null = null;
  /** Why the most recent upstream attempt failed; cleared by a success. Surfaced on stale readings. */
  private lastError: { reason: string; retryAt?: number } | null = null;
  /** Latest exhausted windows reported by the agent's own inference calls (SDK rate_limit_event). */
  private exhausted = new Map<string, number>();

  public constructor(options?: Partial<ClaudeUsageOptions>) {
    this.options = { ...new ClaudeUsageOptions(), ...options };
  }

  /** null => this box is not on a Claude subscription, or we could not prove that it ever was. */
  async get(): Promise<ClaudeUsage | null> {
    return this.overlay(await this.read());
  }

  /** Fed from every agent turn's `rate_limit_event`. Costs zero upstream calls. 'rejected' marks the
   *  window exhausted until its reset; any other status for that window clears the mark. */
  observeRateLimit(info: RateLimitInfo | null | undefined) {
    const type = info?.rateLimitType;
    if (!type || !RATE_LIMIT_WINDOW[type]) return;
    if (info.status === 'rejected' && typeof info.resetsAt === 'number') {
      if (!this.exhausted.has(type)) console.warn(`${TAG} agent reports ${type} limit reached; resets ${new Date(info.resetsAt * 1000).toISOString()}`);
      this.exhausted.set(type, info.resetsAt * 1000);
    } else {
      this.exhausted.delete(type);
    }
  }

  /** Paint any window the agent has PROVEN exhausted at 100% over whatever the endpoint last said —
   *  the endpoint's reading may be days old. Never conjures a gauge for a box with no reading. */
  private overlay(usage: ClaudeUsage | null): ClaudeUsage | null {
    if (!usage || !this.exhausted.size) return usage;
    const now = Date.now();
    const limits = [...usage.limits];
    for (const [type, resetsAtMs] of this.exhausted) {
      if (resetsAtMs <= now) { this.exhausted.delete(type); continue; }
      const w = RATE_LIMIT_WINDOW[type];
      const hit = { ...w, percent: 100, severity: 'exceeded', resetsAt: new Date(resetsAtMs).toISOString() };
      const i = limits.findIndex(l => l.kind === w.kind && (!w.scopeLabel || l.scopeLabel === w.scopeLabel));
      if (i >= 0) limits[i] = { ...limits[i], ...hit, scopeLabel: limits[i].scopeLabel ?? w.scopeLabel };
      else limits.push(hit);
    }
    return { ...usage, limits };
  }

  /** The login changed (connect/replace/disconnect): every cached or persisted reading describes the
   *  OLD account, so drop them all and let the next poll read the new one. */
  invalidate(): void {
    this.cache = null;
    this.identityCache = null;
    this.lastGood = null;
    this.cooldownUntil = 0;
    this.restored = Promise.resolve();
    rm(this.options.cachePath, { force: true }).catch((err: Error) => console.warn(`${TAG} could not drop cached reading:`, err.message));
  }

  private async read(): Promise<ClaudeUsage | null> {
    await (this.restored ??= this.restore());
    const now = Date.now();
    if (now < this.cooldownUntil) return this.stale();
    if (this.cache && now - this.cache.at < this.options.ttlMs) return this.cache.value ?? this.stale();
    if (this.inflight) return this.inflight;
    // Clear inflight before the value is handed out, so a rejection can never wedge the reader:
    // the next call past the TTL starts a fresh request.
    this.inflight = this.fetchUsage()
      .then((value) => {
        const at = Date.now();
        const stamped = value ? { ...value, fetchedAt: new Date(at).toISOString() } : null;
        this.cache = { at, value: stamped };
        if (stamped) { this.lastGood = { at, value: stamped }; void this.persist(this.lastGood); }
        return stamped ?? this.stale();
      })
      .finally(() => { this.inflight = null; });
    return this.inflight;
  }

  /** Rehydrate the last reading a previous process wrote. Never throws: a missing or corrupt file
   *  just means we start with nothing, exactly as before. */
  private async restore(): Promise<void> {
    try {
      const saved = JSON.parse(await readFile(this.options.cachePath, 'utf8'));
      if (Array.isArray(saved?.value?.limits) && saved.value.limits.length && typeof saved.at === 'number') {
        this.lastGood = { at: saved.at, value: saved.value };
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') console.debug(`${TAG} could not restore the last reading: ${(err as Error).message}`);
    }
  }

  /** Mirror a fresh reading to disk. Best-effort — a write failure must never break the response. */
  private async persist(entry: { at: number; value: ClaudeUsage }) {
    try {
      await writeFile(this.options.cachePath, JSON.stringify(entry));
    } catch (err) {
      console.debug(`${TAG} could not persist the last reading: ${(err as Error).message}`);
    }
  }

  /** Last known-good reading, marked stale. Never invents numbers — null when we never had any. */
  private stale(): ClaudeUsage | null {
    if (!this.lastGood) return null;
    const err = this.lastError;
    return {
      ...this.lastGood.value,
      stale: true,
      error: err?.reason ?? 'refresh failed (no detail recorded)',
      ...(err?.retryAt ? { retryAt: new Date(err.retryAt).toISOString() } : {}),
    };
  }

  private fail(reason: string, retryAt?: number): null {
    this.lastError = { reason, retryAt };
    return null;
  }

  private async fetchUsage(): Promise<Omit<ClaudeUsage, 'fetchedAt'> | null> {
    const creds = await this.readCredentials();
    if (!creds) return this.fail('no usable Claude OAuth credentials on this box');
    // Only the Claude Code CLI refreshes this token (it does so when the agent runs). An expired one
    // is a guaranteed 401 — prod logged 33 in a row overnight — so skip the call and say so instead.
    if (creds.expiresAt !== null && creds.expiresAt <= Date.now()) {
      const at = new Date(creds.expiresAt).toISOString();
      console.warn(`${TAG} oauth token expired at ${at}; skipping upstream until Claude Code refreshes it`);
      return this.fail(`OAuth token expired at ${at} — refreshes on the next agent run`);
    }

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
      if (res.status === 429) {
        // The reason lives in the BODY, not the status: "too many requests" (our own poll rate) and
        // an account/org-level throttle read identically from the outside, and only the first one is
        // ours to fix. Backing off blind once cost a day of a hidden gauge, so surface it.
        const detail = await describeError(res);
        return this.fail(`usage endpoint rate-limited this account (429): ${detail}`, this.enterCooldown(res.headers.get('retry-after'), detail));
      }
      if (!res.ok) {
        const detail = await describeError(res);
        console.warn(`${TAG} usage endpoint returned ${res.status}; hiding widget — ${detail}`);
        return this.fail(`usage endpoint returned ${res.status}: ${detail}`);
      }
      const body: any = await res.json();
      const limits = Array.isArray(body?.limits) ? body.limits.map(toLimit).filter(Boolean) as ClaudeUsageLimit[] : [];
      if (!limits.length) {
        console.warn(`${TAG} usage response carried no limits[]; hiding widget`);
        return this.fail('usage endpoint answered with no limits');
      }
      this.rateLimitStreak = 0;
      this.lastError = null;
      return { subscriptionType: creds.subscriptionType, account: await this.readAccount(), limits };
    } catch (err) {
      console.warn(`${TAG} usage lookup failed:`, (err as Error).message);
      return this.fail(`usage lookup failed: ${(err as Error).message}`);
    }
  }

  /** Climb the backoff ladder one rung per consecutive 429, capped at the last rung. `Retry-After`
   *  (seconds, or an HTTP-date) only ever EXTENDS the wait — never shortens the rung we earned. */
  private enterCooldown(retryAfter: string | null, detail: string): number {
    const ladder = this.options.rateLimitBackoffMs;
    const rung = ladder[Math.min(this.rateLimitStreak, ladder.length - 1)] ?? 60_000;
    this.rateLimitStreak++;
    const hinted = parseRetryAfter(retryAfter);
    const waitMs = Math.max(rung, hinted ?? 0);
    this.cooldownUntil = Date.now() + waitMs;
    console.warn(
      `${TAG} usage endpoint returned 429 (ua=claude-code/${claudeCodeVersion()}, retry-after=${retryAfter ?? 'none'}); ` +
      `hiding widget and backing off ${Math.round(waitMs / 1000)}s — ${detail}`,
    );
    return this.cooldownUntil;
  }

  /** Re-read per poll from whichever source holds them — the token lives ~8h and Claude Code
   *  refreshes it in place, so nothing here may be cached in a field. Files first, Keychain second.
   *  Neither source is a single fixed name any more: newer CLIs write a per-profile SUFFIX
   *  (`.credentials-<hash>.json`, `Claude Code-credentials-<hash>`) and leave the bare name holding
   *  non-OAuth data, so we try every candidate before concluding "no subscription". */
  private async readCredentials(): Promise<Credentials | null> {
    for (const file of await this.credentialFiles()) {
      try {
        const creds = parseCredentials(await readFile(file, 'utf8'), `credentials file ${path.basename(file)}`);
        if (creds) return creds;
      } catch (err) {
        // ENOENT is the ordinary API-key deployment on Linux, not a fault — keep it quiet at debug level.
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') console.debug(`${TAG} no credentials file at ${file}`);
        else console.warn(`${TAG} could not read ${file}:`, (err as Error).message);
      }
    }

    if (this.options.platform !== 'darwin') return null;
    // The seam is contractually fail-closed, but readCredentials runs OUTSIDE fetchUsage's try —
    // an unexpected rejection here would surface as a 500 rather than a hidden widget.
    const secret = await this.options.readKeychain(this.options).catch((err: Error) => {
      console.warn(`${TAG} keychain reader threw:`, err.message);
      return null;
    });
    if (!secret) {
      console.debug(`${TAG} keychain held no "${this.options.keychainService}*" secret (API-key deployment)`);
      return null;
    }
    return parseCredentials(secret, 'keychain');
  }

  /** Whose account this box is signed in as. Identity only — never a token, and never fatal: an
   *  unreadable config just means the card omits the line. */
  private async readAccount(): Promise<string | null> {
    const account = await this.readOauthAccount();
    return account?.emailAddress ?? account?.displayName ?? null;
  }

  private async readOauthAccount(): Promise<{ emailAddress?: string; displayName?: string } | null> {
    try {
      return JSON.parse(await readFile(this.options.accountPath, 'utf8'))?.oauthAccount ?? null;
    } catch (err) {
      console.debug(`${TAG} could not read the signed-in account: ${(err as Error).message}`);
      return null;
    }
  }

  private identityCache: { at: number; value: Promise<ClaudeLoginIdentity | null> } | null = null;

  /** Which login this reader's dir is signed in as: email + plan, never a token. Local files only
   *  (no upstream call); cached for `ttlMs` because on darwin the plan lookup may shell out to the
   *  keychain, and it is asked once per agent turn. null when no email is recorded. */
  identity(): Promise<ClaudeLoginIdentity | null> {
    const now = Date.now();
    if (this.identityCache && now - this.identityCache.at < this.options.ttlMs) return this.identityCache.value;
    const value = Promise.all([this.readOauthAccount(), this.readCredentials()]).then(([account, creds]) => {
      const email = account?.emailAddress?.trim();
      if (!email) return null;
      return creds?.subscriptionType ? { email, plan: creds.subscriptionType } : { email };
    }).catch((err: Error) => {
      console.warn(`${TAG} could not resolve the signed-in identity:`, err.message);
      return null;
    });
    this.identityCache = { at: now, value };
    return value;
  }

  /** The configured path first, then any sibling `.credentials*.json` the CLI may have written. */
  private async credentialFiles(): Promise<string[]> {
    const configured = this.options.credentialsPath;
    const files = [configured];
    const base = path.basename(configured).replace(/\.json$/, '');
    try {
      for (const name of await readdir(path.dirname(configured))) {
        const full = path.join(path.dirname(configured), name);
        if (name.startsWith(base) && name.endsWith('.json') && !files.includes(full)) files.push(full);
      }
    } catch (err) {
      console.debug(`${TAG} could not scan for sibling credential files: ${(err as Error).message}`);
    }
    return files;
  }
}

/** The ONE gate, shared by both sources: a usable accessToken carrying user:profile. Never throws —
 *  every rejection is a logged null, i.e. hidden widget and zero upstream calls. */
interface Credentials { accessToken: string; subscriptionType: string | null; expiresAt: number | null }

function parseCredentials(raw: string, source: string): Credentials | null {
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
  return { accessToken: oauth.accessToken, subscriptionType: oauth.subscriptionType ?? null,
    expiresAt: typeof oauth.expiresAt === 'number' && Number.isFinite(oauth.expiresAt) ? oauth.expiresAt : null };
}

/** Anthropic answers errors as `{ error: { type, message } }`. Never throws and never returns more
 *  than a line: this only ever lands in a log, next to a status we already decided to fail on. */
async function describeError(res: Response): Promise<string> {
  try {
    const raw = (await res.text()).slice(0, 300);
    const parsed = JSON.parse(raw)?.error;
    return parsed?.message ? `${parsed.type ?? 'error'}: ${parsed.message}` : raw || '(empty body)';
  } catch (err) {
    return `(unreadable body: ${(err as Error).message})`;
  }
}

/** `Retry-After` is either delta-seconds or an HTTP-date. Anything unparseable => no hint. */
function parseRetryAfter(raw: string | null): number | null {
  if (!raw) return null;
  const secs = Number(raw.trim());
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const at = Date.parse(raw);
  if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
  return null;
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
/** The UA this endpoint gates on is the Claude Code CLI's, and prod proved the gate is real: we were
 *  sending `claude-code/0.2.141` — the AGENT SDK's version, which is not a Claude Code version at all
 *  (those are 2.x) — and drew a sustained rate_limit_error with ~40min Retry-Afters. Read the CLI's
 *  own package when it is installed; otherwise send a plausible CURRENT version, never the SDK's. */
const FALLBACK_CLI_VERSION = '2.0.0';
function claudeCodeVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const require = createRequire(import.meta.url);
    const v = require('@anthropic-ai/claude-code/package.json').version;
    cachedVersion = typeof v === 'string' && /^\d+\./.test(v) ? v : FALLBACK_CLI_VERSION;
  } catch { cachedVersion = FALLBACK_CLI_VERSION; }
  return cachedVersion!;
}

export const claudeUsage = new ClaudeUsageReader();

const accountReaders = new Map<string, ClaudeUsageReader>();
/** The reader for a per-user Claude login dir (claude-account.ts), or the box default for null. One
 *  lazily-created reader per dir, so each account keeps its own cache, cooldown and rate-limit marks.
 *  The dir's own files are the ONLY source: the keychain enumeration picks the first OAuth item it
 *  finds, which on a shared box may be somebody else's login. The mirror lives inside the dir, which
 *  data-sync already ignores. */
export function claudeUsageFor(accountDir: string | null): ClaudeUsageReader {
  if (!accountDir) return claudeUsage;
  let reader = accountReaders.get(accountDir);
  if (!reader) {
    reader = new ClaudeUsageReader({
      credentialsPath: path.join(accountDir, '.credentials.json'),
      accountPath: path.join(accountDir, '.claude.json'),
      cachePath: path.join(accountDir, 'shraga-usage-last.json'),
      readKeychain: async () => null,
    });
    accountReaders.set(accountDir, reader);
  }
  return reader;
}
