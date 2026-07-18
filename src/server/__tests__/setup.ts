// Test preload (see bunfig.toml). Runs BEFORE any test module is imported.
//
// `paths.ts` captures DATA_DIR into a module-level const on first import, and Bun shares one
// module registry across test files. So whichever test file imported paths.ts first used to win
// the race, and the others silently ran against a DATA_DIR they didn't create. Minting one temp
// DATA_DIR here — before anything can import paths.ts — makes that deterministic.
//
// DATA_DIR is `<root>/data`, not `<root>`, so that dirname(DATA_DIR) is a real isolated app root
// (the anchor the scheduler's promptFile resolution relies on) rather than the shared os tmpdir.
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

if (!process.env.SHRAGA_TEST_ROOT) {
  const root = mkdtempSync(path.join(tmpdir(), 'shraga-tests-'));
  const dataDir = path.join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  process.env.SHRAGA_TEST_ROOT = root;
  process.env.DATA_DIR = dataDir;
  process.on('exit', () => rmSync(root, { recursive: true, force: true }));
}
