/**
 * Data integrity audit — compares current data/ against a git reference.
 * Detects: missing files, truncated content, degraded JSON arrays/objects, invalid JSON.
 *
 * CLI:    bun run src/server/integrity-audit.ts [git-ref] [data-dir]
 * API:    import { audit } from './integrity-audit.ts'   (async — never blocks the event loop)
 * Remote: run `bun run src/server/integrity-audit.ts` from $APP_DIR on the target host.
 *
 * When no ref is given, picks the most recent "auto: sync" commit as baseline.
 * Exit code 1 if issues found.
 *
 * Proportional by design: only files that DIFFER between ref and HEAD are examined (an unchanged
 * file can't be missing, truncated or degraded, and its JSON validity was judged when it changed).
 * Work is ≤3 git processes total — `diff --raw`, one `cat-file --batch-check` (byte sizes for the
 * truncation check) and one `cat-file --batch` for changed .json only (≤16MB each) — regardless of
 * repo size. Non-JSON blobs (media/binaries) are never loaded into memory.
 * The old version ran `git show` via execSync for every tracked file (x2, plus every .json): on a
 * 4.4k-file prod data repo that froze the server's event loop for ~5 min after every restart.
 */

import { resolve } from 'node:path';
import { readdirSync } from 'node:fs';

// Self-contained: resolve DATA_DIR without importing paths.ts so the script works standalone.
// Guard (mirrors paths.ts): never silently fall back to bare ./data when named env dirs (data-*)
// exist — that targets a stale, env-less data/ folder. An explicit [data-dir]/DATA_DIR overrides.
function resolveDataDir(): string {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  const root = process.cwd();
  if (readdirSync(root).some((f) => f.startsWith('data-')))
    throw new Error('DATA_DIR not set but named data dirs exist (data-*). Pass [data-dir] or set DATA_DIR.');
  return resolve(root, 'data');
}

const SIZE_RATIO = 0.5;
const COUNT_SLACK = 2;
const STRUCTURAL_JSON = ['schedules.json', 'contacts.json', 'skills-defaults.json', 'api-keys.json'];
const MAX_JSON_BYTES = 16 * 1024 * 1024; // larger .json isn't read/parsed (bounds memory)
const GITLINK = '160000';   // submodule entry — not a blob
const ABSENT = '000000';    // side of an add/delete

async function git(dir: string, args: string[], input?: string): Promise<Uint8Array> {
  const proc = Bun.spawn(['git', '-C', dir, ...args], {
    stdin: input === undefined ? 'ignore' : new Blob([input]),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) throw new Error(`git ${args[0]} failed (${code}): ${err.trim()}`);
  return new Uint8Array(out);
}

// ignoreBOM keeps a leading BOM in the text, matching the old execSync decode (a BOM'd .json is invalid).
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });

/** Byte sizes of many objects through ONE `git cat-file --batch-check` (no content read). Missing omitted. */
async function blobSizes(dir: string, shas: string[]): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  if (!shas.length) return sizes;
  for (const line of decoder.decode(await git(dir, ['cat-file', '--batch-check'], shas.join('\n') + '\n')).split('\n')) {
    const [sha, type, size] = line.split(' ');
    if (type && type !== 'missing' && size !== undefined) sizes.set(sha, Number(size));
  }
  return sizes;
}

/** Read many blobs through ONE `git cat-file --batch` process. Missing objects are omitted. */
async function readBlobs(dir: string, shas: string[]): Promise<Map<string, string>> {
  const blobs = new Map<string, string>();
  if (!shas.length) return blobs;
  const buf = await git(dir, ['cat-file', '--batch'], shas.join('\n') + '\n');
  let pos = 0;
  while (pos < buf.length) {
    const nl = buf.indexOf(10, pos);
    if (nl < 0) break;
    const [sha, type, size] = decoder.decode(buf.subarray(pos, nl)).split(' ');
    pos = nl + 1;
    if (type === 'missing' || size === undefined) continue;
    const n = Number(size);
    blobs.set(sha, decoder.decode(buf.subarray(pos, pos + n)));
    pos += n + 1; // content + trailing LF
  }
  return blobs;
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

export async function audit(ref: string, dataDir = resolveDataDir()): Promise<Issue[]> {
  // `:oldmode newmode oldsha newsha status\0path\0` per changed path (renames split into D + A).
  // --relative: scope to dataDir and report paths relative to it (dataDir may be a subfolder of the repo).
  const tokens = decoder.decode(await git(dataDir, ['diff', '--raw', '-z', '--no-renames', '--no-abbrev', '--relative', ref, 'HEAD'])).split('\0');
  const changes: { file: string; oldMode: string; newMode: string; oldSha: string; newSha: string }[] = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const [oldMode, newMode, oldSha, newSha] = tokens[i].slice(1).split(' ');
    changes.push({ file: tokens[i + 1], oldMode, newMode, oldSha, newSha });
  }
  const isBlob = (mode: string) => mode !== GITLINK && mode !== ABSENT;

  // Sizes for every changed blob (cheap: headers only); content ONLY for small .json that needs parsing.
  // Loading every changed blob (media/binaries) into memory spiked RSS by GBs on large syncs.
  const sizes = await blobSizes(dataDir, [...new Set(changes.flatMap(c => [
    ...(isBlob(c.oldMode) ? [c.oldSha] : []), ...(isBlob(c.newMode) ? [c.newSha] : []),
  ]))]);
  const wanted = new Set<string>();
  const small = (sha: string) => (sizes.get(sha) ?? Infinity) <= MAX_JSON_BYTES;
  const skipped = (file: string, sha: string) =>
    console.warn(`[integrity-audit] skipped ${file}: ${sizes.get(sha)}B exceeds the ${MAX_JSON_BYTES}B JSON cap — not validated`);
  for (const c of changes) {
    if (!c.file.endsWith('.json') || !isBlob(c.newMode)) continue;
    if (!small(c.newSha)) { skipped(c.file, c.newSha); continue; }
    wanted.add(c.newSha);
    if (!isBlob(c.oldMode) || !STRUCTURAL_JSON.includes(c.file)) continue;
    if (small(c.oldSha)) wanted.add(c.oldSha);
    else skipped(c.file, c.oldSha);
  }
  const blobs = await readBlobs(dataDir, [...wanted]);

  const issues: Issue[] = [];
  const jsonIssues: Issue[] = [];
  for (const { file: f, oldMode, newMode, oldSha, newSha } of changes) {
    if (isBlob(oldMode) && !isBlob(newMode)) {
      issues.push({ file: f, kind: 'missing', detail: 'in reference but not HEAD' });
      continue;
    }
    const refSize = isBlob(oldMode) ? sizes.get(oldSha) : undefined;
    const curSize = isBlob(newMode) ? sizes.get(newSha) : undefined;
    const curContent = isBlob(newMode) ? blobs.get(newSha) : undefined;
    const refContent = isBlob(oldMode) ? blobs.get(oldSha) : undefined;

    // Size check (empty blobs are skipped, as before)
    if (refSize && curSize && refSize > 200 && curSize < refSize * SIZE_RATIO) {
      issues.push({ file: f, kind: 'truncated', detail: `${refSize}B → ${curSize}B (${Math.round(curSize / refSize * 100)}%)` });
    }

    if (refContent && curContent) {
      // Structural JSON check
      if (STRUCTURAL_JSON.includes(f)) {
        const refCount = jsonEntryCount(refContent);
        const curCount = jsonEntryCount(curContent);
        if (refCount !== null && curCount !== null && curCount < refCount - COUNT_SLACK) {
          issues.push({ file: f, kind: 'degraded', detail: `${refCount} → ${curCount} entries` });
        }
      }
    }

    // Invalid JSON check on added/modified .json files
    if (curContent && f.endsWith('.json')) {
      try { JSON.parse(curContent); }
      catch { jsonIssues.push({ file: f, kind: 'invalid-json', detail: 'parse error' }); }
    }
  }

  return [...issues, ...jsonIssues];
}

export async function findBaselineRef(dataDir = resolveDataDir()): Promise<string> {
  try {
    const log = decoder.decode(await git(dataDir, ['log', '-50', '--format=%H %s']));
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
  const dataDir = process.argv[3] || resolveDataDir();
  const ref = process.argv[2] || await findBaselineRef(dataDir);
  console.log(`data-audit: HEAD vs ${ref.slice(0, 8)} (${dataDir})\n`);

  const issues = await audit(ref, dataDir);
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
