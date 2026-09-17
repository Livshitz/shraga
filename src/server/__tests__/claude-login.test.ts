import { describe, test, expect, beforeEach } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ClaudeLogin, parseLoginUrl } from '../claude-login.ts';

// A fake `claude` CLI — never the real binary, never the network. `good` is the only valid code.
const FAKE_CLI = `#!/bin/sh
D="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
case "$1 $2" in
  "auth login")
    echo "Opening browser to sign in…"
    echo "If the browser didn't open, visit: <https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz>"
    printf "Paste code here if prompted > "
    read code
    if [ "$code" = "good" ]; then
      echo '{"claudeAiOauth":{"accessToken":"new"}}' > "$D/.credentials.json"
      echo '{"oauthAccount":{"emailAddress":"new@example.com"}}' > "$D/.claude.json"
      echo "Login successful"; exit 0
    fi
    rm -f "$D/.credentials.json" # a failed login in place would clobber the old one
    echo "OAuth error: Invalid code"; exit 1;;
  "auth status")
    if [ -f "$D/.credentials.json" ]; then echo '{"loggedIn":true,"email":"new@example.com","subscriptionType":"max"}'; exit 0; fi
    echo '{"loggedIn":false,"authMethod":"none"}'; exit 1;;
  "auth logout") rm -f "$D/.credentials.json"; exit 0;;
esac
exit 2
`;

let root: string;
let login: ClaudeLogin;
let globalChanges = 0;
let changed: string[] = [];
const owner = { email: 'owner@example.com', isOwner: true };
const member = { email: 'Member@Example.com', isOwner: false };
const book: Record<string, { id: string }> = { 'owner@example.com': { id: 'c-owner' }, 'member@example.com': { id: 'c-member' } };

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'claude-login-'));
  const cli = path.join(root, 'claude');
  writeFileSync(cli, FAKE_CLI);
  chmodSync(cli, 0o755);
  globalChanges = 0;
  changed = [];
  login =new ClaudeLogin({
    cliPath: cli,
    workspaceDir: path.join(root, 'ws'),
    findContact: email => book[email] ?? null,
    globalConfigDir: path.join(root, 'global'),
    home: path.join(root, 'home'),
    swap: true,
    urlTimeoutMs: 5_000,
    codeTimeoutMs: 5_000,
    onChange: t => { if (t.name === 'global') globalChanges++; else changed.push(t.dir); },
  });
});

describe('resolve (authorization)', () => {
  test('me → the caller contact dir (email case-insensitive)', () => {
    expect(login.resolve('me', member).dir).toBe(path.join(root, 'ws', 'users', 'c-member', '.claude'));
  });
  test('me without a contact → 409', () => {
    expect(() => login.resolve('me', { email: 'stranger@example.com' })).toThrow(expect.objectContaining({ status: 409 }));
  });
  test('global: non-owner → 403, owner → CLAUDE_CONFIG_DIR', () => {
    expect(() => login.resolve('global', member)).toThrow(expect.objectContaining({ status: 403 }));
    expect(login.resolve('global', owner)).toMatchObject({ dir: path.join(root, 'global'), explicitDir: true });
  });
  test('global without CLAUDE_CONFIG_DIR → ~/.claude + ~/.claude.json', () => {
    login.options.globalConfigDir = undefined;
    expect(login.resolve('global', owner)).toMatchObject({ dir: path.join(root, 'home', '.claude'), accountFile: path.join(root, 'home', '.claude.json'), explicitDir: false });
  });
  test('unknown target → 404', () => {
    expect(() => login.resolve('other', owner)).toThrow(expect.objectContaining({ status: 404 }));
  });
});

describe('parseLoginUrl', () => {
  test('extracts the authorize URL without the angle brackets', () => {
    expect(parseLoginUrl("If the browser didn't open, visit: <https://claude.com/cai/oauth/authorize?code=true&a=1>\nPaste code here if prompted >"))
      .toBe('https://claude.com/cai/oauth/authorize?code=true&a=1');
  });
  test('no URL → null', () => {
    expect(parseLoginUrl('Opening browser…')).toBeNull();
  });
});

describe('login flow (fake CLI)', () => {
  test('me: connect creates the dir and reports the account', async () => {
    const t = login.resolve('me', member);
    expect((await login.status(t)).connected).toBe(false);
    expect(await login.start(t)).toContain('oauth/authorize');
    expect(await login.submitCode(t, 'good')).toEqual({ connected: true, account: 'new@example.com', subscriptionType: 'max' });
    expect(JSON.parse(readFileSync(path.join(t.dir, '.claude.json'), 'utf8')).oauthAccount.emailAddress).toBe('new@example.com');
  });

  test('a failed Replace leaves the working login untouched', async () => {
    const t = login.resolve('global', owner);
    mkdirSync(t.dir, { recursive: true });
    writeFileSync(path.join(t.dir, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"old"}}');
    writeFileSync(t.accountFile, '{"keep":1,"oauthAccount":{"emailAddress":"old@example.com"}}');
    await login.start(t);
    await expect(login.submitCode(t, 'bad')).rejects.toMatchObject({ status: 400, message: expect.stringContaining('Invalid code') });
    expect(readFileSync(path.join(t.dir, '.credentials.json'), 'utf8')).toContain('old');
    expect(readFileSync(t.accountFile, 'utf8')).toContain('old@example.com');
    expect(globalChanges).toBe(0);
  });

  test('a successful Replace swaps credentials, merges identity, invalidates usage', async () => {
    const t = login.resolve('global', owner);
    mkdirSync(t.dir, { recursive: true });
    writeFileSync(path.join(t.dir, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"old"}}');
    writeFileSync(t.accountFile, '{"keep":1,"oauthAccount":{"emailAddress":"old@example.com"}}');
    await login.start(t);
    await login.submitCode(t, 'good');
    expect(readFileSync(path.join(t.dir, '.credentials.json'), 'utf8')).toContain('new');
    expect(JSON.parse(readFileSync(t.accountFile, 'utf8'))).toEqual({ keep: 1, oauthAccount: { emailAddress: 'new@example.com' } });
    expect(globalChanges).toBe(1);
  });

  test('darwin in-place implicit global login runs WITHOUT CLAUDE_CONFIG_DIR (Keychain item is keyed by it)', async () => {
    const cli = path.join(root, 'claude-env');
    const seen = path.join(root, 'seen-dir');
    writeFileSync(cli, `#!/bin/sh\nprintf '%s' "\${CLAUDE_CONFIG_DIR-unset}" > "${seen}"\necho "visit: https://claude.com/cai/oauth/authorize?x=1"\nread code\nexit 0\n`);
    chmodSync(cli, 0o755);
    const l = new ClaudeLogin({ cliPath: cli, globalConfigDir: undefined, home: path.join(root, 'home'), swap: false, urlTimeoutMs: 5_000, codeTimeoutMs: 5_000 });
    const t = l.resolve('global', owner);
    await l.start(t);
    l.cancel(t.key);
    expect(readFileSync(seen, 'utf8')).toBe('unset');
  });

  test('code without a pending login → 404', async () => {
    await expect(login.submitCode(login.resolve('me', member), 'good')).rejects.toMatchObject({ status: 404 });
  });

  test('me: disconnect removes the dir so runs fall back to the shared login', async () => {
    const t = login.resolve('me', member);
    await login.start(t);
    await login.submitCode(t, 'good');
    await login.disconnect(t);
    expect(existsSync(t.dir)).toBe(false);
    expect((await login.status(t)).connected).toBe(false);
    expect(changed).toEqual([t.dir, t.dir]); // connect + disconnect each invalidate THAT account's usage
    expect(globalChanges).toBe(0);
  });
});
