import { describe, expect, mock, test } from 'bun:test';

let captured: any;
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: any) => { captured = args; return (async function* () {})(); },
}));
const { runTextQuery } = await import('../sdk-utils.ts');

describe('runTextQuery', () => {
  test('threads the AbortController into the SDK so a cancelled call kills the subprocess', async () => {
    const ac = new AbortController();
    await runTextQuery({ prompt: 'hi', abortController: ac });
    expect(captured.options.abortController).toBe(ac);
  });

  test('CLAUDE_CODE_AUTH=subscription strips the API key from the env passed to query(); otherwise kept', async () => {
    const saved = { auth: process.env.CLAUDE_CODE_AUTH, key: process.env.ANTHROPIC_API_KEY };
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    try {
      process.env.CLAUDE_CODE_AUTH = 'subscription';
      await runTextQuery({ prompt: 'hi' });
      expect(captured.options.env).toBeDefined();
      expect('ANTHROPIC_API_KEY' in captured.options.env).toBe(false);
      expect(process.env.ANTHROPIC_API_KEY).toBe('sk-test'); // only the child env, not the server's
      delete process.env.CLAUDE_CODE_AUTH;
      await runTextQuery({ prompt: 'hi' });
      expect(captured.options.env.ANTHROPIC_API_KEY).toBe('sk-test');
    } finally {
      for (const [k, v] of [['CLAUDE_CODE_AUTH', saved.auth], ['ANTHROPIC_API_KEY', saved.key]] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });
});
