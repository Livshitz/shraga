import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SelfUpgrade } from '../self-upgrade/index.ts';

// The preflight is the safety of this feature: once the supervisor is detached it will happily
// rewrite package.json and bounce the service, so every "don't" has to be caught BEFORE the
// hand-off. These tests drive the real blocker logic against real directory layouts.

const made: string[] = [];
function deployment(pkg: Record<string, unknown>, opts: { link?: boolean; nodeModules?: boolean } = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), 'shraga-upgrade-'));
  made.push(root);
  writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg, null, 2));
  if (opts.link || opts.nodeModules) {
    mkdirSync(path.join(root, 'node_modules'), { recursive: true });
    const target = path.join(root, 'node_modules', 'shraga');
    if (opts.link) {
      const real = mkdtempSync(path.join(tmpdir(), 'shraga-checkout-'));
      made.push(real);
      symlinkSync(real, target);
    } else {
      mkdirSync(target, { recursive: true });
    }
  }
  return root;
}

function subject(appRoot: string, over: Record<string, unknown> = {}) {
  return new SelfUpgrade({
    appRoot,
    restartCmd: 'true',
    reportFile: path.join(appRoot, '.self-upgrade', 'report.json'),
    lockFile: path.join(appRoot, '.self-upgrade', 'in-flight.json'),
    ...over,
  });
}

afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('SelfUpgrade preflight', () => {
  test('reads the pinned version, ignoring a range prefix', () => {
    const root = deployment({ dependencies: { shraga: '^0.1.33' } });
    expect(subject(root).currentVersion()).toBe('0.1.33');
  });

  test('a clean npm consumer has no blockers', () => {
    const root = deployment({ dependencies: { shraga: '0.1.33' } }, { nodeModules: true });
    expect(subject(root).blockers()).toEqual([]);
  });

  test('refuses a source checkout (shraga is not a dependency of itself)', () => {
    const root = deployment({ name: 'shraga', version: '0.1.33' });
    expect(subject(root).blockers().join()).toContain('not a declared dependency');
  });

  test('refuses when node_modules/shraga is a dev symlink', () => {
    const root = deployment({ dependencies: { shraga: '0.1.33' } }, { link: true });
    expect(subject(root).blockers().join()).toContain('symlink');
  });

  test('refuses without a restart command — an installed version would never run', () => {
    const root = deployment({ dependencies: { shraga: '0.1.33' } }, { nodeModules: true });
    expect(subject(root, { restartCmd: '' }).blockers().join()).toContain('restart command');
  });

  test('refuses while another upgrade is in flight, but ignores an abandoned marker', () => {
    const root = deployment({ dependencies: { shraga: '0.1.33' } }, { nodeModules: true });
    const lockFile = path.join(root, 'in-flight.json');
    writeFileSync(lockFile, JSON.stringify({ target: '0.1.40', startedAt: 'now', at: Date.now() }));
    expect(subject(root, { lockFile }).blockers().join()).toContain('already in flight');

    writeFileSync(lockFile, JSON.stringify({ target: '0.1.40', startedAt: 'old', at: Date.now() - 60 * 60 * 1000 }));
    expect(subject(root, { lockFile }).blockers()).toEqual([]);
  });

  test('refuses when the supervisor script is missing — a detached spawn fails invisibly', () => {
    const root = deployment({ dependencies: { shraga: '0.1.33' } }, { nodeModules: true });
    const blockers = subject(root, { supervisorScript: path.join(root, 'nope.sh') }).blockers();
    expect(blockers.join()).toContain('supervisor missing');
  });

  test('refuses when python3 is unavailable — the supervisor edits package.json with it', () => {
    const root = deployment({ dependencies: { shraga: '0.1.33' } }, { nodeModules: true });
    const blockers = subject(root, { hasPython3: () => false }).blockers();
    expect(blockers.join()).toContain('python3');
  });

  test('start() refuses a blocked deployment without spawning anything', async () => {
    const root = deployment({ dependencies: { shraga: '0.1.33' } }, { link: true });
    const s = subject(root);
    const plan = await s.start({ version: '0.1.40' });
    expect(plan.started).toBe(false);
    expect(plan.reason).toContain('symlink');
    expect(existsSync(path.join(root, '.self-upgrade', 'in-flight.json'))).toBe(false);
  });

  test('start() is a no-op when already on the requested version', async () => {
    const root = deployment({ dependencies: { shraga: '0.1.33' } }, { nodeModules: true });
    const plan = await subject(root).start({ version: '0.1.33' });
    expect(plan.started).toBe(false);
    expect(plan.reason).toContain('already on 0.1.33');
  });
});

describe('SelfUpgrade report delivery', () => {
  test('delivers a report exactly once — a second boot has nothing left to announce', () => {
    const root = deployment({ dependencies: { shraga: '0.1.33' } }, { nodeModules: true });
    const reportFile = path.join(root, 'report.json');
    writeFileSync(reportFile, JSON.stringify({
      status: 'reverted', detail: 'failed verification', from: '0.1.33', target: '0.1.34',
      installed: '0.1.33', package: 'shraga', log: '/tmp/x.log', finishedAt: '2026-08-16T00:00:00Z',
    }));
    const s = subject(root, { reportFile });

    expect(s.deliverPendingReport()?.status).toBe('reverted');
    expect(s.deliverPendingReport()).toBeNull();
  });
});

// The supervisor is a shell script that runs detached, so it is exercised the only honest way:
// by running it, against a fake deployment and a fake health endpoint we control.
describe('supervisor.sh', () => {
  const script = path.join(import.meta.dir, '..', 'self-upgrade', 'supervisor.sh');

  async function runSupervisor(env: Record<string, string>, healthVersion: () => string | null) {
    const server = Bun.serve({
      port: 0,
      fetch() {
        const v = healthVersion();
        return v === null ? new Response('down', { status: 503 }) : Response.json({ version: v });
      },
    });
    try {
      const proc = Bun.spawn(['bash', script], {
        env: { ...process.env, HEALTH_URL: `http://127.0.0.1:${server.port}/api/version`, ...env },
        stdout: 'pipe', stderr: 'pipe',
      });
      await proc.exited;
    } finally { server.stop(true); }
  }

  test('reverts package.json when the new version never reports in', async () => {
    const root = deployment({ dependencies: { shraga: '0.1.33' } }, { nodeModules: true });
    const report = path.join(root, 'report.json');
    // `bun install` is stubbed with `true` and the "service" never flips version: the upgrade must
    // fail verification and the pin must come back to where it started.
    await runSupervisor({
      APP_ROOT: root, PKG: 'shraga', TARGET: '0.1.99', FROM: '0.1.33',
      RESTART_CMD: 'true', REPORT: report, BUN: 'true', BOOT_TIMEOUT: '5', SOAK: '1',
    }, () => '0.1.33');

    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(pkg.dependencies.shraga).toBe('0.1.33');
    expect(JSON.parse(readFileSync(report, 'utf8')).status).toBe('reverted');
  }, 30_000);

  test('reports ok and leaves the new pin in place when the version flips and soaks', async () => {
    const root = deployment({ dependencies: { shraga: '0.1.33' } }, { nodeModules: true });
    const report = path.join(root, 'report.json');
    await runSupervisor({
      APP_ROOT: root, PKG: 'shraga', TARGET: '0.1.99', FROM: '0.1.33',
      RESTART_CMD: 'true', REPORT: report, BUN: 'true', BOOT_TIMEOUT: '15', SOAK: '1',
    }, () => '0.1.99');

    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(pkg.dependencies.shraga).toBe('0.1.99');
    const r = JSON.parse(readFileSync(report, 'utf8'));
    expect(r.status).toBe('ok');
    expect(r.installed).toBe('0.1.99');
  }, 30_000);

  test('refuses to edit an ambiguous package.json rather than guessing which pin is the dep', async () => {
    // The same name under both dependencies and overrides: a first-match text edit would silently
    // rewrite whichever came first. Nothing may be touched, and nothing may be restarted.
    const root = deployment({
      dependencies: { shraga: '0.1.33' },
      overrides: { shraga: '0.1.33' },
    }, { nodeModules: true });
    const report = path.join(root, 'report.json');
    const restartMarker = path.join(root, 'restarted');
    const before = readFileSync(path.join(root, 'package.json'), 'utf8');

    await runSupervisor({
      APP_ROOT: root, PKG: 'shraga', TARGET: '0.1.99', FROM: '0.1.33',
      RESTART_CMD: `touch ${restartMarker}`, REPORT: report, BUN: 'true', BOOT_TIMEOUT: '5', SOAK: '1',
    }, () => '0.1.33');

    expect(readFileSync(path.join(root, 'package.json'), 'utf8')).toBe(before);
    expect(existsSync(restartMarker)).toBe(false);
    expect(JSON.parse(readFileSync(report, 'utf8')).status).toBe('failed');
  }, 30_000);

  test('refuses when package.json does not hold the version it was told to expect', async () => {
    // Guards a stale plan: something else moved the pin between the preflight and the hand-off.
    const root = deployment({ dependencies: { shraga: '0.1.40' } }, { nodeModules: true });
    const report = path.join(root, 'report.json');
    await runSupervisor({
      APP_ROOT: root, PKG: 'shraga', TARGET: '0.1.99', FROM: '0.1.33',
      RESTART_CMD: 'true', REPORT: report, BUN: 'true', BOOT_TIMEOUT: '5', SOAK: '1',
    }, () => '0.1.40');

    expect(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).dependencies.shraga).toBe('0.1.40');
    expect(JSON.parse(readFileSync(report, 'utf8')).status).toBe('failed');
  }, 30_000);

  test('a failed install reverts and never restarts a half-installed tree', async () => {
    const root = deployment({ dependencies: { shraga: '0.1.33' } }, { nodeModules: true });
    const report = path.join(root, 'report.json');
    const restartMarker = path.join(root, 'restarted');
    await runSupervisor({
      APP_ROOT: root, PKG: 'shraga', TARGET: '0.1.99', FROM: '0.1.33',
      RESTART_CMD: `touch ${restartMarker}`, REPORT: report, BUN: 'false', BOOT_TIMEOUT: '5', SOAK: '1',
    }, () => '0.1.33');

    expect(existsSync(restartMarker)).toBe(false);
    expect(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).dependencies.shraga).toBe('0.1.33');
    expect(JSON.parse(readFileSync(report, 'utf8')).status).toBe('failed');
  }, 30_000);
});

// Route wiring: proves the endpoints are actually mounted and gated. The preflight tests above run
// the class directly, which would still pass if the routes were never registered.
describe('self-upgrade routes', () => {
  test('both routes exist and refuse an unauthenticated caller', async () => {
    const { __resetExtensionsForTest } = await import('../extensions.ts');
    const { __resetEventBusForTest } = await import('../events/bus.ts');
    __resetExtensionsForTest();
    __resetEventBusForTest();
    const { createShraga } = await import('../../index.ts');

    const port = await new Promise<number>((resolve, reject) => {
      const s = require('node:net').createServer();
      s.once('error', reject);
      s.listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); });
    });

    const app = createShraga({ port, authProvider: 'local', passive: true, installSignalHandlers: false });
    await app.start();
    try {
      for (const init of [undefined, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }]) {
        const res = await fetch(`http://localhost:${port}/api/self-upgrade`, init as RequestInit);
        expect(res.status).not.toBe(404);      // mounted
        expect(res.status).toBeGreaterThanOrEqual(400);  // and not open
      }
    } finally { await app.stop(); }
  }, 60_000);
});
