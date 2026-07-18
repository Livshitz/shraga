// Resolve and load the correct .env file at startup.
// Must be imported FIRST — before env-sanitize or any config reader.
//
// Resolution order:
// 1. ENV_NAME env var → .env.{name}
// 2. --env-file already loaded (has ANTHROPIC_API_KEY) → no-op
// 3. Scan for .env.* files:
//    - exactly one non-example → auto-select
//    - multiple → error with list
//    - none → fall back to bare .env (prod)
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '../..');
const TAG = '[env]';
const SKIP = /\.(example|bak|copy|deploy-restore)/;

function alreadyLoaded(): boolean {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.DATA_SYNC_REPO);
}

function findNamedEnvs(): string[] {
  return readdirSync(ROOT)
    .filter(f => f.startsWith('.env.') && !SKIP.test(f))
    .map(f => f.slice(5));
}

function loadFile(filePath: string): void {
  const content = readFileSync(filePath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq);
    const val = trimmed.slice(eq + 1).replace(/^["']|["']$/g, '').replace(/\s+#.*$/, '');
    if (!(key in process.env)) process.env[key] = val;
  }
}

if (!alreadyLoaded()) {
  const envName = process.env.ENV_NAME;

  if (envName) {
    const p = path.join(ROOT, `.env.${envName}`);
    if (!existsSync(p)) {
      console.error(`${TAG} ❌ .env.${envName} not found`);
      process.exit(1);
    }
    loadFile(p);
    console.log(`${TAG} Loaded .env.${envName}`);
  } else {
    const named = findNamedEnvs();
    const bare = path.join(ROOT, '.env');

    if (named.length === 1) {
      const p = path.join(ROOT, `.env.${named[0]}`);
      loadFile(p);
      process.env.ENV_NAME = named[0];
      console.log(`${TAG} Auto-selected .env.${named[0]} (only named env)`);
    } else if (named.length > 1 && !existsSync(bare)) {
      console.error(`${TAG} ❌ Multiple named envs found, set ENV_NAME to pick one:`);
      for (const n of named) console.error(`${TAG}   .env.${n}`);
      process.exit(1);
    } else if (existsSync(bare)) {
      loadFile(bare);
    } else {
      console.warn(`${TAG} No .env file found — relying on system environment`);
    }
  }
}
