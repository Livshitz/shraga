import { readdirSync, lstatSync, readlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { $ } from 'bun';

const TAG = '[vendor-sync]';
const VENDOR_DIR = resolve(import.meta.dir, '../../vendor');

export async function syncVendorRepos(): Promise<void> {
  let entries: string[];
  try {
    entries = readdirSync(VENDOR_DIR);
  } catch {
    return;
  }

  const dirs = entries.filter(e => {
    const full = join(VENDOR_DIR, e);
    try {
      const stat = lstatSync(full);
      if (!stat.isSymbolicLink()) return false;
      const target = resolve(VENDOR_DIR, readlinkSync(full));
      return lstatSync(target).isDirectory();
    } catch { return false; }
  });

  if (!dirs.length) return;

  const results = await Promise.allSettled(
    dirs.map(async name => {
      const target = resolve(VENDOR_DIR, readlinkSync(join(VENDOR_DIR, name)));
      const gitDir = join(target, '.git');
      try { lstatSync(gitDir); } catch { return; }
      // skip branches with no upstream (e.g. local feature branches) — pull would always fail
      const upstream = await $`git -C ${target} rev-parse --abbrev-ref @{u}`.nothrow().quiet();
      if (upstream.exitCode !== 0) {
        const branch = (await $`git -C ${target} branch --show-current`.nothrow().quiet()).stdout.toString().trim();
        console.log(`${TAG} ${name}: skipped (branch '${branch}' has no upstream)`);
        return;
      }
      const { stdout, exitCode } = await $`git -C ${target} pull --ff-only 2>&1`.nothrow().quiet();
      const out = stdout.toString().trim();
      if (exitCode !== 0) {
        console.warn(`${TAG} ${name}: pull failed — ${out}`);
      } else if (!out.includes('Already up to date')) {
        console.log(`${TAG} ${name}: ${out.split('\n').pop()}`);
      }
    })
  );

  const failed = results.filter(r => r.status === 'rejected').length;
  if (failed) console.warn(`${TAG} ${failed} repo(s) failed to sync`);
}
