import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { claudeAccountDir, applyClaudeAccount } from '../claude-account.ts';

let root: string;
const prevEnv = process.env.CLAUDE_ACCOUNTS_DIR;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'claude-accounts-'));
  mkdirSync(path.join(root, 'elya@example.com'));
});
afterEach(() => {
  if (prevEnv === undefined) delete process.env.CLAUDE_ACCOUNTS_DIR; else process.env.CLAUDE_ACCOUNTS_DIR = prevEnv;
});

describe('claudeAccountDir', () => {
  test('hit: existing folder, email matched case-insensitively (env root)', () => {
    process.env.CLAUDE_ACCOUNTS_DIR = root;
    expect(claudeAccountDir(' Elya@Example.COM ')).toBe(path.join(root, 'elya@example.com'));
  });
  test('no folder for that email → default', () => {
    expect(claudeAccountDir('other@example.com', root)).toBeNull();
  });
  test('a FILE named like the email is not an account', () => {
    writeFileSync(path.join(root, 'file@example.com'), 'x');
    expect(claudeAccountDir('file@example.com', root)).toBeNull();
  });
  test('unset env → default', () => {
    delete process.env.CLAUDE_ACCOUNTS_DIR;
    expect(claudeAccountDir('elya@example.com')).toBeNull();
  });
  test('no email → default', () => {
    expect(claudeAccountDir(undefined, root)).toBeNull();
    expect(claudeAccountDir('  ', root)).toBeNull();
  });
  test('traversal / separators rejected even when the target dir exists', () => {
    mkdirSync(path.join(root, 'inner'));
    const nested = path.join(root, 'inner');
    expect(claudeAccountDir('..', nested)).toBeNull();
    expect(claudeAccountDir('../elya@example.com', nested)).toBeNull();
    expect(claudeAccountDir('inner/../elya@example.com', root)).toBeNull();
    expect(claudeAccountDir('x\\..\\elya@example.com', root)).toBeNull();
  });
});

describe('applyClaudeAccount', () => {
  test('strips inherited credentials, sets CLAUDE_CONFIG_DIR, keeps the rest', () => {
    const env: Record<string, string> = {
      ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't', CLAUDE_CODE_OAUTH_TOKEN: 'o', CLAUDE_CONFIG_DIR: '/box', PATH: '/bin',
    };
    applyClaudeAccount(env, '/acct');
    expect(env).toEqual({ CLAUDE_CONFIG_DIR: '/acct', PATH: '/bin' });
  });
});
