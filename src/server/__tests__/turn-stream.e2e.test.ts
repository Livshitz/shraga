import { describe, test, expect, beforeAll } from 'bun:test';
import type { AgentEngine } from '../engine/types.ts';

/**
 * End-to-end through the REAL path a background-job / api turn takes: a registered engine →
 * `streamChat` → `consumeStream` with the lane's hooks. Nothing here is a stand-in for the code
 * under test; only the engine is a stub, and it emits exactly what the agentx engine emits when it
 * dispatches a subagent.
 *
 * The regression: these lanes surfaced NOTHING while a turn ran, and dropped `duplex_task`
 * (an add-on engine's subagent pill) on the floor — so a turn that dispatched a worker was
 * indistinguishable from one that only claimed to.
 *
 * DATA_DIR comes from the shared preload (bunfig.toml -> setup.ts).
 */
const { streamChat, consumeStream } = await import('../claude.ts');
const { registerEngine } = await import('../engine/registry.ts');

const dispatcher: AgentEngine = {
  name: 'dispatch-probe',
  getModels: () => [],
  async *stream(opts: any) {
    yield { type: 'text_delta', text: 'dispatching a worker' };
    yield { type: 'duplex_task', taskId: 'w1', status: 'started', label: 'opus think', tier: 'opus' };
    yield { type: 'tool_use', tool: 'Bash', toolUseId: 'b1', input: {} };
    yield { type: 'tool_use_input', toolUseId: 'b1', input: { command: 'run-worker.sh', background: true } };
    yield { type: 'tool_result', toolUseId: 'b1', output: 'Started background job job-abc' };
    yield { type: 'duplex_task', taskId: 'w1', status: 'done' };
    yield { type: 'done', sessionId: opts.sessionId, stopReason: 'end_turn' };
  },
} as any;

describe('a turn that dispatches a worker, on the background-job / api lane', () => {
  const deltas: any[] = [];
  const passthrough: any[] = [];
  let blocks: any[] = [];

  beforeAll(async () => {
    registerEngine(dispatcher);
    blocks = await consumeStream(
      streamChat({ prompt: '[engine:dispatch-probe] send off an opus worker', uid: 'u1', userEmail: 'e@x.com' }),
      undefined,
      {
        maxResultChars: 2000,
        onDelta: (e) => deltas.push(e),
        onPassthrough: (e) => passthrough.push(e),
      },
    );
  });

  test('the transcript keeps the tool pill WITH its filled-in command', () => {
    const pill = blocks.find((b) => b.type === 'tool_use');
    expect(pill).toBeDefined();
    expect(pill.tool).toBe('Bash');
    expect(pill.input).toEqual({ command: 'run-worker.sh', background: true });
    expect(blocks.map((b) => b.type)).toEqual(['text', 'tool_use', 'tool_result']);
  });

  test('a live viewer receives the pill and its argument as it happens', () => {
    expect(deltas.map((d) => d.type)).toEqual(['text_delta', 'tool_use', 'tool_use_input', 'tool_result']);
    expect(deltas.find((d) => d.type === 'tool_use_input').input).toEqual({ command: 'run-worker.sh', background: true });
  });

  test('the subagent events reach the client instead of being dropped', () => {
    expect(passthrough.map((p) => `${p.type}:${p.status}`)).toEqual(['duplex_task:started', 'duplex_task:done']);
    expect(passthrough[0].label).toBe('opus think');
    // Display-only — the engine owns whether a worker's report is persisted.
    expect(blocks.some((b) => b.type === 'duplex_task')).toBe(false);
  });
});
