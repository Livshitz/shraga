import { describe, test, expect, beforeAll, afterAll, mock } from 'bun:test';
import type { Schedule, ScheduleRunSummary } from '../scheduler/types.ts';
import type { ConvBlock } from '../sessions.ts';

// A `bash` schedule is NOT exec'd — it's handed to the agent as a prompt. So a non-zero exit used to
// vanish: the agent narrated the failure, its own turn succeeded, the run stored `ok`, and the failure
// notifier never fired (a broken MRR script silently wrote a half-empty row for a day). These drive the
// REAL runSchedule() with only streamChat stubbed.

type StreamEvent = { type: string; [k: string]: unknown };

let script: StreamEvent[] = [];
let calls = 0;

// `mock.module` is process-global: it replaces claude.ts for EVERY importer for the rest of the run,
// and there is no per-file teardown. So this replacement must be invisible to sibling test files on
// both counts —
//   1. spread the real namespace, or the other exports vanish and any file importing one fails to
//      link ("Export named 'getAgentConfig' not found");
//   2. delegate to the real streamChat unless OUR tests are running, or files that drive the genuine
//      streamChat (turn-context.wiring) silently get this stub and their engine never runs.
// Both failures land in unrelated files and depend on execution order, which is what makes them so
// confusing to chase. bun runs test files sequentially, so the beforeAll/afterAll flag is sufficient.
// SNAPSHOT the namespace before registering: `mock.module` MUTATES the live module object in place,
// so a later `ns.streamChat` resolves to this very stub and delegating through it recurses until the
// stack blows. Copy the real bindings out first and only ever touch the copy.
const realClaude = { ...(await import('../claude.ts')) };
let stubActive = false;
mock.module('../claude.ts', () => ({
  ...realClaude,
  async *streamChat(opts: Parameters<typeof realClaude.streamChat>[0]) {
    if (!stubActive) { yield* realClaude.streamChat(opts); return; }
    calls++;
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
  stubActive = true;
  ({ runSchedule } = await import('../scheduler/runner.ts'));
  ({ loadConversation } = await import('../sessions.ts'));
});
afterAll(() => { stubActive = false; });

const CMD = 'bun run data/scripts/daily-mrr-sheet.ts';

let n = 0;
function makeSchedule(): Schedule {
  const id = `bash-exit-test-${++n}`;
  return {
    id,
    name: `bash exit test ${n}`,
    enabled: true,
    trigger: { kind: 'interval', everyMs: 60_000 },
    task: { kind: 'bash', command: CMD },
    scope: 'user',
    createdBy: { uid: 'u1', email: 'u1@example.com' },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    runCount: 0,
  };
}

async function run(events: StreamEvent[]) {
  script = events;
  calls = 0;
  const evs: any[] = [];
  const summary = await runSchedule(makeSchedule(), (ev) => evs.push(ev), () => {});
  const blocks = loadConversation(summary.sessionId).flatMap((m) => m.blocks);
  return { summary, events: evs, blocks, calls };
}

// The REAL ordering: `tool_use` is yielded at content_block_start, when the input is still EMPTY —
// the command only arrives later as `tool_use_input`. Matching the command at `tool_use` time matched
// nothing, and the whole fix was inert in prod while passing a test that pre-filled the input.
const bashUse = (id: string, command = CMD) => [
  { type: 'tool_use', tool: 'Bash', toolUseId: id, input: {} },
  { type: 'tool_use_input', toolUseId: id, input: { command } },
];

describe('scheduler bash-task exit code', () => {
  test('command fails but the agent turn succeeds → run is error, not ok', async () => {
    const { summary, blocks, calls } = await run([
      ...bashUse('t1'),
      { type: 'tool_result', toolUseId: 't1', output: 'error: provider(s) failed wholesale: appstore', isError: true },
      { type: 'text_delta', text: 'The script failed; App Store data was unavailable.' },
      { type: 'done' },
    ]);
    expect(calls).toBe(1); // a failed COMMAND is not a transient engine failure — never retried
    expect(summary.status).toBe('error');
    expect(summary.error).toContain('provider(s) failed wholesale: appstore');
    // The failure is in the transcript too, so the session doesn't read as a clean run.
    expect(blocks.some((b) => b.type === 'error')).toBe(true);
    // The late-arriving input is folded into the persisted block — otherwise the transcript shows the
    // command as an empty `{}` and nobody can tell what actually ran.
    const use = blocks.find((b) => b.type === 'tool_use') as any;
    expect(use.input).toEqual({ command: CMD });
  });

  test('command succeeds → ok', async () => {
    const { summary, blocks } = await run([
      ...bashUse('t1'),
      { type: 'tool_result', toolUseId: 't1', output: '{"ok":true}', isError: false },
      { type: 'text_delta', text: 'MRR row written.' },
      { type: 'done' },
    ]);
    expect(summary.status).toBe('ok');
    expect(summary.error).toBeUndefined();
    expect(blocks.some((b) => b.type === 'error')).toBe(false);
  });

  test('an UNRELATED tool failing does not fail the run', async () => {
    // Only the task's own command decides the outcome — the agent poking around (a failed `ls`, a
    // denied tool) is its business, not a schedule failure.
    const { summary } = await run([
      ...bashUse('t0', 'ls /nope'),
      { type: 'tool_result', toolUseId: 't0', output: 'No such file or directory', isError: true },
      ...bashUse('t1'),
      { type: 'tool_result', toolUseId: 't1', output: '{"ok":true}' },
      { type: 'done' },
    ]);
    expect(summary.status).toBe('ok');
  });
});
