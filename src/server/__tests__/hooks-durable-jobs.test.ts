import { test, expect, describe } from 'bun:test';
import { buildHooks } from '../hooks.ts';

/** First deny reason any PreToolUse hook returns for this Bash call, else null. */
async function denyReason(hooks: ReturnType<typeof buildHooks>, tool_input: Record<string, unknown>): Promise<string | null> {
  for (const m of hooks.PreToolUse!) for (const h of m.hooks) {
    const r: any = await h({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input } as any, undefined, { signal: new AbortController().signal });
    if (r?.hookSpecificOutput?.permissionDecision === 'deny') return r.hookSpecificOutput.permissionDecisionReason;
  }
  return null;
}

describe('durable jobs steering (native run_in_background dies at the bg-wait budget)', () => {
  test('with durable jobs: native run_in_background is refused and steered to job_start', async () => {
    const h = buildHooks({ offload: undefined, durableJobs: true });
    expect(await denyReason(h, { command: 'sh publish.sh', run_in_background: true })).toContain('mcp__jobs__job_start');
    expect(await denyReason(h, { command: 'ls' })).toBeNull();
  });

  test('without durable jobs: native run_in_background is still allowed (nothing better exists)', async () => {
    const h = buildHooks({ offload: undefined, durableJobs: false });
    expect(await denyReason(h, { command: 'sh publish.sh', run_in_background: true })).toBeNull();
  });
});
