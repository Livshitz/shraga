// Pins the back-compat contract for the pre-de-brand module name.
//
// A deployment's data config is operator-written and value-imports the app tree by relative path:
//   data/unclaw.config.ts:  import { defineConfig } from '../src/server/unclaw-config.ts'
// So `src/server/unclaw-config.ts` is public surface. Renaming it to shraga-config.ts without a
// shim broke that import — and `loadShragaConfig` catches the failure and yields an empty config,
// so the breakage surfaces as "all MCPs vanished", not as a crash.
//
// This mimics the real default layout (DATA_DIR = <root>/data, a sibling of src/) rather than
// importing the shim directly, so it exercises the specifier a legacy config actually writes.
import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { defineConfig as canonicalDefineConfig, CONFIG_FILENAMES } from '../shraga-config.ts';

const REPO_SRC = path.resolve(import.meta.dirname, '..', '..');

/** Build an isolated app root whose `data/` sits beside a `src/` that is this repo's real one. */
function legacyDeployment(configSource: string): string {
  const root = mkdtempSync(path.join(tmpdir(), 'shraga-compat-'));
  mkdirSync(path.join(root, 'data'), { recursive: true });
  symlinkSync(REPO_SRC, path.join(root, 'src'));
  const file = path.join(root, 'data', 'unclaw.config.ts');
  writeFileSync(file, configSource);
  roots.push(root);
  return file;
}

const roots: string[] = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

const CONFIG = { mcps: { stripe: { command: 'bunx', args: ['@stripe/mcp'], env: { STRIPE_KEY: '' } } } };

describe('legacy data/unclaw.config.ts compat', () => {
  test('resolves the legacy module path and yields the same config as the canonical path', async () => {
    const legacy = legacyDeployment(
      `import { defineConfig } from '../src/server/unclaw-config.ts';\n` +
        `export default defineConfig(${JSON.stringify(CONFIG)});\n`,
    );
    const canonical = legacyDeployment(
      `import { defineConfig } from '../src/server/shraga-config.ts';\n` +
        `export default defineConfig(${JSON.stringify(CONFIG)});\n`,
    );

    // Fails with "Cannot find module" if the shim is deleted — the exact prod breakage.
    const viaLegacy = (await import(legacy)).default;
    const viaCanonical = (await import(canonical)).default;

    expect(viaLegacy).toEqual(CONFIG);
    expect(viaLegacy).toEqual(viaCanonical);
  });

  test('the shim forwards to shraga-config rather than redefining it', async () => {
    const shim = await import('../unclaw-config.ts');
    // Identity, not a lookalike: a copied module would be a different function object.
    expect(shim.defineConfig).toBe(canonicalDefineConfig);
  });

  test('the loader still accepts the legacy config filename', () => {
    // The filename half of the same contract; the shim is the module half.
    expect(CONFIG_FILENAMES).toContain('unclaw.config.ts');
  });
});
