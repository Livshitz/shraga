// The engine must feed each run's SDK rate_limit_event into THAT run's account reader: a routed user's
// exhausted window must never paint the box gauge, and vice versa. Drives the REAL ClaudeCodeEngine
// with only the SDK query and the account lookup stubbed (snapshot + delegate: mock.module is global).
import { afterAll, beforeAll, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROUTED_EMAIL = 'routed@example.com';
const root = mkdtempSync(path.join(tmpdir(), 'usage-engine-'));
const routedDir = path.join(root, 'users', 'c-routed', '.claude');

const realSdk = { ...(await import('@anthropic-ai/claude-agent-sdk')) };
const realAccount = { ...(await import('../claude-account.ts')) };
let active = false;
const info = { status: 'rejected', rateLimitType: 'five_hour', resetsAt: Math.floor(Date.now() / 1000) + 3600 };

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  ...realSdk,
  query: (args: any) => {
    if (!active) return (realSdk.query as any)(args);
    return (async function* () {
      yield { type: 'rate_limit_event', rate_limit_info: info };
      yield { type: 'result', subtype: 'success', session_id: 'sdk-s', num_turns: 1, result: 'ok', usage: {} };
    })();
  },
}));
mock.module('../claude-account.ts', () => ({
  ...realAccount,
  claudeAccountDir: (email?: string, ...rest: any[]) =>
    active ? (email === ROUTED_EMAIL ? routedDir : null) : (realAccount.claudeAccountDir as any)(email, ...rest),
}));

const { ClaudeCodeEngine } = await import('../engine/claude-code.ts');
const { claudeUsage, claudeUsageFor } = await import('../claude-usage.ts');

beforeAll(() => { active = true; });
afterAll(() => { active = false; rmSync(root, { recursive: true, force: true }); });

async function run(userEmail: string) {
  const engine = new ClaudeCodeEngine();
  for await (const _ of engine.stream({
    prompt: 'hi', conversation: [], contextBlock: '', sessionId: `usage-routing-${Math.random()}`, uid: 'u1', userEmail,
    directives: {}, config: {} as any,
  })) { /* drain */ }
}

describe('engine → usage reader routing', () => {
  it('a routed run feeds its own account reader, not the box default', async () => {
    const box = spyOn(claudeUsage, 'observeRateLimit');
    const routed = spyOn(claudeUsageFor(routedDir), 'observeRateLimit');
    await run(ROUTED_EMAIL);
    expect(routed).toHaveBeenCalledWith(info);
    expect(box).not.toHaveBeenCalled();
    box.mockRestore(); routed.mockRestore();
  });

  it('a default run feeds the box default reader only', async () => {
    const box = spyOn(claudeUsage, 'observeRateLimit');
    const routed = spyOn(claudeUsageFor(routedDir), 'observeRateLimit');
    await run('someone@example.com');
    expect(box).toHaveBeenCalledWith(info);
    expect(routed).not.toHaveBeenCalled();
    box.mockRestore(); routed.mockRestore();
  });
});
