import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { WORKSPACE_DIR } from './workspace.ts';
import { injectFile } from './file-inject.ts';
import type { Contact } from './contacts.ts';

const STUB = (name: string) =>
  `# ${name}\n\n## Summary\n\n_No learnings yet._\n\n## Corrections\n\n## How They Operate\n\n## Their Taste\n\n## Current Focus\n`;

const SYSTEM_EMAIL_RE = /^(postmaster|mailer-daemon|noreply|no-reply|notifications?|drive-shares-dm-noreply)@/i;

function isHumanContact(contact: Contact): boolean {
  if (!contact.emails.length && !contact.slackIds.length) return false;
  if (contact.emails.length && contact.emails.every(e => SYSTEM_EMAIL_RE.test(e))) return false;
  return true;
}

export function ensureUserDir(contact: Contact): string | null {
  if (!isHumanContact(contact)) return null;
  const dir = path.join(WORKSPACE_DIR, 'users', contact.id);
  mkdirSync(dir, { recursive: true });
  const contextFile = path.join(dir, 'user-context.md');
  if (!existsSync(contextFile)) writeFileSync(contextFile, STUB(contact.name), 'utf-8');
  return dir;
}

export function getUserContextBlock(contact: Contact | null): string {
  if (!contact) return '';
  const dir = ensureUserDir(contact);
  if (!dir) return '';
  const filePath = path.join(dir, 'user-context.md');
  return injectFile(filePath, { label: 'user-context', maxChars: 3000 });
}
