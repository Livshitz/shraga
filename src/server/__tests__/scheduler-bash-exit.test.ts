import { describe, test, expect, beforeAll, mock } from 'bun:test';
import type { Schedule, ScheduleRunSummary } from '../scheduler/types.ts';
import type { ConvBlock } from '../sessions.ts';

// A `bash` schedule is NOT exec'd — it's handed to the agent as a prompt. So a non-zero exit used to
// vanish: the agent narrated the failure, its own turn succeeded, the run stored `ok`, and the failure
// notifier never fired (a broken MRR script silently wrote a half-empty row for a day). These drive the
// REAL runSchedule() with only streamChat stubbed.

type StreamEvent = { type: string; [k: string]: unknown };

let script: StreamEvent[] = [];
let calls = 0;

mock.module('../claude.ts', () => ({
  async *streamChat() {
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
  ({ runSchedule } = await import('../scheduler/runner.ts'));
  ({ loadConversation } = await import('../sessions.ts'));
});

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

const bashUse = (id: string, command = CMD) => ({ type: 'tool_use', tool: 'Bash', toolUseId: id, input: { command } });

describe('scheduler bash-task exit code', () => {
  test('command fails but the agent turn succeeds → run is error, not ok', async () => {
    const { summary, blocks, calls } = await run([
      bashUse('t1'),
      { type: 'tool_result', toolUseId: 't1', output: 'error: provider(s) failed wholesale: appstore', isError: true },
      { type: 'text_delta', text: 'The script failed; App Store data was unavailable.' },
      { type: 'done' },
    ]);
    expect(calls).toBe(1); // a failed COMMAND is not a transient engine failure — never retried
    expect(summary.status).toBe('error');
    expect(summary.error).toContain('provider(s) failed wholesale: appstore');
    // The failure is in the transcript too, so the session doesn't read as a clean run.
    expect(blocks.some((b) => b.type === 'error')).toBe(true);
  });

  test('command succeeds → ok', async () => {
    const { summary, blocks } = await run([
      bashUse('t1'),
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
      { type: 'tool_use', tool: 'Bash', toolUseId: 't0', input: { command: 'ls /nope' } },
      { type: 'tool_result', toolUseId: 't0', output: 'No such file or directory', isError: true },
      bashUse('t1'),
      { type: 'tool_result', toolUseId: 't1', output: '{"ok":true}' },
      { type: 'done' },
    ]);
    expect(summary.status).toBe('ok');
  });
});
