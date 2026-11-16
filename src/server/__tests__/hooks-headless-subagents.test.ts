import { test, expect, describe } from 'bun:test';
import { buildHooks } from '../hooks.ts';

/** The rewritten input any matching PreToolUse hook returns for this call, else null. */
async function updated(hooks: ReturnType<typeof buildHooks>, tool_name: string, tool_input: Record<string, unknown>) {
  for (const m of hooks.PreToolUse!) {
    if (m.matcher && !new RegExp(`^(?:${m.matcher})$`).test(tool_name)) continue;
    for (const h of m.hooks) {
      const r: any = await h({ hook_event_name: 'PreToolUse', tool_name, tool_input } as any, undefined, { signal: new AbortController().signal });
      if (r?.hookSpecificOutput?.updatedInput) return r.hookSpecificOutput.updatedInput;
    }
  }
  return null;
}

describe('headless runs keep subagents in the foreground', () => {
  test('headless: Agent/Task default or background spawns are forced to foreground', async () => {
    const h = buildHooks({ offload: undefined, headless: true });
    expect((await updated(h, 'Agent', { prompt: 'x' }))?.run_in_background).toBe(false);
    expect((await updated(h, 'Agent', { prompt: 'x', run_in_background: true }))?.run_in_background).toBe(false);
    expect((await updated(h, 'Task', { prompt: 'x' }))?.run_in_background).toBe(false);
    expect(await updated(h, 'Agent', { prompt: 'x', run_in_background: false })).toBeNull();
  });

  test('interactive: subagents are left alone', async () => {
    const h = buildHooks({ offload: undefined, headless: false });
    expect(await updated(h, 'Agent', { prompt: 'x', run_in_background: true })).toBeNull();
  });
});
