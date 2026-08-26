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
});
