/**
 * Per-user Claude subscription routing: a run whose requester email resolves to a contact with a
 * `workspace/users/<contactId>/.claude` directory runs on that CLAUDE_CONFIG_DIR (log in once with
 * `CLAUDE_CONFIG_DIR=<dir> claude auth login`). Anything else → null → the default account, unchanged.
 * The folder is data-sync ignored (see DataSync.GITIGNORE_ENTRIES) and hidden from the workspace UI (dotdir).
 */
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import * as contacts from './contacts.ts';
import { WORKSPACE_DIR } from './workspace.ts';
import { claudeUsageFor, type ClaudeLoginIdentity } from './claude-usage.ts';

export function claudeAccountDir(
  userEmail?: string,
  find: (email: string) => { id: string } | null = email => contacts.find({ email }),
  workspaceDir = WORKSPACE_DIR,
): string | null {
  const email = userEmail?.trim().toLowerCase();
  const contact = email ? find(email) : null;
  if (!contact?.id) return null;
  const dir = path.join(workspaceDir, 'users', contact.id, '.claude');
  try { return statSync(dir).isDirectory() && !usesShared(dir) ? dir : null; } catch { return null; }
}

/** Marker inside a personal login dir: keep the credentials but route runs to the shared login (hot-switch). */
export const USE_SHARED_MARKER = '.shraga-use-shared';
export function usesShared(dir: string): boolean {
  return existsSync(path.join(dir, USE_SHARED_MARKER));
}

/** The login a run on `dir` (null = the box default) is signed in as, for provenance. Never a token. */
export interface ClaudeAccountRef extends ClaudeLoginIdentity { personal: boolean }

export async function claudeAccountRef(dir: string | null): Promise<ClaudeAccountRef | undefined> {
  const id = await claudeUsageFor(dir).identity();
  return id ? { ...id, personal: !!dir } : undefined;
}

/** CLAUDE_CODE_AUTH=subscription: claude-code runs use the box's stored claude login even when ANTHROPIC_API_KEY
 *  is set for other engines (agentx anthropic/*, tools) — without it the key silently wins and bills the API. */
export function claudeForcesSubscription(): boolean {
  return process.env.CLAUDE_CODE_AUTH === 'subscription';
}

/** Route a child env to `dir`: strip inherited credentials so neither the box's API key nor its token can win. */
export function applyClaudeAccount(env: Record<string, string>, dir: string): void {
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) delete env[k];
  env.CLAUDE_CONFIG_DIR = dir;
}
