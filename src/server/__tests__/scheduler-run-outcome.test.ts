import { describe, test, expect, beforeAll, afterAll, mock } from 'bun:test';
import type { Schedule, ScheduleRunSummary } from '../scheduler/types.ts';
import type { ConvBlock } from '../sessions.ts';

// A scheduled prompt run used to be recorded `ok` for one reason only: the agent's turn returned.
// On 2026-08-28 the 15:30 social run's scout died, nothing was delivered, the run stored `ok`, and
// the (enabled) failure notifier — which is event-driven on `status: 'error'` — was never given a
// failure to see. These drive the REAL runSchedule() with only streamChat stubbed.

type StreamEvent = { type: string; [k: string]: unknown };

let script: StreamEvent[] = [];
/** What the "agent" writes to its outcome file during the turn (see scheduler/outcome.ts). */
let declareDuringTurn: unknown = null;
let lastPrompt = '';

// See scheduler-bash-exit.test.ts for why this stub has to delegate to the real module: mock.module
// is process-global and has no per-file teardown.
const realClaude = { ...(await import('../claude.ts')) };
let stubActive = false;
mock.module('../claude.ts', () => ({
  ...realClaude,
  async *streamChat(opts: Parameters<typeof realClaude.streamChat>[0]) {
    if (!stubActive) { yield* realClaude.streamChat(opts); return; }
    lastPrompt = opts.prompt;
    if (declareDuringTurn !== null) writeOutcome(opts.sessionId!, declareDuringTurn as any);
    for (const ev of script) yield ev;
  },
}));

let runSchedule: (
  s: Schedule,
  onEvent: (ev: object) => void,
  registerRun: (sid: string, ac: AbortController) => void,
) => Promise<ScheduleRunSummary>;
let loadConversation: (sessionId: string) => { role: string; blocks: ConvBlock[] }[];
let writeOutcome: (sessionId: string, o: unknown) => void;
let saveSchedules: (schedules: unknown[]) => void;
let outcomeFile: (sessionId: string) => string;

beforeAll(async () => {
  stubActive = true;
  ({ runSchedule } = await import('../scheduler/runner.ts'));
  ({ loadConversation } = await import('../sessions.ts'));
  ({ writeOutcome, outcomeFile } = await import('../scheduler/outcome.ts') as any);
  ({ saveSchedules } = await import('../scheduler/storage.ts') as any);
});
afterAll(() => { stubActive = false; });

let n = 0;
function makeSchedule(): Schedule {
  const id = `outcome-test-${++n}`;
  return {
    id,
    name: `outcome test ${n}`,
    enabled: true,
    trigger: { kind: 'interval', everyMs: 60_000 },
    task: { kind: 'prompt', prompt: 'run the social routine' },
    scope: 'user',
    createdBy: { uid: 'u1', email: 'u1@example.com' },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    runCount: 0,
  };
}

const DONE: StreamEvent[] = [{ type: 'text_delta', text: 'All done!' }, { type: 'done' }];

async function run(declare: unknown, after?: (sessionId: string) => void) {
  script = DONE;
  declareDuringTurn = declare;
  let sid = '';
  const p = runSchedule(makeSchedule(), () => {}, (s) => { sid = s; });
  if (after) setTimeout(() => after(sid), 30);
  const summary = await p;
  return { summary, blocks: loadConversation(summary.sessionId).flatMap((m) => m.blocks) };
}

describe('scheduled run outcome declaration', () => {
  test('no declaration → unchanged legacy behaviour (turn returned = ok)', async () => {
    const { summary } = await run(null);
    expect(summary.status).toBe('ok');
    expect(summary.error).toBeUndefined();
  });

  test('the run is TOLD how to report itself — with its own outcome file path', async () => {
    let sid = '';
    await runSchedule(makeSchedule(), () => {}, (s) => { sid = s; });
    expect(lastPrompt).toContain(outcomeFile(sid));
    expect(lastPrompt).toContain('"status":"pending"');
  });

  // The incident: a chatty, upbeat turn that delivered nothing must not be recorded as success.
  test('run declares error → run is error, not ok', async () => {
    const { summary, blocks } = await run({ status: 'error', error: 'X scout worker died; no proposal sent' });
    expect(summary.status).toBe('error');
    expect(summary.error).toContain('X scout worker died');
    // Visible in the transcript too, so the session doesn't read as a clean run.
    expect(blocks.some((b) => b.type === 'error')).toBe(true);
  });

  test('run declares ok → ok', async () => {
    const { summary, blocks } = await run({ status: 'ok' });
    expect(summary.status).toBe('ok');
    expect(blocks.some((b) => b.type === 'error')).toBe(false);
  });

  // Defect A's shape: the turn ends early ON PURPOSE (a background job is still running) and a
  // LATER turn in the same session closes the run.
  test('pending → a later turn declares ok → the run waits and lands ok', async () => {
    const t0 = Date.now();
    const { summary } = await run(
      { status: 'pending', deadline: new Date(Date.now() + 2_000).toISOString() },
      (sid) => writeOutcome(sid, { status: 'ok' }),
    );
    expect(summary.status).toBe('ok');
    expect(Date.now() - t0).toBeLessThan(10_000); // it resolved on the declaration, not on a timeout
  });

  test('pending → a later turn declares error → error', async () => {
    const { summary } = await run(
      { status: 'pending', deadline: new Date(Date.now() + 2_000).toISOString() },
      (sid) => writeOutcome(sid, { status: 'error', error: 'publish leg never ran' }),
    );
    expect(summary.status).toBe('error');
    expect(summary.error).toContain('publish leg never ran');
  });

  // The session dying mid-flight is exactly the case that used to report `ok`.
  test('pending with an elapsed deadline → error, not ok', async () => {
    const { summary } = await run({ status: 'pending', deadline: Date.now() - 1_000 });
    expect(summary.status).toBe('error');
    expect(summary.error).toContain('never reported a terminal outcome');
  });

  // A pending run keeps its schedule "running" (engine deletes that only when the run promise
  // settles), so the next fire would be QUEUED behind it. The wait must therefore end at the next
  // window — a 3x-daily schedule must never lose a slot to the previous one still hoping.
  //
  // PRODUCTION SHAPE, and this is the whole point of the test: `fireDue()` starts the run in its
  // first loop and advances `nextRun` in its second, and `startRun` snapshots BEFORE that advance.
  // So the schedule object a run is handed carries the window it is running FOR (in the past),
  // while the ADVANCED next window exists only on disk. A ceiling read from the snapshot is
  // therefore always `Infinity` — inert. Hence: snapshot in the past, disk holding the real next.
  test("pending never outlives the schedule's own next window (read live, not from the snapshot)", async () => {
    script = DONE;
    declareDuringTurn = { status: 'pending', deadline: new Date(Date.now() + 600_000).toISOString() };
    const sched = makeSchedule();
    sched.nextRun = Date.now() - 1_000; // what the RUN sees: the window it is running for
    // What the engine persisted after advancing: windowStop = nextRun - 60s → ~2s from now.
    saveSchedules([{ ...sched, nextRun: Date.now() + 62_000 }]);
    const t0 = Date.now();
    const summary = await runSchedule(sched, () => {}, () => {});
    expect(summary.status).toBe('error');
    expect(summary.error).toContain('next scheduled window arrived first');
    expect(Date.now() - t0).toBeLessThan(30_000); // it did not sit out the 10-minute deadline
  }, 40_000);

  // Every schedule persisted before `task.kind` existed stores only {prompt, model}. The outcome
  // contract is gated on the discriminant, so a kindless task was never told to declare and was
  // never checked — i.e. it reported `ok` no matter what the run actually did.
  test('a task persisted WITHOUT `kind` still gets the outcome contract and can declare error', async () => {
    script = DONE;
    declareDuringTurn = { status: 'error', error: 'scout died; nothing delivered' };
    const sched = makeSchedule();
    delete (sched.task as { kind?: string }).kind;
    let sid = '';
    const summary = await runSchedule(sched, () => {}, (s) => { sid = s; });
    expect(lastPrompt).toContain(outcomeFile(sid));
    expect(summary.status).toBe('error');
    expect(summary.error).toContain('scout died');
  });

  test('loadSchedules infers the missing task kind from the task shape', async () => {
    const { loadSchedules } = await import('../scheduler/storage.ts') as any;
    const sched = makeSchedule();
    delete (sched.task as { kind?: string }).kind;
    saveSchedules([sched]);
    expect(loadSchedules()[0].task.kind).toBe('prompt');
  });

  test('an unparseable declaration is an error, never a silent success', async () => {
    const { summary } = await run({ status: 'delivered-probably' });
    expect(summary.status).toBe('error');
    expect(summary.error).toContain('invalid status');
  });
});
