import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, cpSync, rmSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './paths.ts';
import { notifyOwners } from './notify-owners.ts';
import { runTextQuery } from './sdk-utils.ts';
import { GENESIS_HASH, readAuditHead } from './security/audit.ts';

const TAG = '[data-sync]';
const DEPLOYMENT_ID_FILE = '.deployment-id';
/** Tracked, append-only, single-writer (security/audit.ts): committed on every flush, never pulled over, never stashed. */
const AUDIT_DIR = 'audit';
const NOT_AUDIT = ['--', '.', `:(exclude)${AUDIT_DIR}`];

/** A git conflict-marker line (start or end of a hunk). */
const CONFLICT_MARKER = /^(<{7}|>{7}) /m;

/** How long the LLM commit-message call may take before we fall back (ms). */
const COMMIT_MSG_TIMEOUT_MS = 60_000;
/** Warn if the push latch has been held longer than this — the 2026-08 outage's signature was silence. */
const PUSHING_STUCK_MS = 5 * 60_000;
/** Largest file sync will commit. GitHub rejects >100MB, and packing multi-GB blobs OOM-killed the
 *  Circles box in a restart loop (2026-09-27: 8GB of raw Mixpanel exports auto-committed from workspace/). */
const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** A file list for an owner alert: the first `max`, then a count — a conflicted node_modules tree once made the
 *  unmerged alert a wall of hundreds of paths. The full list stays in the log and the alert fingerprint. */
export function listFiles(files: string[], max = 10): string {
  return files.length > max ? `${files.slice(0, max).join(', ')} … +${files.length - max} more` : files.join(', ');
}

/**
 * Reject after `ms` so a hung subprocess can't hold the push latch forever.
 * `onTimeout` runs on the timeout path only — use it to actually CANCEL the work
 * (Promise.race alone abandons it, which orphaned one `claude` subprocess per timeout).
 */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string, onTimeout?: () => void): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([
    p,
    new Promise<T>((_, rej) => { t = setTimeout(() => { try { onTimeout?.(); } catch { /* cancel is best-effort */ } rej(new Error(`${label} timed out after ${ms}ms`)); }, ms); }),
  ]).finally(() => clearTimeout(t!));
}

/** Deterministic, always-valid commit subject derived from the changed paths. */
export function fallbackCommitMessage(files: string[]): string {
  const names = files.filter(Boolean);
  if (!names.length) return 'sync: update agent data';
  const joined = `sync: ${names.join(', ')}`;
  if (joined.length <= 72) return joined;
  return `sync: ${names[0]} (+${names.length - 1} more)`.slice(0, 72);
}

// Only unambiguous "I'm about to explain" openers. Deliberately does NOT list common subject
// starters like "the diff"/"this change" — those swallowed legitimate subjects
// ("the diff view now renders inline"). Real prose is caught by the length guard below.
const PROSE_PREAMBLE = /^(looking at|here'?s|here is|sure|certainly|based on|i'?ll|okay)\b/i;

/**
 * Pull a real commit subject out of a model reply. Bug 2026-08-26: the raw reply went straight to
 * `git commit -m`, so a fence-only answer produced a commit literally titled "```".
 * Returns '' when nothing usable is there — callers must use fallbackCommitMessage().
 */
export function extractCommitSubject(raw: string): string {
  if (!raw) return '';
  // Prefer the body of a fenced block if the model wrapped its answer in one.
  const fenced = raw.match(/```[a-zA-Z]*\n([\s\S]*?)```/);
  const body = fenced ? fenced[1] : raw.replace(/```[a-zA-Z]*/g, '');
  for (const rawLine of body.split('\n')) {
    let line = rawLine.trim();
    if (!line) continue;
    line = line.replace(/^(?:[-*>#]+|\d+[.)])\s*/, '').trim(); // bullets / numbered list / headings / quotes
    line = line.replace(/^`+|`+$/g, '').trim();              // inline code ticks
    line = line.replace(/^["'](.*)["']$/, '$1').trim();      // wrapping quotes
    if (!line || /^`+$/.test(line) || line.includes('```')) continue;
    if (line.length < 3) continue;
    if (PROSE_PREAMBLE.test(line)) return '';                // model explained instead of answering
    if (line.endsWith(':')) return '';                       // "Commit message:" style preamble
    if (line.length > 72) return '';                         // longer than a subject line -> prose, never truncate
    return line.slice(0, 72).trim();
  }
  return '';
}

/** Paths that are REWRITTEN or discarded by design: per-run worker logs, per-run task files, and
 *  `.bak-*` copies. The shrink guard exists to catch a shared file being gutted (contacts.json
 *  111 -> 5 lines); a task file losing 58 lines because the next run rewrote it is not that. And the
 *  guard aborts the WHOLE commit, so one churn file stalls every other file's sync indefinitely —
 *  measured 2026-09-07: repeated BLOCKED alerts and a 27-commit push backlog behind two task files. */
export function isChurnPath(file: string): boolean {
  return /(^|\/)workspace\/[^/]+\/workers\/(logs|tasks)\//.test(file)
    // Per-job runtime records (one .json/.log/.status triple per background job), written on
    // dispatch and garbage-collected once the job is done. 54 live files churning constantly, so
    // their deletion is the design, not a regression — the integrity audit reported dozens of
    // "missing … in reference but not HEAD" lines for a routine GC pass.
    || /(^|\/)jobs\/job-[^/]+\.(json|log|status)$/.test(file)
    // Rendered artifacts (HTML previews and their exported shots). The Write tool rewrites these
    // wholesale on each iteration, so a restyle that deletes more than it adds is the normal
    // editing loop rather than shared state being gutted.
    || /(^|\/)workspace\/(users\/[^/]+\/)?artifacts\//.test(file)
    || /\.bak(-|\.|$)/.test(file);
}

/** Authored documents (HTML reports, dashboards, styles, scripts) are REWRITTEN wholesale by design —
 *  a redesign that drops 87 lines is an edit, not data loss (2026-09-17: two trial-journey report
 *  copies blocked every flush). The shrink guard protects records like contacts.json, not these. */
export function isAuthoredDocPath(file: string): boolean {
  return /\.(html?|css|m?[jt]sx?|svg)$/i.test(file);
}

export class DataSyncOptions {
  repoUrl = process.env.DATA_SYNC_REPO || '';
  branch = process.env.DATA_SYNC_BRANCH || 'main';
  deploymentId = process.env.APP_NAME || '';
  /**
   * EXPLICIT, deliberate opt-in. The mere PRESENCE of DATA_SYNC_REPO in the env is NOT enough to
   * activate sync — a leaked/inherited DATA_SYNC_REPO (dev shell pollution, a copied .env, a data
   * dir carrying a sync .git remote) can otherwise push a stray/dev boot's state to a shared repo.
   * A real deployment must ALSO set DATA_SYNC_ENABLE=1. Dev/verify boots never sync/push.
   */
  enabled = process.env.DATA_SYNC_ENABLE === '1' || process.env.DATA_SYNC_ENABLE === 'true';
  /**
   * Owner-facing alerts are a PROD side effect, so only the designated single-writer instance
   * (the same one that fires schedules) may DM owners. A dev laptop legitimately syncs the shared
   * data repo, but it also shares .env's APP_NAME, OWNERS and the Slack bot token — so its alerts
   * are indistinguishable from the box's. Past incident 2026-08-20: a laptop pinned to an older
   * shraga re-sent a merge-conflict alert for a bug already fixed AND deployed on the box, and the
   * DM gave no way to tell which instance sent it. Suppressed alerts are still logged locally.
   */
  notify = process.env.DATA_SYNC_SCHEDULER_ACTIVE === 'true';
  /**
   * audit/ is single-writer: only the designated instance (same marker as `notify`) commits it and refuses remote
   * rewrites of it. Any other syncing instance (a dev laptop on the shared repo) is a MIRROR: it never stages audit/
   * and takes the remote's audit/ on pull. Without this every instance believed it was the writer, so a box commit
   * (which always carries audit lines) was refused by every other clone forever (feedox laptop, 2026-10: 68 behind).
   */
  auditWriter = process.env.DATA_SYNC_SCHEDULER_ACTIVE === 'true';
  /**
   * Poll origin every N ms and pull when behind (0 = off). The GitHub webhook only reaches the publicly routed
   * instance, so any other clone (a dev laptop) pulled only on boot or after its own push — an idle one stayed
   * behind indefinitely and its agents acted on stale files (feedox laptop, 2026-10).
   */
  pollMs = parseInt(process.env.DATA_SYNC_POLL_MS ?? '60000', 10) || 0;
}

export class DataSync {
  public options: DataSyncOptions;
  private pending = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pushing = false;
  private pushingSince = 0;
  private pulling = false;
  private pullPending = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private ready = false;
  private warnedDisabled = false;
  /** key -> fingerprint+timestamp of the last DM sent for that guard, so a STANDING condition
   *  alerts once instead of on every sync cycle. See alertOnce(). */
  private alerted = new Map<string, { fingerprint: string; at: number }>();

  constructor(opts?: Partial<DataSyncOptions>) {
    this.options = { ...new DataSyncOptions(), ...opts };
  }

  isEnabled(): boolean {
    if (!this.options.repoUrl) return false;
    if (!this.options.enabled) {
      if (!this.warnedDisabled) { // isEnabled() runs per-write via trackWrite — warn once, not per write
        this.warnedDisabled = true;
        console.warn(`${TAG} DATA_SYNC_REPO is set but DATA_SYNC_ENABLE is not — sync DISABLED (guarding against leaked-env pushes). Set DATA_SYNC_ENABLE=1 to activate.`);
      }
      return false;
    }
    return true;
  }

  async init(): Promise<void> {
    if (!this.isEnabled()) return;
    mkdirSync(DATA_DIR, { recursive: true });
    const gitDir = path.join(DATA_DIR, '.git');

    if (!existsSync(gitDir)) {
      await this.git('init', '-b', this.options.branch);
      await this.git('remote', 'add', 'origin', this.authedUrl());
      this.ensureGitignore();
      await this.configureGit();
      // Try to pull remote first; if it exists, reset to it, then layer local changes on top
      try {
        await this.git('fetch', 'origin', this.options.branch);
        await this.git('reset', '--soft', `origin/${this.options.branch}`);
        // CRITICAL: restore remote files absent from this (possibly sparse) worktree before `add -A`,
        // otherwise add -A stages them as deletions and the commit/push WIPES remote-only data on a
        // fresh init. (Past incident: a sparse instance deleted 186 workspace files this way.)
        // -z → NUL-delimited, unquoted paths (safe for names with spaces/unicode).
        const missing = (await this.git('diff', '--name-only', '-z', '--diff-filter=D', 'HEAD'))
          .split('\0').filter(Boolean);
        for (const f of missing) {
          await this.git('checkout', 'HEAD', '--', f).catch((err) =>
            console.warn(`${TAG} Could not restore remote file ${f}:`, (err as Error).message));
        }
        console.log(`${TAG} Initialized from remote${missing.length ? ` (restored ${missing.length} remote file(s))` : ''}`);
      } catch {
        console.log(`${TAG} No remote branch yet, starting fresh`);
      }
      // Commit any local-only changes on top of remote
      await this.git('add', '-A');
      const status = await this.git('status', '--porcelain');
      if (status.trim()) {
        if (await this.guardMassDeletions('init merge') || await this.guardOversized()) {
          console.error(`${TAG} Init merge aborted — mass deletion blocked`);
        } else {
          await this.git('commit', '-m', 'data-sync: merge local state');
          await this.git('push', '-u', 'origin', this.options.branch).catch(err => {
            console.warn(`${TAG} Initial push failed:`, (err as Error).message);
          });
        }
      }
      console.log(`${TAG} Initialized git repo in data/`);
      this.ready = true;
    } else {
      const current = (await this.git('remote', 'get-url', 'origin')).trim();
      const expected = this.authedUrl();
      if (current !== expected) {
        await this.git('remote', 'set-url', 'origin', expected);
      }
      this.ensureGitignore();
      if (!this.verifyDeploymentId()) return;
      await this.configureGit(); // must precede untrackIgnored — it neutralises per-user excludes
      await this.untrackIgnored();
      this.ready = true;
    }
  }

  /**
   * Boot-time NETWORK sync: the remote fetch/merge plus the deferred conflict-scan + integrity audit.
   * Split out of init() so the HTTP port can bind BEFORE any of this runs.
   *
   * Why: this used to be the tail of init(), which bootServer awaits before listen(). A stalled pull
   * (observed on liv-mac-1: `Could not resolve host: github.com`, plus a 60s LLM commit-message
   * timeout) therefore held the ENTIRE boot — process alive, no listener on any port, 502s for
   * minutes. The port watchdog then SIGTERM/SIGKILLed the boot (LastExitStatus=9) and the next boot
   * re-entered the same stall. Serving possibly-stale data and refreshing a moment later is strictly
   * better than not serving at all.
   *
   * Never rejects: the caller runs this detached, and an unhandled rejection here would reach the
   * process-level handler.
   */
  async syncOnBoot(): Promise<void> {
    if (!this.ready) return; // init() disabled/aborted — nothing to sync against
    console.log(`${TAG} Boot sync started (background — the server is already serving)`);
    try {
      await this.pull();
      console.log(`${TAG} Boot sync complete`);
    } catch (err) {
      console.error(`${TAG} Boot sync FAILED — serving stale data until the next pull:`, (err as Error).message);
    }
    // Defer the post-boot scans (both async, but they still read/spawn a lot) past startup
    // traffic — WS connections and page loads.
    setTimeout(() => {
      this.scanForConflictMarkers()
        .catch(err => console.warn(`${TAG} Post-init conflict scan failed:`, (err as Error).message))
        .then(() => this.runIntegrityAudit())
        .catch(err => console.warn(`${TAG} Post-init integrity audit failed:`, (err as Error).message));
    }, 60_000);
    this.startPolling();
  }

  /** Start the periodic origin poll (idempotent). */
  startPolling(): void {
    if (this.pollTimer || !this.ready || !this.options.pollMs) return;
    let failing = false; // warn once per failure streak — an offline laptop would otherwise log every tick
    this.pollTimer = setInterval(() => {
      this.pollOnce().then(() => { failing = false; }, err => {
        if (!failing) console.warn(`${TAG} Poll failed (quiet until it recovers):`, (err as Error).message);
        failing = true;
      });
    }, this.options.pollMs);
    this.pollTimer.unref?.();
  }

  stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  /** One poll tick: a quiet fetch, then a full pull() only when origin has commits HEAD lacks.
   *  Skipped while a pull or flush is in flight — each of those already ends synced. */
  async pollOnce(): Promise<void> {
    if (this.pulling || this.pushing || !this.isEnabled()) return;
    await this.git('fetch', '-q', 'origin', this.options.branch);
    const behind = await this.git('merge-base', '--is-ancestor', `origin/${this.options.branch}`, 'HEAD').then(() => false, () => true);
    if (!behind || this.pulling || this.pushing) return;
    console.log(`${TAG} Poll: behind origin/${this.options.branch} — pulling`);
    await this.pull();
  }

  /** Compare HEAD against HEAD~1 to catch regressions. Notifies owner — never auto-reverts.
   *  Must stay async: the old execSync-per-file audit froze the event loop ~5 min on prod. */
  private async runIntegrityAudit(): Promise<void> {
    try {
      const { audit } = await import('./integrity-audit.ts');
      // Churn paths are exempt for the same reason the shrink guard exempts them: a per-run worker
       // log is written by one leg, rewritten by the next, and truncated whenever a run is killed
      // mid-write. "invalid-json" on one of those is the normal end of an interrupted run, not
      // corruption of shared data — and since the file stays in HEAD, the audit re-reported it on
      // every sync. The audit exists to catch contacts.json being gutted.
      const issues = (await audit('HEAD~1', DATA_DIR)).filter(i => !isChurnPath(i.file));
      if (issues.length) {
        console.warn(`${TAG} ⚠️ DATA INTEGRITY: ${issues.length} issue(s) detected after sync:`);
        for (const { kind, file, detail } of issues) {
          console.warn(`${TAG}   ${kind} ${file} — ${detail}`);
        }
        const list = issues.slice(0, 20).map(i => `• [${i.kind}] ${i.file} — ${i.detail}`).join('\n');
        this.alertOnce('integrity', issues.map(i => `${i.kind} ${i.file}`).join('\n'),
          `⚠️ Data integrity: ${issues.length} issue(s) detected after sync\n\n${list}` +
          (issues.length > 20 ? `\n…and ${issues.length - 20} more` : '') +
          `\n\nRecover: \`cd data && git revert HEAD\``,
        ).catch(err => console.warn(`${TAG} Integrity notify failed:`, (err as Error).message));
      }
    } catch (err) {
      console.warn(`${TAG} Integrity audit skipped:`, (err as Error).message);
    }
  }

  /** Block commits that stage an unusual number of file deletions OR a large in-file content
   *  shrink (e.g. contacts.json 111→5 lines — a legit-looking normalization that wiped shared
   *  data). Notifies owner and aborts. */
  private async guardMassDeletions(context: string): Promise<boolean> {
    // An untrackIgnored() pass is NOT a deletion: it runs `git rm --cached` over files that match
    // the repo's OWN .gitignore (a personal global gitignore is excluded upstream) and that still
    // exist on disk. Nothing is lost — the files simply stop being shared, which is the entire
    // point of the call. Judging it by the 10-file deletion threshold made a normal .gitignore
    // addition (pane-sessions/, 173 files) an unclearable block: every flush retried it, alerted,
    // and `git reset HEAD` also discarded whatever real work was staged alongside.
    const untracking = context === 'untrackIgnored';
    const fileThreshold = untracking
      ? parseInt(process.env.DATA_SYNC_UNTRACK_BLOCK || '500', 10)
      : parseInt(process.env.DATA_SYNC_DELETIONS_BLOCK || '10', 10);
    const shrinkThreshold = parseInt(process.env.DATA_SYNC_SHRINK_BLOCK || '50', 10);
    const shrinkRatio = parseFloat(process.env.DATA_SYNC_SHRINK_RATIO_BLOCK || '0.5');
    try {
      // (1) Mass FILE deletions.
      const out = await this.git('diff', '--cached', '--name-only', '--diff-filter=D');
      const deleted = out.split('\n').map(l => l.trim()).filter(Boolean);
      if (deleted.length > fileThreshold) {
        console.error(`${TAG} 🚫 BLOCKED mass deletion (${context}): ${deleted.length} file(s) — threshold is ${fileThreshold}`);
        const list = deleted.slice(0, 20).map(f => `• ${f}`).join('\n');
        await this.alertOnce(`deletions:${context}`, deleted.join('\n'),
          `🚫 BLOCKED mass deletion in data/ (${context}): ${deleted.length} file(s) staged for deletion (threshold: ${fileThreshold})\n\n${list}` +
          (deleted.length > 20 ? `\n…and ${deleted.length - 20} more` : '') +
          `\n\nCommit was aborted. Manual intervention needed.`,
        );
        await this.git('reset', 'HEAD').catch(() => {});
        return true;
      }

      // (2) Large in-file content SHRINK — a single tracked file losing > shrinkThreshold NET lines
      //     (deleted − added) AND losing more than shrinkRatio of itself. numstat:
      //     "<added>\t<deleted>\t<file>"; binary files show "-\t-".
      //     Both conditions are required because the absolute count alone cannot tell a gutting
      //     apart from an edit to a large file: contacts.json lost 95% of itself (111 -> 5 lines),
      //     while a 915-line prototype restyle losing 64 net lines loses 7% and is ordinary work.
      //     Net loss is bounded by the original size, so the ratio is always in [0, 1].
      const numstat = await this.git('diff', '--cached', '--numstat');
      const shrunk: string[] = [];
      const shrunkFiles: string[] = [];
      for (const line of numstat.split('\n').map(l => l.trim()).filter(Boolean)) {
        const [addRaw, delRaw, file] = line.split('\t');
        if (addRaw === '-' || delRaw === '-' || !file) continue; // binary
        const net = (parseInt(delRaw, 10) || 0) - (parseInt(addRaw, 10) || 0);
        // Untracking keeps every file on disk, so a "shrink" to zero lines loses nothing — same exemption as (1). Without it
        // the big files were unstaged and the rest left half-staged (feedox 2026-10-03: 35 of 49 .agent/ deletions).
        if (untracking || net <= shrinkThreshold || isChurnPath(file) || isAuthoredDocPath(file)) continue;
        // Size of the file as it stands in HEAD. Unreadable (e.g. not in HEAD) => no ratio to
        // judge by, so fall through to blocking rather than silently letting the shrink past.
        const before = await this.git('show', `HEAD:${file}`)
          .then(c => c.replace(/\n$/, '').split('\n').length)
          .catch(e => { console.warn(`${TAG} shrink guard: no HEAD baseline for ${file}: ${e?.message || e}`); return 0; });
        const ratio = before > 0 ? net / before : 1;
        if (ratio < shrinkRatio) continue;
        shrunkFiles.push(file);
        shrunk.push(`• ${file}  (−${net} of ${before} lines, ${Math.round(ratio * 100)}%)`);
      }
      if (shrunk.length) {
        console.error(`${TAG} 🚫 BLOCKED large content shrink (${context}): ${shrunk.length} file(s) — thresholds are ${shrinkThreshold} net lines and ${Math.round(shrinkRatio * 100)}% of the file`);
        await this.alertOnce(`shrink:${context}`, shrunk.join('\n'),
          `🚫 BLOCKED large content shrink in data/ (${context}): a tracked file lost more than ${shrinkThreshold} net lines AND more than ${Math.round(shrinkRatio * 100)}% of itself (guards against wiping shared data like contacts.json)\n\n${shrunk.slice(0, 20).join('\n')}` +
          `\n\nThose file(s) were unstaged; anything else in this commit will sync normally. If intended, commit them manually.`,
        );
        // Unstage ONLY the offending files. A blanket `git reset HEAD` discards every unrelated
        // file staged in the same flush and re-blocks on the next one — the unclearable-block
        // pattern already documented for untrackIgnored() above.
        await this.git('reset', 'HEAD', '--', ...shrunkFiles).catch(() => {});
        return true;
      }
      // Condition cleared — a future recurrence is news again, so let it alert.
      this.clearAlert(`deletions:${context}`);
      this.clearAlert(`shrink:${context}`);
      return false;
    } catch (err) {
      console.warn(`${TAG} Destructive-change check failed:`, (err as Error).message);
      return false;
    }
  }

  async pull(): Promise<void> {
    // Coalesce overlapping triggers WITHOUT dropping any. Serializing pulls is required — concurrent
    // stash/merge/pop on shared uncommitted state would corrupt the worktree. But a trigger that
    // arrives mid-pull (webhook B fires while pull A is already past its `git fetch`) references a
    // commit A will NOT see, so silently skipping B leaves a pure-consumer permanently stale (no
    // periodic poller catches up). Instead, mark work pending and guarantee exactly one follow-up
    // pass after the current one — mirrors the push-side pending/re-run pattern (flush()).
    if (this.pulling) {
      this.pullPending = true;
      console.log(`${TAG} Pull in progress — queued a follow-up (coalesced)`);
      return;
    }
    this.pulling = true;
    try {
      do {
        // Clear BEFORE the pass: a trigger during this _pull() re-sets it → one more loop.
        this.pullPending = false;
        await this._pull();
      } while (this.pullPending);
    } finally {
      // Reset both so a throw mid-pass can never wedge the lock or a stale pending flag.
      this.pulling = false;
      this.pullPending = false;
    }
  }

  private async _pull(): Promise<void> {
    if (!this.isEnabled()) return;
    try {
      await this.git('fetch', 'origin', this.options.branch);
    } catch (err) {
      console.warn(`${TAG} Fetch failed:`, (err as Error).message);
      return;
    }

    const localRef = (await this.git('rev-parse', 'HEAD').catch(() => '')).trim();
    const remoteRef = (await this.git('rev-parse', `origin/${this.options.branch}`).catch(() => '')).trim();
    if (!remoteRef) {
      console.log(`${TAG} Remote branch not found, skipping pull`);
      return;
    }
    if (localRef === remoteRef) {
      console.log(`${TAG} Already up to date`);
      return;
    }

    if (this.options.auditWriter) {
      // The audit log is append-only with ONE writer, this instance. A remote commit touching audit/ would rewrite the local
      // chain (and under `chattr +a` git can't even apply it) — refuse the whole pull and alert.
      let incomingAudit: string;
      try {
        incomingAudit = (await this.git('diff', '--name-only', `HEAD...origin/${this.options.branch}`, '--', AUDIT_DIR)).trim();
      } catch (err) {
        console.warn(`${TAG} Audit pull check failed, skipping pull:`, (err as Error).message);
        return;
      }
      if (incomingAudit) {
        console.error(`${TAG} 🚫 Remote commits change the audit log — pull refused:\n${incomingAudit}`);
        await this.alertOnce('audit-pull', incomingAudit,
          `🚫 Data sync refused a pull: remote commits change the audit log, which only this instance writes.\n\n${incomingAudit}\n\n` +
          `Inspect: \`cd data && git log origin/${this.options.branch} -- ${AUDIT_DIR}\``,
        ).catch(err => console.warn(`${TAG} Audit pull notify failed:`, (err as Error).message));
        return;
      }
      this.clearAlert('audit-pull');
    } else {
      // Mirror: the remote's audit/ is authoritative. Drop any local audit/ edits (a pre-fix build wrote here) so the
      // merge can take theirs; this instance's own audit goes to an untracked dir (auditDir()).
      const local = (await this.git('status', '--porcelain', '--', AUDIT_DIR).catch(() => '')).trim();
      if (local) {
        console.warn(`${TAG} Not the audit writer — discarding local audit/ changes so the remote's log wins:\n${local}`);
        await this.git('checkout', 'HEAD', '--', AUDIT_DIR).catch(e => console.warn(`${TAG} Resetting audit/ failed:`, (e as Error).message));
        await this.git('clean', '-fdq', '--', AUDIT_DIR).catch(e => console.warn(`${TAG} Cleaning audit/ failed:`, (e as Error).message));
      }
    }

    // Stash tracked changes before merging — never untracked files, and never audit/: stashing removes the live log
    // from disk while the server appends to it (lost lines, forked chain) and fails under `chattr +a`; the merge can't
    // touch audit/ (checked above), so it stays dirty in place. Untracked files stayed off disk for the whole pull with
    // the stash as their only copy: a writer recreating one mid-pull (feedox 2026-10-02 23:28: Bare saved an empty
    // workspace/socials.kanban) made the pop refuse it ("already exists") and the stash was dropped — file gone. The
    // merge can only collide with an untracked path the remote ADDS; those few are staged first, so they ride the stash
    // as tracked changes and a re-apply conflict keeps the local side (popStash).
    // `stashed` is whether THIS push created an entry — not whether status was dirty. A dirty nested repo
    // (` m gh-work/x`) passes the status check but `stash push` saves nothing and exits 0; popping then
    // re-applied a weeks-old stash (feedox 2026-10-02: a 09-04 stash with 10k tracked node_modules → 1949
    // unmerged paths + an owner alert at every 16:00 garden pull).
    // --no-renames: a path the remote introduces by rename is still an addition that collides.
    const incoming = new Set((await this.git('diff', '--name-only', '--diff-filter=A', '--no-renames', `HEAD...origin/${this.options.branch}`).catch(() => '')).split('\n').filter(Boolean));
    // Force-added paths must end untracked again unless the merge made them tracked — else the next flush commits them.
    const unstage = () => colliding.length ? this.git('reset', '-q', '--', ...colliding).then(() => {}, e => console.error(`${TAG} Unstaging untracked paths failed:`, (e as Error).message)) : Promise.resolve();
    const colliding = (await this.git('ls-files', '--others', '--exclude-standard', '-z').catch(() => '')).split('\0').filter(f => incoming.has(f));
    if (colliding.length) {
      try {
        await this.git('add', '--', ...colliding);
      } catch (err) {
        console.warn(`${TAG} Staging untracked paths the pull adds failed, skipping pull:`, (err as Error).message);
        return;
      }
    }
    const kept = await this.backupIncomingDeletions();
    let stashed = false;
    if ((await this.git('status', '--porcelain', '--untracked-files=no', ...NOT_AUDIT)).trim()) {
      const stashRef = () => this.git('rev-parse', '-q', '--verify', 'refs/stash').then(s => s.trim(), () => '');
      const before = await stashRef();
      try {
        await this.git('stash', 'push', '-m', 'data-sync: pre-pull stash', ...NOT_AUDIT);
      } catch (err) {
        console.warn(`${TAG} Stash failed, skipping pull:`, (err as Error).message);
        await unstage();
        return;
      }
      stashed = (await stashRef()) !== before;
    }

    try {
      await this.git('merge', `origin/${this.options.branch}`, '--no-edit');
      console.log(`${TAG} Pulled latest`);
      this.clearAlert('merge-refused');
    } catch (err) {
      let conflicted = await this.getConflictedFiles();
      if (!this.options.auditWriter) {
        // A mirror's committed-but-unpushed audit lines (pre-fix build) lose to the writer's chain.
        const audit = conflicted.filter(f => f.startsWith(`${AUDIT_DIR}/`));
        if (audit.length) {
          await this.git('checkout', '--theirs', '--', ...audit).then(() => this.git('add', '--', ...audit))
            .catch(e => console.error(`${TAG} Taking remote audit/ failed:`, (e as Error).message));
          conflicted = conflicted.filter(f => !audit.includes(f));
          if (!conflicted.length) await this.git('commit', '--no-edit').catch(e => console.error(`${TAG} Commit after audit resolve failed:`, (e as Error).message));
        }
      }
      if (conflicted.length) {
        console.log(`${TAG} Merge conflicts in ${conflicted.length} file(s), resolving...`);
        await this.resolveConflicts(conflicted);
      } else {
        // Git refused before merging — typically a local untracked path the incoming tree needs (untracked `a/b`
        // vs a remote file `a`). It recurs every cycle and local flushes stop reaching the remote, so alert.
        const msg = (err as Error).message;
        // Git names the INCOMING path (`a`); expand to the local untracked files at or under it (`a/b`).
        const named = msg.split('\n').filter(l => /^\t/.test(l)).map(l => l.trim());
        const untracked = named.length ? (await this.git('ls-files', '--others', '--exclude-standard', '-z').catch(() => '')).split('\0').filter(Boolean) : [];
        const blocking = named.flatMap(p => { const u = untracked.filter(f => f === p || f.startsWith(`${p}/`)); return u.length ? u : [p]; });
        console.error(`${TAG} Merge failed (no conflicts), aborting: ${msg}`);
        await this.git('merge', '--abort').catch(() => {});
        await this.alertOnce('merge-refused', blocking.join('\n') || msg,
          `⚠️ Data sync pull is blocked: git refused to merge origin/${this.options.branch}${blocking.length ? ` — local untracked path(s) in the way: ${listFiles(blocking)}` : `: ${msg.slice(0, 300)}`}. ` +
          `Until fixed, this instance's changes are not reaching the remote. Fix: move/rename the listed path(s) in data/ (back them up first), then the next sync will merge.`);
      }
    }

    if (stashed) await this.popStash();
    await unstage();
    await this.restoreUntracked(kept);
    this.rebuildLog().catch(() => {});
  }

  private get untrackBackupDir(): string { return path.join(DATA_DIR, '.git', 'data-sync-untrack-backup'); }

  /** Copy aside every local file the incoming commits delete. An untrack commit (`git rm --cached` by the designated
   *  instance) is a deletion to every other clone: merging it removed the files from disk — e.g. the box's agent
   *  memory when workspace/.agent/ became ignored. Lives under .git/ so a crash mid-pull leaves the copy. */
  private async backupIncomingDeletions(): Promise<string[]> {
    const deleted = (await this.git('diff', '--name-only', '-z', '--diff-filter=D', '--no-renames', `HEAD...origin/${this.options.branch}`).catch(() => ''))
      .split('\0').filter(f => f && existsSync(path.join(DATA_DIR, f)));
    rmSync(this.untrackBackupDir, { recursive: true, force: true });
    const kept: string[] = [];
    for (const f of deleted) {
      try { cpSync(path.join(DATA_DIR, f), path.join(this.untrackBackupDir, f)); kept.push(f); }
      catch (e) { console.error(`${TAG} Backing up ${f} before pull failed:`, (e as Error).message); }
    }
    return kept;
  }

  /** After the merge: put back the backed-up files the merge removed that are now gitignored (an untrack, not a real
   *  deletion — those stay deleted), untracked. */
  private async restoreUntracked(kept: string[]): Promise<void> {
    if (!kept.length) return;
    const gone = kept.filter(f => !existsSync(path.join(DATA_DIR, f)));
    // Per path (exit 0 = ignored, 1 = not): a batched call's output is quoted for unusual names and would miss them.
    const ignored: string[] = [];
    for (const f of gone) {
      const hit = await this.git('-c', 'core.excludesFile=/dev/null', 'check-ignore', '-q', '--no-index', '--', f).then(() => true, e => {
        if (!/failed \(1\)/.test((e as Error).message)) console.error(`${TAG} check-ignore ${f} after pull failed:`, (e as Error).message);
        return false;
      });
      if (hit) ignored.push(f);
    }
    for (const f of ignored) {
      try { cpSync(path.join(this.untrackBackupDir, f), path.join(DATA_DIR, f)); }
      catch (e) { console.error(`${TAG} Restoring untracked ${f} failed — copy kept in ${this.untrackBackupDir}:`, (e as Error).message); return; }
    }
    if (ignored.length) console.log(`${TAG} Kept ${ignored.length} file(s) on disk that the pull untracked (now gitignored)`);
    rmSync(this.untrackBackupDir, { recursive: true, force: true });
  }

  /** Restore the pre-pull stash. A failed pop used to be logged and left as-is: the worktree kept conflict
   *  markers and an unmerged index, every later flush's commit failed silently, and a `git add` of a marked
   *  file pushed the markers upstream (2026-09-23 on feedox, twice: para-links.json and push-tokens.json
   *  unparseable, para delivery + mobile push dead). The stash holds THIS instance's live writes, so on a
   *  conflict its side wins; the index is cleared, and the stash is dropped only when nothing in it is lost. */
  private async popStash(): Promise<void> {
    try {
      await this.git('stash', 'pop');
      return;
    } catch (err) {
      console.error(`${TAG} Stash pop failed, repairing the worktree:`, (err as Error).message);
    }
    const conflicted = await this.getConflictedFiles().catch(() => [] as string[]);
    for (const f of conflicted) {
      // In a stash apply, "theirs" is the stash (local writes). A path the stash deleted has no theirs side.
      await this.git('checkout', '--theirs', '--', f).catch(async () => {
        await this.git('checkout', '--ours', '--', f).catch(e =>
          console.error(`${TAG} Could not take either side of ${f}:`, (e as Error).message));
      });
    }
    // Clear the unmerged index (worktree kept) so later commits are not refused.
    await this.git('reset', '-q').catch(e => console.error(`${TAG} Index reset after failed pop failed:`, (e as Error).message));
    // No conflicts = git refused the pop outright (a writer saved a stashed path mid-pull: "would be overwritten").
    // Nothing was applied, so the stash is the only copy of those unflushed edits — never drop it.
    const refused = conflicted.length === 0;
    const marked = await this.filesWithMarkers(conflicted);
    const kept = refused || marked.length > 0;
    if (!kept) {
      await this.git('stash', 'drop').catch(e => console.error(`${TAG} Stash drop failed:`, (e as Error).message));
    }
    const stashFiles = refused ? (await this.git('stash', 'show', '--name-only').catch(() => '')).split('\n').filter(Boolean) : [];
    console.error(`${TAG} Stash pop ${refused ? 'refused' : 'conflict repaired'}: kept local side of ${conflicted.length} file(s)${conflicted.length ? ` (${conflicted.join(', ')})` : ''}${kept ? `; stash KEPT — markers: [${marked.join(', ')}], not re-applied: [${stashFiles.join(', ')}]` : '; stash dropped'}`);
    await this.alertOnce('stash-pop', [...conflicted, ...marked, ...stashFiles].join('\n'),
      `⚠️ Data sync: a pre-pull stash failed to re-apply. Kept this instance's version of: ${listFiles(conflicted) || '(none)'}.` +
      (kept ? `\n\nNOT repaired — stash kept. Markers in: ${listFiles(marked) || '-'}; unflushed edits not re-applied: ${listFiles(stashFiles) || '-'}. Inspect: \`cd data && git stash show -p\`` : ''),
    ).catch(e => console.warn(`${TAG} Stash-pop notify failed:`, (e as Error).message));
  }

  /** Worktree files (of the given paths) that still carry conflict markers. */
  private async filesWithMarkers(files: string[]): Promise<string[]> {
    const out: string[] = [];
    for (const f of files) {
      try { if (CONFLICT_MARKER.test(readFileSync(path.join(DATA_DIR, f), 'utf-8'))) out.push(f); } catch { /* missing = no markers */ }
    }
    return out;
  }

  trackWrite(relativePath: string): void {
    if (!this.isEnabled() || !this.ready) return;
    this.pending.add(relativePath);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 2000);
  }

  async getLog(limit = 50): Promise<object[]> {
    const logPath = path.join(DATA_DIR, 'git-log.json');
    if (existsSync(logPath)) {
      try { return JSON.parse(readFileSync(logPath, 'utf-8')); } catch { /* rebuild */ }
    }
    return this.rebuildLog(limit);
  }

  private async rebuildLog(limit = 50): Promise<object[]> {
    if (!existsSync(path.join(DATA_DIR, '.git'))) return [];
    try {
      const raw = await this.git('log', `--max-count=${limit}`, '--pretty=format:%H|%aI|%an|%s', '--name-only');
      const entries: object[] = [];
      for (const block of raw.split('\n\n').filter(Boolean)) {
        const [header, ...fileLines] = block.split('\n');
        const [hash, date, author, message] = header.split('|', 4);
        entries.push({ hash: hash.slice(0, 8), date, author, message, files: fileLines.filter(Boolean) });
      }
      writeFileSync(path.join(DATA_DIR, 'git-log.json'), JSON.stringify(entries, null, 2));
      return entries;
    } catch { return []; }
  }

  private async flush(): Promise<void> {
    if (!this.pending.size) return;
    if (this.pushing) {
      const held = Date.now() - this.pushingSince;
      if (held > PUSHING_STUCK_MS) console.warn(`${TAG} Push latch held for ${Math.round(held / 1000)}s — sync is not pushing (pending: ${this.pending.size})`);
      return;
    }
    this.pushing = true;
    this.pushingSince = Date.now();
    const files = [...this.pending];
    this.pending.clear();
    this.timer = null;

    try {
      for (const f of files) {
        if (!this.options.auditWriter && (f === AUDIT_DIR || f.startsWith(`${AUDIT_DIR}/`))) continue;
        const abs = path.join(DATA_DIR, f);
        if (existsSync(abs)) {
          await this.git('add', f);
        } else {
          await this.git('rm', '--cached', f).catch(() => {});
        }
      }

      // The audit log rides along with every sync commit — the data repo is its offsite copy — and the commit message
      // anchors its head. Head read BEFORE staging: the committed chain always contains that hash.
      const auditHead = this.options.auditWriter ? this.auditHead() : undefined;
      // A data repo may gitignore audit/ (anchors-only in commit messages): staging it then fails every flush.
      const auditIgnored = await this.git('check-ignore', '-q', AUDIT_DIR).then(() => true, () => false);
      if (this.options.auditWriter && !auditIgnored && existsSync(path.join(DATA_DIR, AUDIT_DIR))) {
        await this.git('add', '--', AUDIT_DIR).catch(err => console.warn(`${TAG} Staging audit log failed:`, (err as Error).message));
      }

      // Staged changes only: untracked files made `status --porcelain` non-empty, so a flush of files a pull had just
      // written (workspace watcher → trackWrite) paid an LLM commit message and then failed "nothing to commit".
      if (!(await this.git('diff', '--cached', '--name-only')).trim()) return;

      if (await this.guardMassDeletions('flush')) return;
      if (await this.guardConflictMarkers()) return;
      if (await this.guardOversized()) return;
      const msg = await this.generateCommitMessage(files);
      // The LLM wait is slow; another committer in this repo (e.g. the nightly reconcile job) may have committed the
      // staged changes meanwhile. That's a no-op, not a failure.
      const committedElsewhere = () => console.log(`${TAG} Nothing to commit (committed elsewhere)`);
      if (!(await this.git('diff', '--cached', '--name-only')).trim()) committedElsewhere();
      else await this.git('commit', '-m', auditHead ? `${msg}\n\naudit-head: ${auditHead}` : msg).catch(err => {
        const m = (err as Error).message;
        if (/nothing to commit|nothing added to commit/.test(m)) committedElsewhere();
        else console.error(`${TAG} Commit failed — nothing from this flush is synced:`, m);
      });
      const ahead = await this.git('rev-list', '--count', `origin/${this.options.branch}..HEAD`).catch(() => '0');
      if (parseInt(ahead.trim()) === 0) return;
      await this.git('push', 'origin', this.options.branch).catch(async (err) => {
        console.warn(`${TAG} Push failed, pulling first:`, (err as Error).message);
        await this.pull();
        await this.git('push', 'origin', this.options.branch);
      });
      console.log(`${TAG} Pushed: ${msg}`);
      this.rebuildLog().catch(() => {});
    } catch (err) {
      console.error(`${TAG} Commit/push failed:`, (err as Error).message);
    } finally {
      // ALWAYS release the latch: any unsettled/throwing await used to wedge sync permanently,
      // since every later flush() early-returns on `if (this.pushing) return`.
      this.pushing = false;
      if (this.pending.size && !this.timer) {
        this.timer = setTimeout(() => this.flush(), 2000);
      }
    }
  }

  /** Audit chain head for the commit anchor; undefined when there's no record yet or it can't be read (logged). */
  private auditHead(): string | undefined {
    try {
      const head = readAuditHead(path.join(DATA_DIR, AUDIT_DIR));
      return head === GENESIS_HASH ? undefined : head;
    } catch (err) {
      console.warn(`${TAG} Audit head unreadable, committing without anchor:`, (err as Error).message);
      return undefined;
    }
  }

  private async generateCommitMessage(files: string[]): Promise<string> {
    const fallback = fallbackCommitMessage(files);
    try {
      // The audit log's appended lines are not "behavioral config" and would crowd the real diff out of the prompt.
      const diff = await this.git('diff', '--cached', '--stat', ...NOT_AUDIT).catch(() => '');
      const diffContent = await this.git('diff', '--cached', '--no-color', '-U2', ...NOT_AUDIT).catch(() => '');
      if (!diffContent.trim()) return fallback;
      const truncated = diffContent.slice(0, 3000);
      // Bounded: a hung `claude` subprocess used to wedge flush() forever (it holds the push latch).
      const ac = new AbortController();
      const msg = await withTimeout(
        this.askClaude(
          'Write a concise git commit message (max 72 chars, no quotes, no prefix like "feat:" or "sync:") for this change to an AI agent\'s behavioral config.\n' +
          `Files: ${files.join(', ')}\nStats: ${diff}\n\nDiff:\n${truncated}`,
          'haiku',
          ac,
        ),
        Number(process.env.DATA_SYNC_COMMIT_MSG_TIMEOUT_MS) || COMMIT_MSG_TIMEOUT_MS,
        'commit-message query',
        () => ac.abort(),
      );
      const line = extractCommitSubject(msg);
      if (!line) console.warn(`${TAG} Unusable LLM commit msg, using fallback:`, JSON.stringify((msg || '').slice(0, 120)));
      return line || fallback;
    } catch (err) {
      console.warn(`${TAG} LLM commit msg failed:`, (err as Error).message);
      return fallback;
    }
  }

  private async resolveConflicts(files: string[]): Promise<void> {
    const realFiles = files.filter(f => {
      const abs = path.join(DATA_DIR, f);
      try { return existsSync(abs) && !statSync(abs).isDirectory(); } catch { return false; }
    });
    if (!realFiles.length) {
      console.warn(`${TAG} No resolvable conflicted files, aborting merge`);
      await this.git('merge', '--abort').catch(() => {});
      return;
    }

    const sections = realFiles.map(f => {
      const content = readFileSync(path.join(DATA_DIR, f), 'utf-8');
      return `=== FILE: ${f} ===\n${content}`;
    }).join('\n\n');

    try {
      const resolved = await this.askClaude(
        'You are resolving git merge conflicts in an AI agent\'s data directory.\n' +
        'CRITICAL RULES:\n' +
        '- NEVER delete entries/records that exist on either side — always keep both (union merge)\n' +
        '- NEVER change "enabled" flags, field values, or settings that aren\'t inside a conflict marker\n' +
        '- NEVER "simplify" or "clean up" — your ONLY job is to merge the conflicting sections\n' +
        '- For JSON arrays (like schedules): keep ALL entries from both sides, deduplicate by "id"\n' +
        '- When the same field has different values on each side: keep the one that preserves more data/state\n' +
        '- Bias toward UNION (keep everything) over SIMPLIFICATION (remove things)\n\n' +
        'For each file:\n' +
        '1. Classify: "trivial" (both sides added content, or one is superset) or "ambiguous" (same field changed differently)\n' +
        '2. Resolve it following the rules above.\n' +
        'Output format:\n' +
        '<file path="<path>" complexity="trivial|ambiguous" reason="short explanation">\n<resolved content>\n</file>\n' +
        'Output ONLY the resolved files in this format.\n\n' + sections,
        'opus',
      );

      const parsed = this.parseResolvedFiles(resolved);
      if (!parsed.length) throw new Error('Failed to parse resolved files from Claude response');

      const ambiguous: string[] = [];
      for (const [filePath, content, complexity, reason] of parsed) {
        if (!realFiles.includes(filePath)) continue;
        const violations = this.validateResolution(filePath, content, realFiles);
        if (violations.length) {
          ambiguous.push(`• ${filePath}: VALIDATION FAILED — ${violations.join('; ')}`);
          continue;
        }
        writeFileSync(path.join(DATA_DIR, filePath), content);
        await this.git('add', filePath);
        if (complexity === 'ambiguous') ambiguous.push(`• ${filePath}: ${reason}`);
      }

      await this.git('commit', '-m', `data-sync: resolved ${realFiles.length} merge conflict(s)`);
      await this.git('push', 'origin', this.options.branch);
      console.log(`${TAG} Resolved ${realFiles.length} conflict(s) and pushed`);

      if (ambiguous.length) {
        await this.notifyOwners(
          `⚠️ Merge conflict auto-resolved (needs review)\n\n` +
          `${ambiguous.join('\n')}\n\n` +
          `These were ambiguous — I picked what looked best but please verify.\n` +
          `Recovery: \`cd data && git revert HEAD\``,
        );
      }
    } catch (err) {
      console.error(`${TAG} Conflict resolution failed:`, (err as Error).message);
      await this.git('merge', '--abort').catch(() => {});
      await this.notifyOwners(
        `🚨 Merge conflict resolution FAILED in data/\n\n` +
        `Files: ${realFiles.join(', ')}\n` +
        `Error: ${(err as Error).message}\n\n` +
        `Merge was aborted. Manual intervention needed.`,
      );
    }
  }

  /** Scan all tracked files for leftover conflict markers (<<<<<<< / ======= / >>>>>>>) */
  async scanForConflictMarkers(): Promise<void> {
    if (!existsSync(path.join(DATA_DIR, '.git'))) return;
    try {
      const tracked = (await this.git('ls-files')).split('\n').filter(Boolean);
      const conflicted: string[] = [];
      // ASYNC + YIELDING on purpose. This walks every tracked file (1000+, GBs on a real
      // deployment); doing it synchronously froze the event loop for ~45s — the server stopped
      // answering /api/version entirely, which also made self-upgrade verification fail and
      // auto-revert healthy versions. Deferring a synchronous freeze only moves it; it has to
      // not block at all.
      for (let i = 0; i < tracked.length; i++) {
        const abs = path.join(DATA_DIR, tracked[i]);
        try {
          const info = await stat(abs).catch(() => null);
          if (!info || info.isDirectory()) continue;
          const content = await readFile(abs, 'utf-8');
          if (/^<{7} /m.test(content)) conflicted.push(tracked[i]);
        } catch { /* skip unreadable */ }
        if (i % 25 === 24) await new Promise<void>(r => setImmediate(r)); // let the server breathe
      }
      if (!conflicted.length) return;

      console.warn(`${TAG} Found conflict markers in ${conflicted.length} file(s): ${conflicted.join(', ')}`);

      const sections = conflicted.map(f => {
        const content = readFileSync(path.join(DATA_DIR, f), 'utf-8');
        return `=== FILE: ${f} ===\n${content}`;
      }).join('\n\n');

      const resolved = await this.askClaude(
        'These files in our agent data directory have leftover git merge conflict markers.\n' +
        'CRITICAL RULES:\n' +
        '- NEVER delete entries/records that exist on either side — always keep both (union merge)\n' +
        '- NEVER change "enabled" flags, field values, or settings that aren\'t inside a conflict marker\n' +
        '- NEVER "simplify" or "clean up" — your ONLY job is to resolve the conflicting sections\n' +
        '- For JSON arrays (like schedules): keep ALL entries from both sides, deduplicate by "id"\n' +
        '- Bias toward UNION (keep everything) over SIMPLIFICATION (remove things)\n\n' +
        'For each file:\n' +
        '1. Classify: "trivial" or "ambiguous"\n' +
        '2. Produce the correct resolved content following the rules above.\n' +
        'Output format:\n' +
        '<file path="<path>" complexity="trivial|ambiguous" reason="short explanation">\n<resolved content>\n</file>\n' +
        'Output ONLY the resolved files.\n\n' + sections,
        'opus',
      );

      const parsed = this.parseResolvedFiles(resolved);
      if (!parsed.length) {
        console.error(`${TAG} Could not parse conflict resolution, notifying owners`);
        await this.notifyOwners(
          `🚨 Found conflict markers in data/ but auto-resolution failed.\n\nFiles: ${listFiles(conflicted)}\n\nManual fix needed.`,
        );
        return;
      }

      const ambiguous: string[] = [];
      for (const [filePath, content, complexity, reason] of parsed) {
        if (!conflicted.includes(filePath)) continue;
        const violations = this.validateResolution(filePath, content, conflicted);
        if (violations.length) {
          ambiguous.push(`• ${filePath}: VALIDATION FAILED — ${violations.join('; ')}`);
          continue;
        }
        writeFileSync(path.join(DATA_DIR, filePath), content);
        await this.git('add', filePath);
        if (complexity === 'ambiguous') ambiguous.push(`• ${filePath}: ${reason}`);
      }

      await this.git('commit', '-m', `data-sync: fix leftover conflict markers in ${conflicted.join(', ')}`);
      await this.git('push', 'origin', this.options.branch).catch(err => {
        console.warn(`${TAG} Push after conflict fix failed:`, (err as Error).message);
      });
      console.log(`${TAG} Fixed conflict markers in ${conflicted.length} file(s)`);

      const severity = ambiguous.length ? '⚠️' : '✅';
      await this.notifyOwners(
        `${severity} Fixed leftover conflict markers in data/\n\n` +
        conflicted.map(f => `• ${f}`).join('\n') +
        (ambiguous.length ? `\n\nAmbiguous resolutions (please verify):\n${ambiguous.join('\n')}\n\nRecovery: \`cd data && git revert HEAD\`` : ''),
      );
    } catch (err) {
      console.error(`${TAG} Conflict marker scan failed:`, (err as Error).message);
    }
  }

  private parseResolvedFiles(output: string): [path: string, content: string, complexity: string, reason: string][] {
    const results: [string, string, string, string][] = [];
    const re = /<file path="([^"]+)"(?:\s+complexity="([^"]*)")?(?:\s+reason="([^"]*)")?\s*>\n([\s\S]*?)\n<\/file>/g;
    let match;
    while ((match = re.exec(output)) !== null) {
      results.push([match[1], match[4] + '\n', match[2] || 'trivial', match[3] || '']);
    }
    return results;
  }

  /** Validate resolved content against the original to catch bad merges. */
  private validateResolution(filePath: string, resolved: string, _allFiles: string[]): string[] {
    const violations: string[] = [];
    const abs = path.join(DATA_DIR, filePath);
    if (!existsSync(abs)) return violations;

    // Still has conflict markers
    if (/^<{7} /m.test(resolved)) violations.push('still contains conflict markers');

    // For JSON files: check no entries were lost
    if (filePath.endsWith('.json')) {
      try {
        const original = JSON.parse(readFileSync(abs, 'utf-8').replace(/^<{7}.*$|^={7}$|^>{7}.*$/gm, ''));
        const result = JSON.parse(resolved);
        if (Array.isArray(original) && Array.isArray(result)) {
          const origIds = new Set(original.map((e: { id?: string }) => e.id).filter(Boolean));
          const resultIds = new Set(result.map((e: { id?: string }) => e.id).filter(Boolean));
          const lost = [...origIds].filter(id => !resultIds.has(id));
          if (lost.length) violations.push(`lost entries: ${lost.join(', ')}`);

          // Check enabled flags weren't flipped
          const origEnabled = new Map(original.map((e: { id?: string; enabled?: boolean }) => [e.id, e.enabled]));
          for (const entry of result as { id?: string; enabled?: boolean }[]) {
            if (entry.id && origEnabled.has(entry.id) && origEnabled.get(entry.id) === true && entry.enabled === false) {
              violations.push(`"enabled" flipped to false for ${entry.id}`);
            }
          }
        }
      } catch { /* can't parse — conflicted JSON, skip structural checks */ }
    }

    return violations;
  }

  /**
   * DM owners about a guard trip, but only when the condition is NEW. A blocked commit is not a
   * one-off: the same staged change is re-attempted on every flush, so a standing condition used to
   * DM on every cycle (measured 2026-09-08: 173 files ignored-but-tracked produced an identical
   * "BLOCKED mass deletion" DM ~15×/hour, indefinitely). Alert fatigue is a correctness bug — it
   * buries the one alert that matters. Re-alerts only when the fingerprint CHANGES or after
   * DATA_SYNC_ALERT_REPEAT_MS (default 6h), and every trip is still logged locally.
   */
  private async alertOnce(key: string, fingerprint: string, text: string): Promise<void> {
    const repeatMs = parseInt(process.env.DATA_SYNC_ALERT_REPEAT_MS || '', 10) || 6 * 60 * 60 * 1000;
    const prev = this.alerted.get(key);
    const now = Date.now();
    if (prev && prev.fingerprint === fingerprint && now - prev.at < repeatMs) {
      console.warn(`${TAG} alert suppressed (unchanged since ${new Date(prev.at).toISOString()}): ${key}`);
      return;
    }
    this.alerted.set(key, { fingerprint, at: now });
    await this.notifyOwners(text);
  }

  /** Clear the repeat-suppression for a guard once its condition is gone, so a RECURRENCE alerts. */
  private clearAlert(key: string): void {
    this.alerted.delete(key);
  }

  private async notifyOwners(text: string): Promise<void> {
    if (!this.options.notify) {
      // Not the authoritative instance — log it so a dev run still surfaces the problem locally,
      // but never DM owners (see DataSyncOptions.notify).
      console.warn(`${TAG} notification suppressed (not the authoritative instance):\n${text}`);
      return;
    }
    await notifyOwners('data-sync', text);
  }


  /**
   * Routed through the Claude Code SDK (runTextQuery), same as the rest of the platform —
   * authenticates via the CC subscription, no ANTHROPIC_API_KEY required. Past incident:
   * this used to hit the raw Anthropic Messages API directly with process.env.ANTHROPIC_API_KEY,
   * which is unset on subscription-auth deployments — every merge-conflict resolution failed and
   * spammed owners via notifyOwners().
   */
  private async askClaude(prompt: string, model: 'haiku' | 'sonnet' | 'opus' = 'sonnet', abortController?: AbortController): Promise<string> {
    return runTextQuery({ prompt, model, maxTurns: 1, abortController });
  }

  /** Never commit a conflict marker: unstage marked files (they stay on disk for repair) and alert.
   *  An unmerged index blocks the whole commit, so that case is reported rather than committed around.
   *  Returns true when nothing is left to commit. */
  /** Unstage files over MAX_FILE_BYTES (left on disk, unsynced). Returns true when nothing is left to commit. */
  private async guardOversized(): Promise<boolean> {
    const changed = (await this.git('diff', '--cached', '--name-only', '-z', '--diff-filter=AM').catch(() => '')).split('\0').filter(Boolean);
    const big = changed.filter(f => { try { return statSync(path.join(DATA_DIR, f)).size > MAX_FILE_BYTES; } catch { return false; } });
    if (!big.length) { this.clearAlert('oversized'); return false; }
    console.error(`${TAG} 🚫 Oversized file(s) staged — unstaged, not committed: ${big.join(', ')}`);
    await this.git('reset', '-q', 'HEAD', '--', ...big).catch(e => console.error(`${TAG} Unstaging oversized files failed:`, (e as Error).message));
    await this.alertOnce('oversized', big.join('\n'),
      `🚫 Data sync refused file(s) over ${MAX_FILE_BYTES / 1024 / 1024}MB: ${listFiles(big)}. Left on disk unsynced — move them out of data/ or gitignore them.`,
    ).catch(e => console.warn(`${TAG} Oversized notify failed:`, (e as Error).message));
    return !(await this.git('diff', '--cached', '--name-only').catch(() => '')).trim();
  }

  private async guardConflictMarkers(): Promise<boolean> {
    let unmerged = await this.getConflictedFiles().catch(() => [] as string[]);
    // A conflicted path the repo's own .gitignore covers (a node_modules tree committed before it was ignored)
    // is build output, not data: drop it from the index (kept on disk) rather than block every commit on it.
    // Bounded like untrackIgnored(): this runs after flush's deletion guard, so a larger tree stays reported.
    const untrackMax = parseInt(process.env.DATA_SYNC_UNTRACK_BLOCK || '500', 10);
    const ignored = unmerged.length
      ? (await this.git('-c', 'core.excludesFile=/dev/null', 'check-ignore', '--no-index', '--', ...unmerged).catch(() => '')).split('\n').filter(Boolean)
      : [];
    if (ignored.length && ignored.length <= untrackMax) {
      await this.git('rm', '-q', '-r', '--cached', '--ignore-unmatch', '--', ...ignored)
        .then(() => { console.error(`${TAG} Untracked ${ignored.length} conflicted gitignored path(s): ${listFiles(ignored)}`); unmerged = unmerged.filter(f => !ignored.includes(f)); })
        .catch(e => console.error(`${TAG} Untracking conflicted gitignored paths failed:`, (e as Error).message));
    }
    if (unmerged.length) {
      console.error(`${TAG} 🚫 Unmerged paths in data/ — commit skipped: ${unmerged.join(', ')}`);
      await this.alertOnce('unmerged', unmerged.join('\n'),
        `🚫 Data sync is not committing: unmerged paths in data/: ${listFiles(unmerged)}. Resolve them (keep both sides), then \`git add\` them.`,
      ).catch(e => console.warn(`${TAG} Unmerged notify failed:`, (e as Error).message));
      return true;
    }
    this.clearAlert('unmerged');
    // Only what this commit stages: grepping the whole index each flush would scan GBs on a real deployment.
    const changed = (await this.git('diff', '--cached', '--name-only', '--diff-filter=AM').catch(() => '')).split('\n').filter(Boolean);
    const staged = changed.length
      ? (await this.git('grep', '--cached', '-l', '-E', '^(<{7}|>{7}) ', '--', ...changed).catch(() => '')).split('\n').filter(Boolean)
      : [];
    if (!staged.length) { this.clearAlert('markers'); return false; }
    console.error(`${TAG} 🚫 Conflict markers staged — unstaged, not committed: ${staged.join(', ')}`);
    await this.git('reset', '-q', 'HEAD', '--', ...staged).catch(e => console.error(`${TAG} Unstaging marked files failed:`, (e as Error).message));
    await this.alertOnce('markers', staged.join('\n'),
      `🚫 Data sync refused to commit file(s) containing git conflict markers: ${listFiles(staged)}. They are left on disk unsynced; fix their content.`,
    ).catch(e => console.warn(`${TAG} Markers notify failed:`, (e as Error).message));
    return !(await this.git('diff', '--cached', '--name-only').catch(() => '')).trim();
  }

  private async getConflictedFiles(): Promise<string[]> {
    const output = await this.git('diff', '--name-only', '--diff-filter=U');
    return output.split('\n').map(l => l.trim()).filter(Boolean);
  }

  /** Canonical ignore entries. Kept in code so all envs converge on the same list. */
  private static readonly GITIGNORE_ENTRIES = [
    'conversations/', 'sessions.json', 'gmail-*.json',
    'gmail-thread-sessions.json', 'slack/', 'slack-*.json',
    'uploads/', 'repos/', '.tmp/', 'schedules.json.bak', 'git-log.json',
    '.internal-token', 'comms-log.jsonl', 'sessions/', 'unread/', '.DS_Store',
    'scheduler/', '.mcp-catalog.json',
    'api-keys.json.bak', // pre-hashing plaintext keys (api-keys.ts migration) — never commit
    'workspace/users/*/.claude/', // per-user Claude logins (claude-account.ts) — credentials, never commit
    // Live security state of the ACTIVE instance, which is its single writer — a pull must never overwrite it:
    // blocks.json (guard auto-blocks); policy.json + .migrated (the Owner Console writes them; a pulled change trips
    // the policy provenance/tamper check). Blue-green shares one DATA_DIR on one host, so nothing needs to cross hosts.
    'security/',
    'quarantine/', // untrusted inbound content held for operator review — never synced
  ];

  /** Write or refresh .gitignore, appending any canonical entries it's missing (idempotent). */
  private ensureGitignore(): void {
    const gitignorePath = path.join(DATA_DIR, '.gitignore');
    const existing = existsSync(gitignorePath)
      ? readFileSync(gitignorePath, 'utf-8').split('\n').map(l => l.trim())
      : [];
    const missing = DataSync.GITIGNORE_ENTRIES.filter(e => !existing.includes(e));
    if (!missing.length && existsSync(gitignorePath)) return;
    const lines = [...existing.filter(Boolean), ...missing];
    writeFileSync(gitignorePath, lines.join('\n') + '\n');
  }

  /** Commit a refreshed .gitignore and untrack any committed files that now match it. */
  private async untrackIgnored(): Promise<void> {
    await this.git('add', '.gitignore').catch(() => {});
    // core.excludesFile=/dev/null: --exclude-standard would otherwise fold in the USER'S global
    // gitignore (~/.gitignore_global) and untrack files that are ignored on this host only. The
    // data repo is shared, so a personal rule must never decide what leaves the remote. Real
    // near-miss 2026-08-20: a laptop's global `.agent/` rule staged 50 files for deletion —
    // including workspace/.agent/memory/MEMORY.md, the agent's own memory — and only
    // guardMassDeletions() stopped it. Only the repo's OWN .gitignore may untrack anything.
    const out = await this.git('-c', 'core.excludesFile=/dev/null', 'ls-files', '-i', '-c', '--exclude-standard').catch(() => '');
    // Only untrack files that actually exist on disk AND match .gitignore.
    // git ls-files -i can falsely report tracked files missing from the worktree
    // (remote-only files restored during init). Removing those wipes remote data.
    let files = out.split('\n').map(l => l.trim()).filter(Boolean)
      .filter(f => existsSync(path.join(DATA_DIR, f)));
    // Only the designated instance (DATA_SYNC_SCHEDULER_ACTIVE, the audit writer) commits an untrack: one clean commit
    // from one place. Other clones keep the files tracked until that commit arrives; _pull() then keeps them on disk.
    if (files.length && !this.options.auditWriter) {
      console.log(`${TAG} ${files.length} tracked file(s) now match .gitignore — left for the designated instance to untrack`);
      files = [];
    }
    if (files.length) {
      await this.git('rm', '--cached', '--', ...files).catch(err => {
        console.warn(`${TAG} Untrack ignored files failed:`, (err as Error).message);
      });
    }
    if (!(await this.git('diff', '--cached', '--name-only')).trim()) return;
    if (await this.guardMassDeletions('untrackIgnored')) {
      // All or nothing: a partially staged untrack rides the next flush as unexplained deletions.
      await this.git('reset', '-q', 'HEAD').catch(e => console.error(`${TAG} Resetting a blocked untrack failed:`, (e as Error).message));
      return;
    }
    const msg = files.length
      ? `data-sync: refresh .gitignore, untrack ${files.length} now-ignored file(s)`
      : 'data-sync: refresh .gitignore';
    await this.git('commit', '-m', msg).catch(() => {});
    await this.git('push', 'origin', this.options.branch).catch(err => {
      console.warn(`${TAG} Push after untrack failed:`, (err as Error).message);
    });
    console.log(`${TAG} ${msg}`);
  }

  /** Verify this instance owns the remote data repo. Write ID on first run, block on mismatch. */
  private verifyDeploymentId(): boolean {
    const idPath = path.join(DATA_DIR, DEPLOYMENT_ID_FILE);
    const localId = this.options.deploymentId;
    if (!localId) {
      console.warn(`${TAG} No APP_NAME set — deployment identity guard disabled`);
      return true;
    }
    if (!existsSync(idPath)) {
      writeFileSync(idPath, localId + '\n');
      console.log(`${TAG} Wrote deployment identity: ${localId}`);
      return true;
    }
    const remoteId = readFileSync(idPath, 'utf-8').trim();
    if (remoteId === localId) return true;
    console.error(`${TAG} 🚫 DEPLOYMENT IDENTITY MISMATCH: local="${localId}" remote="${remoteId}" — refusing to sync`);
    this.notifyOwners(
      `🚫 Deployment identity mismatch!\n\nLocal: \`${localId}\`\nData dir: \`${remoteId}\`\n\nA different shraga instance tried to sync to this data repo. Push blocked.`,
    ).catch(err => console.warn(`${TAG} Identity mismatch notify failed:`, (err as Error).message));
    return false;
  }

  private async configureGit(): Promise<void> {
    const name = process.env.APP_NAME || 'shraga';
    await this.git('config', 'user.name', `${name} agent`).catch(() => {});
    await this.git('config', 'user.email', `agent@${name}.local`).catch(() => {});
    // The data repo must behave identically on every host: no per-user global gitignore.
    await this.git('config', 'core.excludesFile', '/dev/null').catch(() => {});
  }

  private authedUrl(): string {
    const url = this.options.repoUrl;
    const token = process.env.GITHUB_TOKEN;
    if (token && url.startsWith('https://')) {
      return url.replace('https://', `https://x-access-token:${token}@`);
    }
    return url;
  }

  private async git(...args: string[]): Promise<string> {
    return this.spawn('git', args, DATA_DIR);
  }

  private async spawn(cmd: string, args: string[], cwd = DATA_DIR): Promise<string> {
    const proc = Bun.spawn([cmd, ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    if (code !== 0) throw new Error(`${cmd} ${args[0]} failed (${code}): ${stderr.trim() || stdout.trim()}`);
    return stdout;
  }
}

export const dataSync = new DataSync();
