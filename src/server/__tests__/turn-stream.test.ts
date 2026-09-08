import { describe, it, expect } from 'bun:test';
import { createTurnAccumulator } from '../turn-stream.ts';
import { consumeStream } from '../claude.ts';

const collect = () => {
  const deltas: any[] = [];
  const passthrough: any[] = [];
  const acc = createTurnAccumulator({
    maxResultChars: 10,
    onDelta: (e) => deltas.push(e),
    onPassthrough: (e) => passthrough.push(e),
  });
  return { acc, deltas, passthrough };
};

describe('turn accumulator', () => {
  it('fills a tool_use opened with an empty input, and streams the fill', () => {
    // The claude-code engine opens the pill empty; lanes that dropped `tool_use_input` rendered
    // pills labelled with nothing.
    const { acc, deltas } = collect();
    acc.push({ type: 'tool_use', tool: 'Bash', toolUseId: 't1', input: {} });
    acc.push({ type: 'tool_use_input', toolUseId: 't1', input: { command: 'ls' } });
    expect(acc.finish()).toEqual([{ type: 'tool_use', tool: 'Bash', toolUseId: 't1', input: { command: 'ls' } }]);
    expect(deltas.map((d) => d.type)).toEqual(['tool_use', 'tool_use_input']);
  });

  it('forwards an add-on engine event instead of dropping it', () => {
    // A dispatched subagent arrives as duplex_task — not core-owned. Dropping it is what made a
    // worker invisible on every lane but the websocket one.
    const { acc, deltas, passthrough } = collect();
    acc.push({ type: 'duplex_task', taskId: 'w1', status: 'started', label: 'opus think' });
    expect(passthrough).toEqual([{ type: 'duplex_task', taskId: 'w1', status: 'started', label: 'opus think' }]);
    expect(deltas).toEqual([]);
    expect(acc.finish()).toEqual([]); // display-only: the engine owns its own persistence
  });

  it('never forwards control events', () => {
    const { acc, passthrough } = collect();
    for (const type of ['permission_request', 'question_request', 'model_resolved', 'stats']) acc.push({ type });
    expect(passthrough).toEqual([]);
  });

  it('truncates a streamed tool_result but keeps the transcript whole', () => {
    const { acc, deltas } = collect();
    acc.push({ type: 'tool_result', toolUseId: 't1', output: 'x'.repeat(50) });
    expect(deltas[0].output).toBe('x'.repeat(10) + '…');
    expect((acc.finish()[0] as any).output).toBe('x'.repeat(50));
  });

  it('orders thinking before the text it precedes, and reports the stop reason', () => {
    const { acc } = collect();
    acc.push({ type: 'thinking_delta', text: 'hm' });
    acc.push({ type: 'text_delta', text: 'hi' });
    acc.push({ type: 'done', sessionId: 's', stopReason: 'max_turns_reached' });
    expect(acc.stopReason).toBe('max_turns_reached');
    expect(acc.finish()).toEqual([{ type: 'thinking', text: 'hm' }, { type: 'text', text: 'hi' }]);
  });

  it('snapshot() exposes in-progress text for a live partial', () => {
    const { acc } = collect();
    acc.push({ type: 'tool_use', tool: 'Bash', toolUseId: 't1', input: { command: 'ls' } });
    acc.push({ type: 'text_delta', text: 'partial' });
    expect(acc.snapshot()).toHaveLength(2);
    expect(acc.blocks).toHaveLength(1); // not yet flushed
  });
});

describe('consumeStream (the background-job / api / scheduler lane)', () => {
  async function* stream(evs: any[]) { for (const e of evs) yield e; }

  it('streams deltas and forwards subagent events while building the transcript', async () => {
    const deltas: any[] = [];
    const passthrough: any[] = [];
    const blocks = await consumeStream(
      stream([
        { type: 'text_delta', text: 'dispatching' },
        { type: 'duplex_task', taskId: 'w1', status: 'started' },
        { type: 'tool_use', tool: 'Bash', toolUseId: 't1', input: {} },
        { type: 'tool_use_input', toolUseId: 't1', input: { command: 'run-worker' } },
        { type: 'tool_result', toolUseId: 't1', output: 'started job-abc' },
        { type: 'done', sessionId: 's' },
      ]) as any,
      undefined,
      { onDelta: (e) => deltas.push(e), onPassthrough: (e) => passthrough.push(e) },
    );
    expect(blocks.map((b) => b.type)).toEqual(['text', 'tool_use', 'tool_result']);
    expect((blocks[1] as any).input).toEqual({ command: 'run-worker' });
    expect(deltas.map((d) => d.type)).toEqual(['text_delta', 'tool_use', 'tool_use_input', 'tool_result']);
    expect(passthrough.map((p) => p.type)).toEqual(['duplex_task']);
  });
});
