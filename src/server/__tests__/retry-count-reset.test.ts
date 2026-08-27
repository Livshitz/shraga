// runRetryCount caps the crash-resume loop, and a session that hits the cap loses auto-resume for
// good: every later restart ends at "please send a message to continue" and the human has to poke
// it. It used to be reset only on the web path, so Slack/scheduler sessions accumulated it for
// life — 18 live sessions were sitting at the cap when this was found.
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let dir: string;
let prevData: string | undefined;
let sessions: typeof import('../sessions.ts');

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'shraga-retry-'));
  prevData = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  sessions = await import(`../sessions.ts?retry=${Math.random()}`);
});

afterEach(() => {
  if (prevData === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = prevData;
  rmSync(dir, { recursive: true, force: true });
});

const seed = (id: string) => {
  sessions.upsertSession(id, 'hello', { uid: 'u', email: 'u@example.com' });
};

test('a turn that reaches idle clears the retry count — for every origin, not just web', () => {
  for (const origin of ['slack', 'scheduler', 'web'] as const) {
    const id = `s-${origin}`;
    seed(id);
    sessions.incrementRetryCount(id);
    sessions.incrementRetryCount(id);
    expect(sessions.getSession(id)?.runRetryCount).toBe(2);

    sessions.setRunStatus(id, 'running', origin);
    sessions.setRunStatus(id, 'idle');
    expect(sessions.getSession(id)?.runRetryCount).toBe(0);
  }
});

test('a drain-time idle does not clear it — that turn WAS killed by the restart', () => {
  seed('s-drain');
  sessions.incrementRetryCount('s-drain');
  sessions.setShuttingDown();
  sessions.setRunStatus('s-drain', 'idle');
  expect(sessions.getSession('s-drain')?.runRetryCount).toBe(1);
  expect(sessions.getSession('s-drain')?.runStatus).not.toBe('idle');
});
