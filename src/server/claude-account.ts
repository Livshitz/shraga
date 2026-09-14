/**
 * Per-user Claude subscription routing by folder convention: a run whose requester email has a directory
 * `<CLAUDE_ACCOUNTS_DIR>/<email lowercased>` runs on that CLAUDE_CONFIG_DIR (log in once with
 * `CLAUDE_CONFIG_DIR=<dir> claude auth login`). Anything else → null → the default account, unchanged.
 */
import { statSync } from 'node:fs';
import path from 'node:path';

export function claudeAccountDir(userEmail?: string, root = process.env.CLAUDE_ACCOUNTS_DIR?.trim()): string | null {
  const email = userEmail?.trim().toLowerCase();
  if (!root || !email || email.includes('/') || email.includes('\\') || email.includes('..')) return null;
  const dir = path.join(root, email);
  try { return statSync(dir).isDirectory() ? dir : null; } catch { return null; }
}

/** Route a child env to `dir`: strip inherited credentials so neither the box's API key nor its token can win. */
export function applyClaudeAccount(env: Record<string, string>, dir: string): void {
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) delete env[k];
  env.CLAUDE_CONFIG_DIR = dir;
}
