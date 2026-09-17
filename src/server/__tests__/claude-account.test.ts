import { describe, test, expect, beforeEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { claudeAccountDir, applyClaudeAccount, USE_SHARED_MARKER } from '../claude-account.ts';

let ws: string;
const book: Record<string, { id: string }> = { 'elya@example.com': { id: 'c-elya' }, 'nolog@example.com': { id: 'c-nolog' } };
const find = (email: string) => book[email] ?? null;

beforeEach(() => {
  ws = mkdtempSync(path.join(tmpdir(), 'claude-accounts-'));
  mkdirSync(path.join(ws, 'users', 'c-elya', '.claude'), { recursive: true });
  mkdirSync(path.join(ws, 'users', 'c-nolog'), { recursive: true });
});

describe('claudeAccountDir', () => {
  test('hit: contact by email (case-insensitive) with a .claude dir', () => {
    expect(claudeAccountDir(' Elya@Example.COM ', find, ws)).toBe(path.join(ws, 'users', 'c-elya', '.claude'));
  });
  test('use-shared marker → default, credentials kept', () => {
    writeFileSync(path.join(ws, 'users', 'c-elya', '.claude', USE_SHARED_MARKER), '');
    expect(claudeAccountDir('elya@example.com', find, ws)).toBeNull();
  });
  test('contact without a .claude dir → default', () => {
    expect(claudeAccountDir('nolog@example.com', find, ws)).toBeNull();
  });
  test('a FILE named .claude is not an account', () => {
    writeFileSync(path.join(ws, 'users', 'c-nolog', '.claude'), 'x');
    expect(claudeAccountDir('nolog@example.com', find, ws)).toBeNull();
  });
  test('unknown email / no email → default', () => {
    expect(claudeAccountDir('other@example.com', find, ws)).toBeNull();
    expect(claudeAccountDir(undefined, find, ws)).toBeNull();
    expect(claudeAccountDir('  ', find, ws)).toBeNull();
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
