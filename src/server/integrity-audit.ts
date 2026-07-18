/**
 * Data integrity audit — compares current data/ against a git reference.
 * Detects: missing files, truncated content, degraded JSON arrays/objects, invalid JSON.
 *
 * CLI:    bun run src/server/integrity-audit.ts [git-ref] [data-dir]
 * API:    import { audit } from './integrity-audit.ts'
 * Remote: run `bun run src/server/integrity-audit.ts` from $APP_DIR on the target host.
 *
 * When no ref is given, picks the most recent "auto: sync" commit as baseline.
 * Exit code 1 if issues found.
 */

import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { readdirSync } from 'node:fs';

// Self-contained: resolve DATA_DIR without importing paths.ts so the script works standalone.
// Guard (mirrors paths.ts): never silently fall back to bare ./data when named env dirs (data-*)
// exist — that targets a stale, env-less data/ folder. An explicit [data-dir]/DATA_DIR overrides.
function resolveDataDir(): string {
  if (process.argv[3]) return process.argv[3];
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  const root = process.cwd();
  if (readdirSync(root).some((f) => f.startsWith('data-')))
    throw new Error('DATA_DIR not set but named data dirs exist (data-*). Pass [data-dir] or set DATA_DIR.');
  return resolve(root, 'data');
}
const DATA_DIR = resolveDataDir();

const SIZE_RATIO = 0.5;
const COUNT_SLACK = 2;
const STRUCTURAL_JSON = ['schedules.json', 'contacts.json', 'skills-defaults.json', 'api-keys.json'];

function git(cmd: string): string {
  return execSync(`git -C "${DATA_DIR}" ${cmd}`, { encoding: 'utf-8' }).trim();
}

function gitShow(ref: string, file: string): string | null {
  try { return execSync(`git -C "${DATA_DIR}" show ${ref}:${file}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }); }
  catch { return null; }
}

function jsonEntryCount(text: string): number | null {
  try {
    const v = JSON.parse(text);
    if (Array.isArray(v)) return v.length;
    if (v && typeof v === 'object') return Object.keys(v).length;
    return null;
  } catch { return null; }
}

export interface Issue {
  file: string;
  kind: 'missing' | 'truncated' | 'degraded' | 'invalid-json';
  detail: string;
}

export function audit(ref: string): Issue[] {
  const issues: Issue[] = [];
  const lsBlobs = (r: string) => git(`ls-tree -r ${r}`)
    .split('\n').filter(Boolean)
    .filter(l => !l.startsWith('160000 '))     // skip submodule gitlinks
    .map(l => l.split('\t')[1]);
  const refFiles = lsBlobs(ref);
  const curSet = new Set(lsBlobs('HEAD'));

  for (const f of refFiles) {
    if (!curSet.has(f)) {
      issues.push({ file: f, kind: 'missing', detail: 'in reference but not HEAD' });
      continue;
    }
    const refContent = gitShow(ref, f);
    const curContent = gitShow('HEAD', f);
    if (!refContent || !curContent) continue;

    // Size check
    if (refContent.length > 200 && curContent.length < refContent.length * SIZE_RATIO) {
      issues.push({ file: f, kind: 'truncated', detail: `${refContent.length}B → ${curContent.length}B (${Math.round(curContent.length / refContent.length * 100)}%)` });
    }

    // Structural JSON check
    if (STRUCTURAL_JSON.includes(f)) {
      const refCount = jsonEntryCount(refContent);
      const curCount = jsonEntryCount(curContent);
      if (refCount !== null && curCount !== null && curCount < refCount - COUNT_SLACK) {
        issues.push({ file: f, kind: 'degraded', detail: `${refCount} → ${curCount} entries` });
      }
    }
  }

  // Invalid JSON check on all current .json files
  for (const f of curSet) {
    if (!f.endsWith('.json')) continue;
    const content = gitShow('HEAD', f);
    if (!content) continue;
    try { JSON.parse(content); }
    catch { issues.push({ file: f, kind: 'invalid-json', detail: 'parse error' }); }
  }

  return issues;
}

export function findBaselineRef(): string {
  try {
    const log = git('log --oneline -50 --format=%H\\ %s');
    for (const line of log.split('\n')) {
      const [hash, ...rest] = line.split(' ');
      const msg = rest.join(' ');
      if (msg.startsWith('auto: sync')) return hash;
    }
  } catch { /* no git history */ }
  return 'HEAD~1';
}

// ── CLI ────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const ref = process.argv[2] || findBaselineRef();
  console.log(`data-audit: HEAD vs ${ref.slice(0, 8)} (${DATA_DIR})\n`);

  const issues = audit(ref);
  if (!issues.length) {
    console.log('✓ No issues found');
    process.exit(0);
  }

  console.log(`⚠ ${issues.length} issue(s):\n`);
  for (const { kind, file, detail } of issues) {
    console.log(`  ${kind.padEnd(12)} ${file} — ${detail}`);
  }
  process.exit(1);
}
