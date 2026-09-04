import { describe, test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// A leg launcher can only be woken when it finishes if it was started as a REGISTERED background
// job: a foreground tool call is killed at its timeout, the script's own `&`-spawned worker
// outlives it, and nothing ever reports the completion. The env stamp is what lets such a script
// refuse to run in the first place, so it must actually reach the child.
describe('background job child env', () => {
  test('a started job stamps SHRAGA_JOB_ID (its own id) and SHRAGA_BG_JOB into the child', async () => {
    const { startJob, getJob } = await import('../background-jobs.ts');
    const dir = mkdtempSync(path.join(tmpdir(), 'bgjob-env-'));
    const out = path.join(dir, 'env.txt');
    const id = await startJob(
      { sessionId: 'env-test', uid: 'u1', userEmail: 'u1@example.com', cwd: dir },
      `printf '%s %s' "$SHRAGA_JOB_ID" "$SHRAGA_BG_JOB" > ${out}`,
    );
    for (let i = 0; i < 100 && !existsSync(out); i++) await new Promise((r) => setTimeout(r, 50));
    expect(readFileSync(out, 'utf-8')).toBe(`${id} 1`);
    expect(getJob(id)?.id).toBe(id);
  }, 20_000);
});
