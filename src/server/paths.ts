import path from 'node:path';
import { readdirSync } from 'node:fs';

function resolveDataDir(): string {
  // Absolutize against cwd: run.sh sets a RELATIVE `DATA_DIR=data-<env>`, and a relative path breaks
  // any consumer that isn't cwd-relative — notably the dynamic `import(configPath)` in
  // shraga-config.ts, which resolves a relative specifier against the IMPORTING MODULE
  // (`node_modules/shraga/src/server/`), not the process cwd.
  if (process.env.DATA_DIR) return path.resolve(process.env.DATA_DIR);
  const root = process.cwd();
  const hasNamed = readdirSync(root).some(f => f.startsWith('data-'));
  if (hasNamed) {
    throw new Error(
      `DATA_DIR not set but named data dirs exist (data-*). ` +
      `Run via 'bun run dev <env>' or set DATA_DIR explicitly.`
    );
  }
  return path.resolve(root, 'data');
}

export const DATA_DIR = resolveDataDir();
export const dataPath = (...segments: string[]) => path.join(DATA_DIR, ...segments);

// ── Two distinct roots. Conflating them is what broke npm-consumer deployments. ──────────────────
//
// PACKAGE_ROOT — where the SHRAGA PACKAGE's own shipped assets live (`defaults/`, `dist/client/`,
// `package.json` — everything in package.json `files`). Package-relative is CORRECT here: in an npm
// consumer these really do live under `node_modules/shraga/`. Do not "fix" this to APP_ROOT.
export const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');

/**
 * APP_ROOT — the DEPLOYMENT/consumer root: where `vendor/`, `secrets/` and `data/` live, and where
 * the agent's project filesystem is rooted. NOT shipped in the package.
 *
 * In a source checkout this equals PACKAGE_ROOT. In an npm consumer (`shraga-circles`, `shraga-ee`)
 * it is the CONSUMER root, while PACKAGE_ROOT is `<consumer>/node_modules/shraga` — resolving vendor
 * from PACKAGE_ROOT is what silently killed ~21/25 MCPs in prod.
 *
 * Signal, in precedence order:
 *  1. SHRAGA_APP_ROOT env — explicit escape hatch for any layout the heuristics get wrong.
 *  2. node_modules ancestor — if this file sits under `.../node_modules/shraga/...`, the app root is
 *     the directory CONTAINING that `node_modules`. Independent of cwd, so it survives a server
 *     started from anywhere (systemd, a cron shell, `bun --cwd`).
 *  3. process.cwd() — the source-checkout case, and already this module's established app-root signal
 *     (see resolveDataDir above; run.sh `cd`s to the app root before launching).
 *
 * Failure modes, explicit:
 *  - Hoisted/pnpm layouts where `shraga` resolves to a store dir outside the consumer's own
 *    node_modules: rule 2 picks the hoisting root, which may not be the dir holding `vendor/`.
 *  - A nested `node_modules/x/node_modules/shraga`: rule 2 stops at the INNERMOST node_modules.
 *  Both are exactly why rule 1 exists — set SHRAGA_APP_ROOT and the heuristics are bypassed.
 */
function resolveAppRoot(): string {
  const explicit = process.env.SHRAGA_APP_ROOT?.trim();
  if (explicit) return path.resolve(explicit);

  const marker = `${path.sep}node_modules${path.sep}`;
  const idx = PACKAGE_ROOT.lastIndexOf(marker);
  if (idx !== -1) return PACKAGE_ROOT.slice(0, idx);

  return process.cwd();
}

export const APP_ROOT = resolveAppRoot();

/**
 * @deprecated Ambiguous name — use APP_ROOT (vendor/secrets/data, agent cwd) or PACKAGE_ROOT
 * (shipped assets) explicitly.
 *
 * Aliased to APP_ROOT, not PACKAGE_ROOT, deliberately: every remaining external consumer of this
 * export (shraga-ee `engine/cursor.ts`, `engine/agentx.ts`) uses it as the agent's project root —
 * i.e. they meant APP_ROOT and were hitting the same npm-layout bug. Pointing the alias here fixes
 * them without an EE change. Nothing in this package reads shipped assets through it.
 */
export const PROJECT_ROOT = APP_ROOT;
