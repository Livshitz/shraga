import { describe, test, expect, beforeAll } from 'bun:test';
import type { Schedule, ScheduleRunSummary } from '../scheduler/types.ts';
import type { AgentEngine } from '../engine/types.ts';

// Live incident (Circles prod, v0.1.164): a scheduled prompt run went silent mid-turn, was still
// "running" 4.5h later, and POST /api/schedules/:id/cancel answered {ok:true} while the run stayed
// registered — blocking self-upgrade as both a running job and an in-flight agent turn.
// Cause: the run awaits the engine stream's next(); abort is cooperative, so a next() that never
// settles keeps runSchedule() pending, and the running map + session lock are only cleared in
// finally blocks that never run. These drive the REAL runSchedule() + streamChat() through an engine
// whose stream hangs and IGNORES the abort signal — the worst case below the SDK.

const HANG = 'zombie-hang-engine';
const hangingEngine: AgentEngine = {
  name: HANG,
  getModels: () => [],
  async *stream() {
    yield { type: 'text_delta', text: 'working…' } as any;
    await new Promise(() => {}); // a stuck await below the SDK: never settles, never sees the abort
  },
};

let runSchedule: (s: Schedule, onEvent: (ev: object) => void, registerRun: (sid: string, ac: AbortController) => void) => Promise<ScheduleRunSummary>;
let isSessionLocked: (sid: string) => boolean;

beforeAll(async () => {
  const { initEngines } = await import('../engine/index.ts');
  await initEngines();
  (await import('../engine/registry.ts')).registerEngine(hangingEngine);
  ({ runSchedule } = await import('../scheduler/runner.ts'));
  ({ isSessionLocked } = await import('../sessions.ts'));
});

let n = 0;
const makeSchedule = (): Schedule => ({
  id: `zombie-${++n}`,
  name: `zombie ${n}`,
  enabled: true,
  trigger: { kind: 'interval', everyMs: 60_000 },
  task: { kind: 'prompt', prompt: `[engine:${HANG}] sync new campaigns` },
  scope: 'user',
  createdBy: { uid: 'u1', email: 'u1@example.com' },
  createdAt: Date.now(),
  updatedAt: Date.now(),
  runCount: 0,
});

/** Resolves to the settled value, or 'HUNG' if the promise is still pending after `ms`. */
const within = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<'HUNG'>((r) => setTimeout(() => r('HUNG'), ms))]);

describe('a hung scheduled run cannot become a zombie', () => {
  test('cancel ends the run and releases the session lock even when the stream ignores abort', async () => {
    let sid = '';
    let ac: AbortController | undefined;
    const p = runSchedule(makeSchedule(), () => {}, (s, c) => { sid = s; ac = c; });
    await Bun.sleep(100);
    expect(isSessionLocked(sid)).toBe(true); // it really is mid-turn
    ac!.abort(); // what engine.cancelRun() does; the stream gets its 5s grace, then is cut
    const summary = await within(p, 8_000);
    expect(summary).not.toBe('HUNG');
    expect((summary as ScheduleRunSummary).status).toBe('aborted');
    expect(isSessionLocked(sid)).toBe(false); // the "agent turn in flight" count drops too
  }, 15_000);

  test('a run that hangs past its turn deadline is ended as an error (no cancel needed)', async () => {
    const prev = process.env.SCHEDULER_MAX_TURN_MS;
    process.env.SCHEDULER_MAX_TURN_MS = '300';
    try {
      let sid = '';
      const summary = await within(runSchedule(makeSchedule(), () => {}, (s) => { sid = s; }), 8_000);
      expect(summary).not.toBe('HUNG');
      expect((summary as ScheduleRunSummary).status).toBe('error');
      expect((summary as ScheduleRunSummary).error).toContain('deadline');
      expect(isSessionLocked(sid)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.SCHEDULER_MAX_TURN_MS; else process.env.SCHEDULER_MAX_TURN_MS = prev;
    }
  }, 15_000);
});
