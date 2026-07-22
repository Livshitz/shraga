import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths.ts';
import { emitEvent } from './events/bus.ts';

const TAG = '[data-sync]';
const DEPLOYMENT_ID_FILE = '.deployment-id';

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
}

export class DataSync {
  public options: DataSyncOptions;
  private pending = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pushing = false;
  private pulling = false;
  private pullPending = false;
  private ready = false;
  private warnedDisabled = false;

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
        if (await this.guardMassDeletions('init merge')) {
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
      await this.untrackIgnored();
      await this.configureGit();
      this.ready = true;
    }

    await this.pull();
    // Defer heavy sync I/O (reads all tracked files + execSync) to avoid blocking
    // WS connections and page loads during startup.
    setTimeout(() => {
      this.scanForConflictMarkers().catch(err => {
        console.warn(`${TAG} Post-init conflict scan failed:`, (err as Error).message);
      });
      this.runIntegrityAudit();
    }, 60_000);
  }

  /** Compare HEAD against HEAD~1 to catch regressions. Notifies owner — never auto-reverts. */
  private runIntegrityAudit(): void {
    try {
      const { audit } = require('./integrity-audit.ts');
      const issues = audit('HEAD~1') as { kind: string; file: string; detail: string }[];
      if (issues.length) {
        console.warn(`${TAG} ⚠️ DATA INTEGRITY: ${issues.length} issue(s) detected after sync:`);
        for (const { kind, file, detail } of issues) {
          console.warn(`${TAG}   ${kind} ${file} — ${detail}`);
        }
        const list = issues.slice(0, 20).map(i => `• [${i.kind}] ${i.file} — ${i.detail}`).join('\n');
        this.notifyOwners(
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
    const fileThreshold = parseInt(process.env.DATA_SYNC_DELETIONS_BLOCK || '10', 10);
    const shrinkThreshold = parseInt(process.env.DATA_SYNC_SHRINK_BLOCK || '50', 10);
    try {
      // (1) Mass FILE deletions.
      const out = await this.git('diff', '--cached', '--name-only', '--diff-filter=D');
      const deleted = out.split('\n').map(l => l.trim()).filter(Boolean);
      if (deleted.length > fileThreshold) {
        console.error(`${TAG} 🚫 BLOCKED mass deletion (${context}): ${deleted.length} file(s) — threshold is ${fileThreshold}`);
        const list = deleted.slice(0, 20).map(f => `• ${f}`).join('\n');
        await this.notifyOwners(
          `🚫 BLOCKED mass deletion in data/ (${context}): ${deleted.length} file(s) staged for deletion (threshold: ${fileThreshold})\n\n${list}` +
          (deleted.length > 20 ? `\n…and ${deleted.length - 20} more` : '') +
          `\n\nCommit was aborted. Manual intervention needed.`,
        );
        await this.git('reset', 'HEAD').catch(() => {});
        return true;
      }

      // (2) Large in-file content SHRINK — a single tracked file losing > shrinkThreshold NET lines
      //     (deleted − added). numstat: "<added>\t<deleted>\t<file>"; binary files show "-\t-".
      const numstat = await this.git('diff', '--cached', '--numstat');
      const shrunk: string[] = [];
      for (const line of numstat.split('\n').map(l => l.trim()).filter(Boolean)) {
        const [addRaw, delRaw, file] = line.split('\t');
        if (addRaw === '-' || delRaw === '-' || !file) continue; // binary
        const net = (parseInt(delRaw, 10) || 0) - (parseInt(addRaw, 10) || 0);
        if (net > shrinkThreshold) shrunk.push(`• ${file}  (−${net} net lines)`);
      }
      if (shrunk.length) {
        console.error(`${TAG} 🚫 BLOCKED large content shrink (${context}): ${shrunk.length} file(s) — net-removal threshold is ${shrinkThreshold}`);
        await this.notifyOwners(
          `🚫 BLOCKED large content shrink in data/ (${context}): a tracked file lost more than ${shrinkThreshold} net lines (guards against wiping shared data like contacts.json)\n\n${shrunk.slice(0, 20).join('\n')}` +
          `\n\nCommit was aborted. If intended, raise DATA_SYNC_SHRINK_BLOCK or commit manually.`,
        );
        await this.git('reset', 'HEAD').catch(() => {});
        return true;
      }
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

    // Stash dirty + untracked files before merging (untracked can block merge if remote adds same paths)
    const dirty = !!(await this.git('status', '--porcelain')).trim();
    if (dirty) {
      try {
        await this.git('stash', 'push', '--include-untracked', '-m', 'data-sync: pre-pull stash');
      } catch (err) {
        console.warn(`${TAG} Stash failed, skipping pull:`, (err as Error).message);
        return;
      }
    }

    try {
      await this.git('merge', `origin/${this.options.branch}`, '--no-edit');
      console.log(`${TAG} Pulled latest`);
    } catch {
      const conflicted = await this.getConflictedFiles();
      if (conflicted.length) {
        console.log(`${TAG} Merge conflicts in ${conflicted.length} file(s), resolving...`);
        await this.resolveConflicts(conflicted);
      } else {
        console.error(`${TAG} Merge failed for unknown reason, aborting`);
        await this.git('merge', '--abort').catch(() => {});
      }
    }

    if (dirty) await this.git('stash', 'pop').catch(err => {
      console.error(`${TAG} Stash pop failed — local changes may be stuck in git stash:`, (err as Error).message);
    });
    this.rebuildLog().catch(() => {});
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
    if (!this.pending.size || this.pushing) return;
    this.pushing = true;
    const files = [...this.pending];
    this.pending.clear();
    this.timer = null;

    try {
      for (const f of files) {
        const abs = path.join(DATA_DIR, f);
        if (existsSync(abs)) {
          await this.git('add', f);
        } else {
          await this.git('rm', '--cached', f).catch(() => {});
        }
      }

      const status = await this.git('status', '--porcelain');
      if (!status.trim()) { this.pushing = false; return; }

      if (await this.guardMassDeletions('flush')) { this.pushing = false; return; }
      const msg = await this.generateCommitMessage(files);
      await this.git('commit', '-m', msg).catch(() => {});
      const ahead = await this.git('rev-list', '--count', `origin/${this.options.branch}..HEAD`).catch(() => '0');
      if (parseInt(ahead.trim()) === 0) { this.pushing = false; return; }
      await this.git('push', 'origin', this.options.branch).catch(async (err) => {
        console.warn(`${TAG} Push failed, pulling first:`, (err as Error).message);
        await this.pull();
        await this.git('push', 'origin', this.options.branch);
      });
      console.log(`${TAG} Pushed: ${msg}`);
      this.rebuildLog().catch(() => {});
    } catch (err) {
      console.error(`${TAG} Commit/push failed:`, (err as Error).message);
    }
    this.pushing = false;
    if (this.pending.size && !this.timer) {
      this.timer = setTimeout(() => this.flush(), 2000);
    }
  }

  private async generateCommitMessage(files: string[]): Promise<string> {
    const fallback = `sync: ${files.join(', ')}`;
    try {
      const diff = await this.git('diff', '--cached', '--stat').catch(() => '');
      const diffContent = await this.git('diff', '--cached', '--no-color', '-U2').catch(() => '');
      if (!diffContent.trim()) return fallback;
      const truncated = diffContent.slice(0, 3000);
      const msg = await this.askClaude(
        'Write a concise git commit message (max 72 chars, no quotes, no prefix like "feat:" or "sync:") for this change to an AI agent\'s behavioral config.\n' +
        `Files: ${files.join(', ')}\nStats: ${diff}\n\nDiff:\n${truncated}`,
        'claude-haiku-4-5-20251001', 100,
      );
      const line = msg.split('\n')[0].trim().slice(0, 72);
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
        'claude-opus-4-6',
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
      for (const f of tracked) {
        const abs = path.join(DATA_DIR, f);
        try {
          if (!existsSync(abs) || statSync(abs).isDirectory()) continue;
          const content = readFileSync(abs, 'utf-8');
          if (/^<{7} /m.test(content)) conflicted.push(f);
        } catch { /* skip unreadable */ }
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
        'claude-opus-4-6',
      );

      const parsed = this.parseResolvedFiles(resolved);
      if (!parsed.length) {
        console.error(`${TAG} Could not parse conflict resolution, notifying owners`);
        await this.notifyOwners(
          `🚨 Found conflict markers in data/ but auto-resolution failed.\n\nFiles: ${conflicted.join(', ')}\n\nManual fix needed.`,
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

  private async notifyOwners(text: string): Promise<void> {
    // No Slack coupling here — resolve owner contacts and publish a deploy notice on the event bus.
    // The Slack feature (slackFeature) subscribes and DMs each owner. Owner resolution uses the
    // contacts store only, so data-sync stays transport-agnostic.
    const { getAll } = await import('./contacts.ts');
    const ownerEmails = (process.env.OWNERS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const owners = getAll()
      .filter(c => c.slackIds.length > 0 && c.emails.some(e => ownerEmails.includes(e.toLowerCase())))
      .map(c => ({ name: c.name, slackId: c.slackIds[0] }));
    if (!owners.length) {
      console.warn(`${TAG} No owners (OWNERS env) with Slack IDs found, skipping notification`);
      return;
    }
    emitEvent('data-sync', { kind: 'deploy', owners, text });
  }

  private async askClaude(prompt: string, model = 'claude-sonnet-5', maxTokens = 8192): Promise<string> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model, max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!resp.ok) throw new Error(`Anthropic API ${resp.status}: ${await resp.text()}`);
    const data = await resp.json() as { content: { type: string; text: string }[] };
    return data.content.find(b => b.type === 'text')?.text || '';
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
    const out = await this.git('ls-files', '-i', '-c', '--exclude-standard').catch(() => '');
    // Only untrack files that actually exist on disk AND match .gitignore.
    // git ls-files -i can falsely report tracked files missing from the worktree
    // (remote-only files restored during init). Removing those wipes remote data.
    const files = out.split('\n').map(l => l.trim()).filter(Boolean)
      .filter(f => existsSync(path.join(DATA_DIR, f)));
    if (files.length) {
      await this.git('rm', '--cached', '--', ...files).catch(err => {
        console.warn(`${TAG} Untrack ignored files failed:`, (err as Error).message);
      });
    }
    if (!(await this.git('diff', '--cached', '--name-only')).trim()) return;
    if (await this.guardMassDeletions('untrackIgnored')) return;
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
    if (code !== 0) throw new Error(`${cmd} ${args[0]} failed (${code}): ${stderr.trim()}`);
    return stdout;
  }
}

export const dataSync = new DataSync();
