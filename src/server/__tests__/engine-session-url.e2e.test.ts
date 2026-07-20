import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import type { Schedule } from '../scheduler/types.ts';

const ORIGINAL_ORIGIN = process.env.PUBLIC_ORIGIN;
afterAll(() => {
  if (ORIGINAL_ORIGIN === undefined) delete process.env.PUBLIC_ORIGIN;
  else process.env.PUBLIC_ORIGIN = ORIGINAL_ORIGIN;
});

// Drives the REAL scheduler engine (start → runNow → startRun → emitEvent) and reads
// `schedule.finished` off the REAL event bus — the same path the failure notifier consumes.
// A `job` task that exits non-zero is the cheapest genuine `status: error` run: it needs no
// agent/LLM seam, so nothing here is a hand-written stand-in for the code under test.

let engine: typeof import('../scheduler/engine.ts');
let subscribeEvents: typeof import('../events/bus.ts').subscribeEvents;

beforeAll(async () => {
  engine = await import('../scheduler/engine.ts');
  ({ subscribeEvents } = await import('../events/bus.ts'));
  engine.start(() => {});
});

let n = 0;
function failingSchedule(): Schedule {
  return {
    id: `sessionurl-test-${++n}`,
    name: `session url test ${n}`,
    enabled: true,
    trigger: { kind: 'interval', everyMs: 3_600_000 },
    task: { kind: 'job', command: 'exit 7' },
    scope: 'user',
    createdBy: { uid: 'u1', email: 'u1@example.com' },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    runCount: 0,
  } as Schedule;
}

/** Run one schedule to failure and return the schedule.finished payload the bus carried. */
async function finishedPayload(): Promise<any> {
  const s = failingSchedule();
  engine.upsertSchedule(s);
  const got = new Promise<any>((resolve) => {
    const unsub = subscribeEvents((evt) => {
      if (evt.source === 'schedule.finished' && (evt.payload as any).scheduleId === s.id) {
        unsub?.();
        resolve(evt.payload);
      }
    });
  });
  engine.runNow(s.id);
  const payload = await got;
  // schedule.finished is emitted from the run's .then(), i.e. before the .finally() that
  // deregisters the run. Let it settle so we don't leave engine state dirty for later files.
  for (let i = 0; i < 100 && engine.getRunningIds().includes(s.id); i++) await new Promise((r) => setTimeout(r, 25));
  // Teardown for the session this run created. A scheduler run leaves `runStatus: running` in
  // the shared test DATA_DIR, and boot's 90s shutdown drain blocks on getRunningSessions() — so
  // a leftover row here times out the afterAll of any LATER file that boots a server. Waiting for
  // it to clear on its own is not reliable, so force it idle once the run has settled.
  // NOTE: setRunStatus(id, 'idle') cannot be used — it early-returns once anything in the process
  // has called setShuttingDown(), and an earlier test file stopping a server latches that flag for
  // the rest of the run. So drop the row from the index directly.
  if (payload.sessionId) {
    const { getRunningSessions } = await import('../sessions.ts');
    for (let i = 0; i < 40 && getRunningSessions().some((r) => r.sessionId === payload.sessionId); i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const { dataPath } = await import('../paths.ts');
    const { existsSync, readFileSync, writeFileSync } = await import('node:fs');
    const indexPath = dataPath('sessions.json');
    if (existsSync(indexPath)) {
      const rows = JSON.parse(readFileSync(indexPath, 'utf-8')) as { sessionId: string }[];
      writeFileSync(indexPath, JSON.stringify(rows.filter((r) => r.sessionId !== payload.sessionId), null, 2));
    }
  }
  // The engine persists into the shared test DATA_DIR; don't leave an enabled schedule behind.
  engine.deleteSchedule(s.id);
  return payload;
}

describe('schedule.finished carries a ready-made session URL', () => {
  test('absolute link when a public origin is configured', async () => {
    process.env.PUBLIC_ORIGIN = 'https://agent.example.com';
    const payload = await finishedPayload();
    expect(payload.status).toBe('error');
    expect(payload.sessionUrl).toBe(`https://agent.example.com/?session=${payload.sessionId}`);
    // The whole point: reachable off-box, not the local port.
    expect(payload.sessionUrl).not.toContain('localhost');
  });

  test('no link at all when unconfigured — nothing for the model to mistake for a URL', async () => {
    delete process.env.PUBLIC_ORIGIN;
    const payload = await finishedPayload();
    expect(payload.status).toBe('error');
    expect(payload.sessionUrl).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain('localhost');
  });
});
