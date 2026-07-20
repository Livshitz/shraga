import { describe, test, expect, beforeAll, mock } from 'bun:test';
import type { Schedule, ScheduleRunSummary } from '../scheduler/types.ts';
import type { ConvBlock } from '../sessions.ts';

// Drives the REAL runSchedule() against a stubbed engine. streamChat is the only seam replaced —
// session creation, locking, JSONL persistence and the run summary all run for real, so the
// assertions below read the actual transcript the scheduler would write in prod.

type StreamEvent = { type: string; [k: string]: unknown };

/** Per-attempt scripts: attempts[i] is the event sequence the i-th call to streamChat yields.
 *  A script may end with a thrown Error to model a stream that dies mid-flight. */
let attempts: (StreamEvent[] | Error)[] = [];
let calls = 0;

mock.module('../claude.ts', () => ({
  async *streamChat() {
    const script = attempts[calls++] ?? [{ type: 'done' }];
    if (script instanceof Error) throw script;
    for (const ev of script) yield ev;
  },
}));

let runSchedule: (
  s: Schedule,
  onEvent: (ev: object) => void,
  registerRun: (sid: string, ac: AbortController) => void,
) => Promise<ScheduleRunSummary>;
let loadConversation: (sessionId: string) => { role: string; blocks: ConvBlock[] }[];

beforeAll(async () => {
  ({ runSchedule } = await import('../scheduler/runner.ts'));
  ({ loadConversation } = await import('../sessions.ts'));
});

let n = 0;
function makeSchedule(): Schedule {
  const id = `retry-test-${++n}`;
  return {
    id,
    name: `retry test ${n}`,
    enabled: true,
    trigger: { kind: 'interval', everyMs: 60_000 },
    task: { kind: 'prompt', prompt: 'do the thing' },
    scope: 'user',
    createdBy: { uid: 'u1', email: 'u1@example.com' },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    runCount: 0,
  };
}

async function run(script: (StreamEvent[] | Error)[]) {
  attempts = script;
  calls = 0;
  const events: any[] = [];
  const summary = await runSchedule(makeSchedule(), (ev) => events.push(ev), () => {});
  const blocks = loadConversation(summary.sessionId).flatMap((m) => m.blocks);
  return { summary, events, blocks, calls };
}

describe('scheduler prompt-run retry (transient, zero-output failures only)', () => {
  test('fails with NO output on attempt 1, succeeds on attempt 2 → ok, no error block', async () => {
    const { summary, events, blocks, calls } = await run([
      [{ type: 'error', message: 'database is locked' }],
      [{ type: 'text_delta', text: 'hello from attempt 2' }, { type: 'done' }],
    ]);
    expect(calls).toBe(2);
    expect(summary.status).toBe('ok');
    expect(summary.error).toBeUndefined();
    expect(blocks.filter((b) => b.type === 'error')).toHaveLength(0);
    expect(blocks.some((b) => b.type === 'text' && b.text.includes('hello from attempt 2'))).toBe(true);
    // The retry is recorded, not silent.
    expect(blocks.some((b) => b.type === 'text' && b.text.includes('Attempt 1/3'))).toBe(true);
    // The FINAL outcome is what's broadcast.
    const finished = events.find((e) => e.type === 'schedule:run_finished');
    expect(finished.summary.status).toBe('ok');
  });

  test('fails on ALL attempts → exactly ONE error block, status error', async () => {
    const err = [{ type: 'error', message: 'database is locked' }];
    const { summary, blocks, calls } = await run([err, err, err]);
    expect(calls).toBe(3); // bounded: 3 attempts, no more
    expect(summary.status).toBe('error');
    expect(summary.error).toBe('database is locked');
    const errorBlocks = blocks.filter((b) => b.type === 'error');
    expect(errorBlocks).toHaveLength(1);
    expect((errorBlocks[0] as any).text).toBe('database is locked');
  });

  test('BOUNDARY: emits a tool_use then fails → NOT retried (side effect already happened)', async () => {
    const { summary, blocks, calls } = await run([
      [
        { type: 'tool_use', tool: 'Bash', toolUseId: 't1', input: { command: 'post-slack-dm' } },
        { type: 'error', message: 'database is locked' },
      ],
      [{ type: 'text_delta', text: 'MUST NOT HAPPEN' }, { type: 'done' }],
    ]);
    expect(calls).toBe(1);
    expect(summary.status).toBe('error');
    expect(blocks.filter((b) => b.type === 'error')).toHaveLength(1);
    expect(blocks.some((b) => b.type === 'tool_use')).toBe(true);
    expect(blocks.some((b) => (b as any).text?.includes('MUST NOT HAPPEN'))).toBe(false);
  });

  test('BOUNDARY: produced text then failed → NOT retried', async () => {
    const { summary, blocks, calls } = await run([
      [{ type: 'text_delta', text: 'partial answer' }, { type: 'error', message: 'boom' }],
      [{ type: 'text_delta', text: 'MUST NOT HAPPEN' }, { type: 'done' }],
    ]);
    expect(calls).toBe(1);
    expect(summary.status).toBe('error');
    expect(blocks.some((b) => b.type === 'text' && b.text.includes('partial answer'))).toBe(true);
    expect(blocks.some((b) => (b as any).text?.includes('MUST NOT HAPPEN'))).toBe(false);
  });

  test('a thrown stream (not an error event) with no output is retried too', async () => {
    const { summary, calls } = await run([
      new Error('fetch failed: ANTHROPIC_BASE_URL unreachable'),
      [{ type: 'text_delta', text: 'recovered' }, { type: 'done' }],
    ]);
    expect(calls).toBe(2);
    expect(summary.status).toBe('ok');
  });

  // A user cancel is not a failure — aborting must end the run, never re-fire it.
  test('user abort with no output is NOT retried', async () => {
    attempts = [
      [{ type: 'error', message: 'aborted by user' }],
      [{ type: 'text_delta', text: 'MUST NOT HAPPEN' }, { type: 'done' }],
    ];
    calls = 0;
    const summary = await runSchedule(makeSchedule(), () => {}, (_sid, ac) => ac.abort());
    expect(calls).toBe(1);
    expect(summary.status).toBe('aborted');
    const blocks = loadConversation(summary.sessionId).flatMap((m) => m.blocks);
    expect(blocks.filter((b) => b.type === 'error')).toHaveLength(0);
    expect(blocks.some((b) => (b as any).text?.includes('MUST NOT HAPPEN'))).toBe(false);
  });

  // Cancelling DURING the backoff window must land immediately — not sit out the delay holding the
  // session lock, and never spawn the next attempt.
  test('user abort DURING the backoff is honoured: no attempt 2, status aborted, wakes early', async () => {
    attempts = [
      [{ type: 'error', message: 'database is locked' }],
      [{ type: 'text_delta', text: 'MUST NOT HAPPEN' }, { type: 'done' }],
    ];
    calls = 0;
    const t0 = Date.now();
    const summary = await runSchedule(makeSchedule(), () => {}, (_sid, ac) => {
      setTimeout(() => ac.abort(), 50); // 50ms into a >=250ms backoff
    });
    const elapsed = Date.now() - t0;
    expect(calls).toBe(1);
    expect(summary.status).toBe('aborted');
    expect(summary.error).toBeUndefined();
    // Woke on the signal rather than serving the full (jittered, >=250ms) backoff.
    expect(elapsed).toBeLessThan(200);
    const blocks = loadConversation(summary.sessionId).flatMap((m) => m.blocks);
    expect(blocks.filter((b) => b.type === 'error')).toHaveLength(0);
    expect(blocks.some((b) => (b as any).text?.includes('MUST NOT HAPPEN'))).toBe(false);
    // The normal abort path still fires.
    expect(blocks.some((b) => (b as any).text?.includes('⛔ Run aborted by user'))).toBe(true);
  });

  // Thinking is billed model output that lands in no block — retrying re-bills a real model call.
  test('BOUNDARY: thinking then failed → NOT retried', async () => {
    const { summary, calls } = await run([
      [{ type: 'thinking_delta', text: 'let me reason about this…' }, { type: 'error', message: 'boom' }],
      [{ type: 'text_delta', text: 'MUST NOT HAPPEN' }, { type: 'done' }],
    ]);
    expect(calls).toBe(1);
    expect(summary.status).toBe('error');
    expect(summary.error).toBe('boom');
  });

  test('clean success on attempt 1 does not retry', async () => {
    const { summary, calls } = await run([[{ type: 'text_delta', text: 'fine' }, { type: 'done' }]]);
    expect(calls).toBe(1);
    expect(summary.status).toBe('ok');
  });
});
