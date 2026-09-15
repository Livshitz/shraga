// The engine must feed each run's SDK rate_limit_event into THAT run's account reader: a routed user's
// exhausted window must never paint the box gauge, and vice versa. It must also record WHICH login a
// turn ran on (session meta `lastAccount`) and name it on a usage-limit error. Drives the REAL
// ClaudeCodeEngine with only the SDK query and the account lookup stubbed (snapshot + delegate:
// mock.module is global). Login dirs are fake files; the box default reader is repointed at a fake dir.
import { afterAll, beforeAll, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROUTED_EMAIL = 'routed@example.com';
const TOKEN = 'sk-ant-oat01-NEVER-PERSIST-THIS';
const root = mkdtempSync(path.join(tmpdir(), 'usage-engine-'));
const routedDir = path.join(root, 'users', 'c-routed', '.claude');
const boxDir = path.join(root, 'box');

function fakeLogin(dir: string, accountPath: string, email: string, plan: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(accountPath, JSON.stringify({ oauthAccount: { emailAddress: email, displayName: 'X' } }));
  writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, refreshToken: TOKEN, scopes: ['user:profile'], subscriptionType: plan } }));
}
fakeLogin(routedDir, path.join(routedDir, '.claude.json'), 'lior.h@7chairs.org', 'pro');
fakeLogin(boxDir, path.join(boxDir, '.claude.json'), 'agent@box.example', 'max');

const realSdk = { ...(await import('@anthropic-ai/claude-agent-sdk')) };
const realAccount = { ...(await import('../claude-account.ts')) };
let active = false;
const info = { status: 'rejected', rateLimitType: 'five_hour', resetsAt: Math.floor(Date.now() / 1000) + 3600 };
const OK_RESULT = { type: 'result', subtype: 'success', session_id: 'sdk-s', num_turns: 1, result: 'ok', usage: {} };
let script: any[] = [{ type: 'rate_limit_event', rate_limit_info: info }, OK_RESULT];

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  ...realSdk,
  query: (args: any) => {
    if (!active) return (realSdk.query as any)(args);
    const msgs = script;
    return (async function* () { for (const m of msgs) yield m; })();
  },
}));
mock.module('../claude-account.ts', () => ({
  ...realAccount,
  claudeAccountDir: (email?: string, ...rest: any[]) =>
    active ? (email === ROUTED_EMAIL ? routedDir : null) : (realAccount.claudeAccountDir as any)(email, ...rest),
}));

const { ClaudeCodeEngine } = await import('../engine/claude-code.ts');
const { claudeUsage, claudeUsageFor } = await import('../claude-usage.ts');
const { upsertSession, getSession, flushIndex } = await import('../sessions.ts');
const { dataPath } = await import('../paths.ts');

const savedBoxOptions = { ...claudeUsage.options };
beforeAll(() => {
  active = true;
  // Never read the real ~/.claude.json or the keychain: point the box default reader at the fake dir.
  Object.assign(claudeUsage.options, {
    accountPath: path.join(boxDir, '.claude.json'),
    credentialsPath: path.join(boxDir, '.credentials.json'),
    platform: 'linux',
    readKeychain: async () => null,
  });
});
afterAll(() => { active = false; Object.assign(claudeUsage.options, savedBoxOptions); rmSync(root, { recursive: true, force: true }); });

async function run(userEmail: string, sessionId = `usage-routing-${Math.random()}`) {
  const engine = new ClaudeCodeEngine();
  const events: any[] = [];
  for await (const ev of engine.stream({
    prompt: 'hi', conversation: [], contextBlock: '', sessionId, uid: 'u1', userEmail,
    directives: {}, config: {} as any,
  })) events.push(ev);
  return events;
}

function newSession(email: string) {
  const sid = `acct-${Math.random().toString(36).slice(2)}`;
  upsertSession(sid, 'hi', { uid: 'u1', email });
  return sid;
}

const init = (apiKeySource: string) => ({ type: 'system', subtype: 'init', session_id: 'sdk-s', model: 'claude-sonnet-5', apiKeySource, mcp_servers: [] });

describe('engine → usage reader routing', () => {
  it('a routed run feeds its own account reader, not the box default', async () => {
    script = [{ type: 'rate_limit_event', rate_limit_info: info }, OK_RESULT];
    const box = spyOn(claudeUsage, 'observeRateLimit');
    const routed = spyOn(claudeUsageFor(routedDir), 'observeRateLimit');
    await run(ROUTED_EMAIL);
    expect(routed).toHaveBeenCalledWith(info);
    expect(box).not.toHaveBeenCalled();
    box.mockRestore(); routed.mockRestore();
  });

  it('a default run feeds the box default reader only', async () => {
    script = [{ type: 'rate_limit_event', rate_limit_info: info }, OK_RESULT];
    const box = spyOn(claudeUsage, 'observeRateLimit');
    const routed = spyOn(claudeUsageFor(routedDir), 'observeRateLimit');
    await run('someone@example.com');
    expect(box).toHaveBeenCalledWith(info);
    expect(routed).not.toHaveBeenCalled();
    box.mockRestore(); routed.mockRestore();
  });
});

describe('engine records the account a turn ran on', () => {
  it('routed run → personal login, persisted in session meta and sent with model_resolved', async () => {
    script = [init('none'), OK_RESULT];
    const sid = newSession(ROUTED_EMAIL);
    const events = await run(ROUTED_EMAIL, sid);
    const expected = { email: 'lior.h@7chairs.org', plan: 'pro', personal: true };
    expect(getSession(sid)?.lastAccount).toEqual(expected);
    expect(getSession(sid)?.lastEngine).toBe('claude-code');
    expect(events.find(e => e.type === 'model_resolved')?.account).toEqual(expected);
  });

  it('default run on the box login → shared login', async () => {
    script = [init('none'), OK_RESULT];
    const sid = newSession('someone@example.com');
    await run('someone@example.com', sid);
    expect(getSession(sid)?.lastAccount).toEqual({ email: 'agent@box.example', plan: 'max', personal: false });
  });

  it('default run on an API key → no account, and a previous turn\'s account is cleared', async () => {
    const sid = newSession('someone@example.com');
    script = [init('none'), OK_RESULT];
    await run('someone@example.com', sid);
    expect(getSession(sid)?.lastAccount).toBeDefined();
    script = [init('ANTHROPIC_API_KEY'), OK_RESULT];
    const events = await run('someone@example.com', sid);
    expect(getSession(sid)?.lastAccount).toBeUndefined();
    expect(events.find(e => e.type === 'model_resolved')).not.toHaveProperty('account');
  });

  it('never persists or emits a token', async () => {
    script = [init('none'), OK_RESULT];
    const sid = newSession(ROUTED_EMAIL);
    const events = await run(ROUTED_EMAIL, sid);
    flushIndex();
    expect(readFileSync(dataPath('sessions.json'), 'utf8')).toContain('lior.h@7chairs.org'); // the check can fail
    expect(readFileSync(dataPath('sessions.json'), 'utf8')).not.toContain(TOKEN);
    expect(JSON.stringify(events)).not.toContain(TOKEN);
  });
});

describe('usage-limit error names the account', () => {
  const LIMIT = "You're out of extra usage · resets 2pm (UTC)";
  const limitResult = { type: 'result', subtype: 'success', is_error: true, session_id: 'sdk-s', num_turns: 1, result: LIMIT, usage: {} };

  it('routed run: prefix with the login email, rest verbatim', async () => {
    script = [init('none'), limitResult];
    const events = await run(ROUTED_EMAIL, newSession(ROUTED_EMAIL));
    expect(events.find(e => e.type === 'error')?.message).toBe(`Claude API error (lior.h@7chairs.org): ${LIMIT}`);
  });

  it('routed run with no init message still names the routed login', async () => {
    script = [limitResult];
    const events = await run(ROUTED_EMAIL);
    expect(events.find(e => e.type === 'error')?.message).toBe(`Claude API error (lior.h@7chairs.org): ${LIMIT}`);
  });

  it('API-key run: no account prefix (the login is not what ran)', async () => {
    script = [init('ANTHROPIC_API_KEY'), limitResult];
    const events = await run('someone@example.com');
    expect(events.find(e => e.type === 'error')?.message).toBe(`Claude API error: ${LIMIT}`);
  });

  it('a non-limit API error is left unprefixed', async () => {
    script = [init('none'), { ...limitResult, result: 'Internal server error', api_error_status: 500 }];
    const events = await run(ROUTED_EMAIL);
    expect(events.find(e => e.type === 'error')?.message).toBe('Claude API error: Internal server error');
  });

  it('a context/size "limit" error is not a quota error — left unprefixed', async () => {
    const msg = 'input length and max_tokens exceed context limit: 190000 + 32000 > 200000';
    script = [init('none'), { ...limitResult, result: msg, api_error_status: 400 }];
    const events = await run(ROUTED_EMAIL);
    expect(events.find(e => e.type === 'error')?.message).toBe(`Claude API error: ${msg}`);
  });
});
