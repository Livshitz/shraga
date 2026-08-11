import { describe, test, expect, beforeAll } from 'bun:test';
import type { Schedule, ScheduleRunSummary } from '../scheduler/types.ts';
import type { ConvBlock } from '../sessions.ts';

// Drives the REAL runSchedule() over a REAL `job` task — the command actually spawns, so these
// assertions cover the exit-status plumbing (close(code, signal)) end to end, not a stub of it.
//
// Regression: a job killed by a signal (systemd stopping the service on a deploy/restart SIGTERMs
// the whole cgroup, children included) used to be reported as status `error` whose message was the
// job's own progress output — which fired the failure notifier with an un-actionable alert and no
// trace of the real cause. See the summarizer outage of 2026-08-11.

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
async function runJobCommand(command: string) {
  const id = `job-signal-test-${++n}`;
  const schedule: Schedule = {
    id,
    name: `job signal test ${n}`,
    enabled: true,
    trigger: { kind: 'interval', everyMs: 60_000 },
    task: { kind: 'job', command },
    scope: 'user',
    createdBy: { uid: 'u1', email: 'u1@example.com' },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    runCount: 0,
  };
  const summary = await runSchedule(schedule, () => {}, () => {});
  const text = loadConversation(summary.sessionId)
    .flatMap((m) => m.blocks)
    .map((b: any) => b.text ?? '')
    .join('\n');
  return { summary, text };
}

describe('job runs report HOW they ended', () => {
  test('a signal-killed job is aborted, not a failure', async () => {
    // Mid-run kill, after the job has already produced output — the shape that misreported.
    const { summary, text } = await runJobCommand('echo "summarized 5 sessions"; kill -TERM $$');

    // `error` is what the failure notifier matches on; an interrupted run must not fire it.
    expect(summary.status).toBe('aborted');
    expect(summary.error).toContain('SIGTERM');
    // The progress output is kept as CONTEXT, never passed off as the error itself.
    expect(summary.error).toContain('summarized 5 sessions');
    expect(text).toContain('interrupted');
  }, 15_000);

  test('a non-zero exit keeps its exit code even when the job printed output', async () => {
    const { summary } = await runJobCommand('echo "some progress"; exit 3');

    expect(summary.status).toBe('error');
    expect(summary.error).toContain('exit code 3');
    expect(summary.error).toContain('some progress');
  }, 15_000);

  test('a clean job still succeeds', async () => {
    const { summary } = await runJobCommand('echo done');

    expect(summary.status).toBe('ok');
    expect(summary.error).toBeUndefined();
  }, 15_000);
});
