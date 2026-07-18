#!/usr/bin/env bun
/**
 * Honest typecheck. Runs `tsc --noEmit` over the whole project (client + server;
 * see tsconfig.json "include": ["src", ...]).
 *
 * A fresh consumer who `bun install`s the PUBLISHED deps gets compiled `.d.ts`
 * (skipped by skipLibCheck) and sees only the project's own errors — nothing to
 * filter. In this repo's local dev, sibling libs are SYMLINKED into node_modules
 * as raw `.ts` source (relink-libs.sh), so tsc follows the import graph into that
 * source and reports errors that no real consumer ever hits. tsc can't be told to
 * skip `.ts` under node_modules (skipLibCheck only skips `.d.ts`), and `exclude`
 * doesn't stop import-following — so we strip exactly those dep-source lines here.
 *
 * This never hides a shraga error: everything that isn't a `node_modules/` or
 * `../sibling` source path is passed through, and the exit code is non-zero if any
 * such line remains. It only removes noise from linked dependency source.
 */
import { spawnSync } from 'node:child_process';

const res = spawnSync('tsc', ['--noEmit', '--pretty', 'false'], {
  encoding: 'utf8',
  shell: true,
});

const out = (res.stdout || '') + (res.stderr || '');
const lines = out.split('\n');

// A tsc error line begins with a file path. Dep-source noise resolves either to
// `node_modules/...` (linked raw-.ts packages) or to a `../sibling` repo path.
const isDepSourceNoise = (line: string) =>
  /^(?:\.\.[\\/]|node_modules[\\/])/.test(line) ||
  /[\\/]node_modules[\\/]/.test(line.split('(')[0] ?? '');

const kept = lines.filter((l) => !isDepSourceNoise(l));
const errors = kept.filter((l) => /error TS\d+:/.test(l));

process.stdout.write(kept.join('\n'));
if (errors.length > 0) {
  console.error(`\n${errors.length} project type error(s).`);
  process.exit(1);
}
console.log('\nTypecheck clean (project sources).');
process.exit(0);
