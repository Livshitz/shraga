import { describe, test, expect, beforeAll } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// DATA_DIR is frozen into a const on first import of paths.ts, so it's minted by the test preload
// (bunfig.toml -> setup.ts) before any test module loads. Read it back rather than assume it.
const { DATA_DIR: dataDir } = await import('../paths.ts');
const appRoot = path.dirname(dataDir);

let resolvePromptFile: (p: string) => string;

beforeAll(async () => {
  // Safety net: these tests write fixture files under appRoot. If DATA_DIR ever resolved to the
  // real ./data (preload not applied), fail loudly instead of scribbling into the repo.
  expect(dataDir.startsWith(tmpdir())).toBe(true);
  ({ resolvePromptFile } = await import('../scheduler/runner.ts'));
});

describe('resolvePromptFile (schedule promptFile anchoring)', () => {
  test('absolute paths pass through untouched', () => {
    const abs = path.join(appRoot, 'anywhere.md');
    writeFileSync(abs, 'x');
    expect(resolvePromptFile(abs)).toBe(abs);
  });

  test('resolves app-root-relative form ("data/workspace/x.md") — what this app writes', () => {
    mkdirSync(path.join(dataDir, 'workspace'), { recursive: true });
    const target = path.join(dataDir, 'workspace', 'root-form.md');
    writeFileSync(target, 'hi');
    expect(resolvePromptFile('data/workspace/root-form.md')).toBe(target);
  });

  test('resolves data-dir-relative form ("workspace/x.md") — the intuitive hand-written form', () => {
    mkdirSync(path.join(dataDir, 'workspace'), { recursive: true });
    const target = path.join(dataDir, 'workspace', 'data-form.md');
    writeFileSync(target, 'hi');
    expect(resolvePromptFile('workspace/data-form.md')).toBe(target);
  });

  // The regression that shipped to prod: anchoring on dataPath() instead of dirname(DATA_DIR)
  // silently picked the WRONG file when a name existed under both anchors.
  test('app-root anchor WINS over the data-dir anchor when both exist', () => {
    mkdirSync(path.join(dataDir, 'data'), { recursive: true });
    const rootAnchored = path.join(appRoot, 'data', 'dup.md');   // dirname(DATA_DIR) + "data/dup.md"
    const dataAnchored = path.join(dataDir, 'data', 'dup.md');   // DATA_DIR + "data/dup.md"
    writeFileSync(rootAnchored, 'root');
    writeFileSync(dataAnchored, 'data');
    expect(rootAnchored).not.toBe(dataAnchored);
    expect(resolvePromptFile('data/dup.md')).toBe(rootAnchored);
  });

  test('unresolvable path returns the app-root anchor so the ENOENT names it', () => {
    expect(resolvePromptFile('nope/missing.md')).toBe(path.join(appRoot, 'nope', 'missing.md'));
  });

  // Regression guard for the original bug: resolution must NOT depend on process.cwd().
  test('is independent of process.cwd()', () => {
    mkdirSync(path.join(dataDir, 'workspace'), { recursive: true });
    const target = path.join(dataDir, 'workspace', 'cwd-proof.md');
    writeFileSync(target, 'hi');
    const orig = process.cwd();
    try {
      process.chdir(tmpdir());
      expect(resolvePromptFile('data/workspace/cwd-proof.md')).toBe(target);
    } finally {
      process.chdir(orig);
    }
  });
});
