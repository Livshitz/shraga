// Self-upgrade — re-pin Shraga's own package version in the deployment, restart, verify, and revert
// automatically if the new version doesn't come back healthy.
//
// SHAPE: this module only PREFLIGHTS and HANDS OFF. The upgrade itself runs in a detached
// supervisor.sh, because the restart kills this process — code that dies mid-operation cannot verify
// or roll back its own work. Everything risky lives in the script; everything that decides whether
// the attempt is even allowed lives here, where it can be tested and can answer the caller.
//
// USER-REQUESTED ONLY by design. There is no timer in this module: `POST /api/self-upgrade` is the
// entry point. Deployments that want it scheduled can point a schedule at that route, which keeps
// the "should I upgrade tonight?" policy out of the mechanism.
import { existsSync, lstatSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { APP_ROOT, PACKAGE_ROOT, dataPath } from '../paths.ts';
import { emitEvent } from '../events/bus.ts';
import { notifyOwners } from '../notify-owners.ts';

const TAG = '[self-upgrade]';
const PKG = 'shraga';

export class SelfUpgrade {
  public constructor(public options?: Partial<SelfUpgradeOptions>) {
    this.options = { ...new SelfUpgradeOptions(), ...options };
  }

  private get o(): SelfUpgradeOptions { return this.options as SelfUpgradeOptions; }

  private watching = false;

  /** Version of `pkg` this deployment currently has pinned in its app-root package.json. */
  public currentVersion(): string | null {
    try {
      const pkg = JSON.parse(readFileSync(path.join(this.o.appRoot, 'package.json'), 'utf8'));
      const dep = pkg.dependencies?.[this.o.pkg] ?? pkg.devDependencies?.[this.o.pkg];
      return typeof dep === 'string' ? dep.replace(/^[\^~]/, '') : null;
    } catch { return null; }
  }

  /** Latest version on the registry. Plain HTTP against the registry — no npm CLI, no auth needed
   *  for a public package, and it works the same on a box with no npm installed. */
  public async latestVersion(): Promise<string> {
    const res = await fetch(`${this.o.registry}/${this.o.pkg}/latest`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`registry lookup failed: ${res.status} ${res.statusText}`);
    const body = await res.json() as { version?: string };
    if (!body.version) throw new Error('registry returned no version');
    return body.version;
  }

  public async versionExists(version: string): Promise<boolean> {
    const res = await fetch(`${this.o.registry}/${this.o.pkg}/${version}`, { signal: AbortSignal.timeout(15_000) });
    return res.ok;
  }

  /** Everything that must be true before we are willing to touch the deployment. Returns the reasons
   *  it is NOT safe; empty array = go. Each check exists because of a way this can go wrong:
   *   - not an npm consumer  → there is no dep pin to move (source checkout); upgrading means `git pull`.
   *   - linked dependency    → node_modules/<pkg> is a dev symlink to a working checkout. Installing
   *                            would silently replace live local source with a registry build.
   *   - no restart command   → we could install a new version and never run it, leaving the pin and
   *                            the running process disagreeing with no way to reconcile.
   *   - upgrade in flight    → two supervisors racing on package.json is how you get a tree that
   *                            matches neither version. */
  public blockers(): string[] {
    const reasons: string[] = [];
    const pkgPath = path.join(this.o.appRoot, 'package.json');

    if (!existsSync(pkgPath)) {
      reasons.push(`no package.json at ${this.o.appRoot} — nothing to re-pin`);
    } else if (!this.currentVersion()) {
      reasons.push(`${this.o.pkg} is not a declared dependency of ${pkgPath} — this looks like a source checkout, upgrade it with git`);
    }

    const linkPath = path.join(this.o.appRoot, 'node_modules', this.o.pkg);
    try {
      if (lstatSync(linkPath).isSymbolicLink()) {
        reasons.push(`node_modules/${this.o.pkg} is a symlink (local dev link) — installing would replace live local source with a registry build`);
      }
    } catch { /* absent is fine: install will create it */ }

    if (!this.o.restartCmd) {
      reasons.push('no restart command configured (RESTART_CMD / SHRAGA_RESTART_CMD) — an installed version could never be started');
    }

    // The supervisor is detached with stdio ignored, so a missing script fails INVISIBLY: nothing
    // happens, no report is ever written, and the in-flight marker sits there until it ages out.
    if (!existsSync(this.o.supervisorScript)) {
      reasons.push(`upgrade supervisor missing at ${this.o.supervisorScript}`);
    }

    // The supervisor needs python3 to edit package.json. Better to say so now than to find out
    // mid-upgrade, with the pin already rewritten.
    if (!this.o.hasPython3()) {
      reasons.push('python3 not found on PATH — the upgrade supervisor needs it to edit package.json');
    }

    const active = this.inFlight();
    if (active) reasons.push(`an upgrade to ${active.target} is already in flight (started ${active.startedAt})`);

    return reasons;
  }

  /** The in-flight marker, or null. Stale markers (older than maxRunMs) are ignored rather than
   *  blocking forever — a supervisor killed by a reboot must not wedge the feature permanently. */
  public inFlight(): { target: string; startedAt: string } | null {
    try {
      const lock = JSON.parse(readFileSync(this.o.lockFile, 'utf8')) as { target: string; startedAt: string; at: number };
      if (Date.now() - lock.at > this.o.maxRunMs) return null;
      return { target: lock.target, startedAt: lock.startedAt };
    } catch { return null; }
  }

  /**
   * Start an upgrade. Resolves as soon as the supervisor is detached — the result arrives later, in
   * the report file, because this process is about to be restarted by that supervisor.
   */
  public async start(opts: { version?: string } = {}): Promise<UpgradePlan> {
    const from = this.currentVersion();
    const target = !opts.version || opts.version === 'latest' ? await this.latestVersion() : opts.version.replace(/^v/, '');

    const blockers = this.blockers();
    if (blockers.length) return { started: false, from, target, reason: blockers.join('; ') };
    if (from === target) return { started: false, from, target, reason: `already on ${target}` };
    if (!await this.versionExists(target)) return { started: false, from, target, reason: `${this.o.pkg}@${target} does not exist on the registry` };

    mkdirSync(path.dirname(this.o.reportFile), { recursive: true });
    writeFileSync(this.o.lockFile, JSON.stringify({ target, startedAt: new Date().toISOString(), at: Date.now() }));

    let child;
    try {
      // detached + ignored stdio: the supervisor must outlive us, and it will — we are its first
      // casualty. It logs to a file of its own (see supervisor.sh).
      child = spawn('bash', [this.o.supervisorScript], {
        cwd: this.o.appRoot,
        detached: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          APP_ROOT: this.o.appRoot,
          PKG: this.o.pkg,
          TARGET: target,
          FROM: from ?? '',
          RESTART_CMD: this.o.restartCmd,
          HEALTH_URL: this.o.healthUrl,
          REPORT: this.o.reportFile,
          BUN: this.o.bun,
          BOOT_TIMEOUT: String(this.o.bootTimeoutSec),
          SOAK: String(this.o.soakSec),
        },
      });
      child.unref();
    } catch (err) {
      // Nothing was started, so the marker would otherwise block every retry until it ages out.
      try { unlinkSync(this.o.lockFile); } catch { /* best effort */ }
      return { started: false, from, target, reason: `could not start the upgrade supervisor: ${(err as Error).message}` };
    }

    console.log(`${TAG} handed off ${this.o.pkg} ${from} -> ${target} to supervisor pid ${child.pid}`);
    return { started: true, from, target, reason: `upgrading to ${target}; the result will be reported when the server comes back` };
  }

  /** Read the report left by the last supervisor run, if any. */
  public lastReport(): UpgradeReport | null {
    try { return JSON.parse(readFileSync(this.o.reportFile, 'utf8')) as UpgradeReport; }
    catch { return null; }
  }

  /**
   * Call once at boot. A finished upgrade is only observable AFTER the restart, so this is where the
   * outcome finally reaches a human: the report is turned into an event, and the deployment's own
   * notifier trigger (the same path scheduled-job failures use) DMs the owner. Consuming the report
   * — deleting it — is what makes the delivery exactly-once across restarts.
   */
  public deliverPendingReport(): UpgradeReport | null {
    const report = this.lastReport();
    if (!report) {
      // The supervisor writes the report only AFTER this process has booted and soaked, so on a
      // successful upgrade there is NOTHING here yet — boot always loses the race. Without this
      // watch the outcome DM was never delivered, and the in-flight marker sat until it aged out
      // (30m), blocking every retry in between. Keep watching while the marker is live.
      if (this.inFlight()) this.watchForReport();
      return null;
    }
    try { unlinkSync(this.o.reportFile); } catch { /* report already gone; emit anyway */ }
    // Clear the marker only if it belongs to THIS report. A boot can find a leftover report from
    // the previous upgrade while a NEW one is already in flight (that is exactly the sequence when
    // two upgrades run back to back) — deleting that marker would unguard the live attempt.
    const marker = this.inFlight();
    if (!marker || marker.target === report.target) {
      try { unlinkSync(this.o.lockFile); } catch { /* no lock to clear */ }
    }

    console.log(`${TAG} ${report.status}: ${report.detail}`);
    emitEvent('self-upgrade.finished', report);
    // ...and actually tell a human. The event alone reached nobody: no subscriber existed, so every
    // upgrade outcome — including `revert-failed`, which needs hands — was silently dropped.
    const icon = report.status === 'ok' ? '✅' : report.status === 'reverted' ? '↩️' : '🚨';
    notifyOwners('self-upgrade', `${icon} Self-upgrade ${report.status}: ${report.detail}\n\n` +
      `${report.package} ${report.from} → ${report.target} (now on ${report.installed})\nLog: \`${report.log}\``)
      .catch(err => console.warn(`${TAG} could not notify owners:`, (err as Error).message));
    return report;
  }

  /** Poll until the supervisor's report lands (or its marker ages out), then deliver it exactly
   *  once. Unref'd: a pending upgrade watch must never hold the process open. */
  private watchForReport(): void {
    if (this.watching) return;
    this.watching = true;
    const timer = setInterval(() => {
      if (!this.inFlight()) { clearInterval(timer); this.watching = false; return; } // aged out
      if (!existsSync(this.o.reportFile)) return;
      clearInterval(timer);
      this.watching = false;
      this.deliverPendingReport();
    }, this.o.reportPollMs);
    timer.unref?.();
  }
}

export class SelfUpgradeOptions {
  /** The DEPLOYMENT root (holds package.json + node_modules) — never PACKAGE_ROOT, which for an npm
   *  consumer is node_modules/shraga and has no dep pin to move. */
  public appRoot: string = APP_ROOT;
  public pkg: string = PKG;
  public registry: string = process.env.SHRAGA_UPGRADE_REGISTRY?.trim() || 'https://registry.npmjs.org';
  public restartCmd: string = (process.env.SHRAGA_RESTART_CMD || process.env.RESTART_CMD || '').trim();
  public healthUrl: string = `http://127.0.0.1:${process.env.PORT || 3032}/api/version`;
  public bun: string = process.env.SHRAGA_BUN?.trim() || process.execPath || 'bun';
  /** Shipped inside src/, so it reaches npm consumers (package.json `files` includes src/). */
  public supervisorScript: string = path.join(PACKAGE_ROOT, 'src', 'server', 'self-upgrade', 'supervisor.sh');
  public reportFile: string = dataPath('.self-upgrade', 'report.json');
  public lockFile: string = dataPath('.self-upgrade', 'in-flight.json');
  /** How often the post-boot watch looks for the supervisor's report. */
  public reportPollMs: number = 5_000;
  public bootTimeoutSec: number = 180;
  public soakSec: number = 60;
  /** After this, an in-flight marker is treated as abandoned (supervisor killed by a reboot). */
  public maxRunMs: number = 30 * 60 * 1000;
  /** Injectable so the preflight is testable without depending on the test host's PATH. */
  public hasPython3: () => boolean = () => {
    try { return spawnSync('python3', ['--version'], { stdio: 'ignore' }).status === 0; }
    catch { return false; }
  };
}

export interface UpgradePlan {
  started: boolean;
  from: string | null;
  target: string;
  reason: string;
}

export interface UpgradeReport {
  status: 'ok' | 'reverted' | 'failed' | 'revert-failed';
  detail: string;
  from: string;
  target: string;
  installed: string;
  package: string;
  log: string;
  finishedAt: string;
}

declare module '../events/types.ts' {
  interface ShragaEventMap { 'self-upgrade.finished': UpgradeReport }
}
