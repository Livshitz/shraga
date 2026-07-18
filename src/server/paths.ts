import path from 'node:path';
import { readdirSync } from 'node:fs';

function resolveDataDir(): string {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
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

// The Shraga app root (where `defaults/` lives and the agent's project filesystem is rooted).
// Derived from THIS module's stable location — `src/server/paths.ts` → repo root is two dirs up — so
// it's correct even for code loaded from an overlay checkout in a different directory (where
// `import.meta.dirname`-relative math would resolve to the overlay, not the app).
export const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..');
