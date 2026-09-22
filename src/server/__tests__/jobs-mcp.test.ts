import { describe, test, expect } from 'bun:test';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// The viral-quickcut incident: on the claude-code engine a long worker had no correct launch —
// `run_in_background` dies with the turn's wait budget, `nohup … &` exits to no one. These tools
// hand the model the server-owned registry (turn/CLI/restart-surviving, wake-on-exit).
describe('jobs MCP server', () => {
  test('job_start runs a durable job; status and output tools see it', async () => {
    const { jobsMcpServer, JOBS_TOOL_IDS } = await import('../jobs-mcp.ts');
    const dir = mkdtempSync(path.join(tmpdir(), 'jobs-mcp-'));
    const out = path.join(dir, 'done.txt');
    const s = jobsMcpServer({ sessionId: 'jobs-mcp-test', uid: 'u1', userEmail: 'u1@example.com', cwd: dir });
    expect(s.type).toBe('sdk');
    expect(s.name).toBe('jobs');
    expect(JOBS_TOOL_IDS).toContain('mcp__jobs__job_start');
    const tools = (s.instance as any)._registeredTools;

    const started = await tools.job_start.handler({ command: `echo deliverable > ${out}; echo finished` }, {});
    expect(started.isError).toBeUndefined();
    const id = /job ([a-z0-9-]+)\./.exec(started.content[0].text)![1];

    for (let i = 0; i < 100 && !existsSync(out); i++) await new Promise((r) => setTimeout(r, 50));
    expect(readFileSync(out, 'utf-8').trim()).toBe('deliverable');

    // status is session-scoped and returns no output
    let st = JSON.parse((await tools.job_status.handler({ id }, {})).content[0].text);
    for (let i = 0; i < 100 && st.status === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 50));
      st = JSON.parse((await tools.job_status.handler({ id }, {})).content[0].text);
    }
    expect(st.status).toBe('exited');
    expect((await tools.job_output.handler({ id }, {})).content[0].text).toContain('finished');
    const listed = JSON.parse((await tools.job_list.handler({}, {})).content[0].text);
    expect(listed.some((j: any) => j.id === id)).toBe(true);

    // another session cannot see it
    const other = jobsMcpServer({ sessionId: 'someone-else', uid: 'u2', cwd: dir });
    const foreign = await (other.instance as any)._registeredTools.job_status.handler({ id }, {});
    expect(foreign.isError).toBe(true);
  }, 20_000);

  test('profile gate: jobs tools are exactly as available as Bash', async () => {
    const { profileAllowsTool } = await import('../security/enforce.ts');
    expect(profileAllowsTool({ tools: ['*'], mcps: [] }, 'mcp__jobs__job_start')).toBe(true);
    expect(profileAllowsTool({ tools: ['Read'], mcps: ['*'] }, 'mcp__jobs__job_start')).toBe(false);
  });
});
