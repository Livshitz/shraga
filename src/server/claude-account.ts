/**
 * Per-user Claude subscription routing: a run whose requester email resolves to a contact with a
 * `workspace/users/<contactId>/.claude` directory runs on that CLAUDE_CONFIG_DIR (log in once with
 * `CLAUDE_CONFIG_DIR=<dir> claude auth login`). Anything else → null → the default account, unchanged.
 * The folder is data-sync ignored (see DataSync.GITIGNORE_ENTRIES) and hidden from the workspace UI (dotdir).
 */
import { statSync } from 'node:fs';
import path from 'node:path';
import * as contacts from './contacts.ts';
import { WORKSPACE_DIR } from './workspace.ts';

export function claudeAccountDir(
  userEmail?: string,
  find: (email: string) => { id: string } | null = email => contacts.find({ email }),
  workspaceDir = WORKSPACE_DIR,
): string | null {
  const email = userEmail?.trim().toLowerCase();
  const contact = email ? find(email) : null;
  if (!contact?.id) return null;
  const dir = path.join(workspaceDir, 'users', contact.id, '.claude');
  try { return statSync(dir).isDirectory() ? dir : null; } catch { return null; }
}

/** Route a child env to `dir`: strip inherited credentials so neither the box's API key nor its token can win. */
export function applyClaudeAccount(env: Record<string, string>, dir: string): void {
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) delete env[k];
  env.CLAUDE_CONFIG_DIR = dir;
}
