// In-process MCP server exposing the durable background-job registry (background-jobs.ts) to the
// claude-code engine.
//
// Why this exists: on the claude-code engine the model's only two ways to run long work were both
// broken. `Bash{run_in_background}` jobs live inside the CLI process, and the engine bounds the
// bg wait (BG_TASK_MAX_WAIT_MS) — a job longer than that dies with the CLI, silently. Folklore
// `nohup … &` survives, but nothing wakes the session when it exits, so the outcome lands nowhere
// (a headless worker "finished" and nobody checked its deliverable — the viral-quickcut incident).
// The server-owned registry solves exactly this (detached children, wake-on-exit via wake.ts,
// restart adoption), and the agentx engine already mounts it as Shell/ShellOutput/… tools. This
// file is the same registry behind SDK MCP tools, the way share-file.ts mounts `share_file`.
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';
import { sessionJobRegistry, type JobOwner } from './background-jobs.ts';
import { JOBS_SERVER } from './security/enforce.ts';
/** Tool ids as the SDK exposes them, for allowedTools. */
export const JOBS_TOOL_IDS = ['job_start', 'job_status', 'job_output', 'job_kill', 'job_list']
  .map((t) => `mcp__${JOBS_SERVER}__${t}`);

const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }], ...(isError ? { isError: true } : {}) });

/** In-process MCP server over the session's view of the job registry. Mount per turn (the view is
 *  stateless); the jobs belong to the server and outlive the turn, the CLI, and a server restart. */
export function jobsMcpServer(owner: JobOwner) {
  const reg = sessionJobRegistry(owner);
  return createSdkMcpServer({
    name: JOBS_SERVER,
    version: '1.0.0',
    tools: [
      tool(
        'job_start',
        'Run a shell command as a DURABLE background job, owned by the server: it survives the end of this turn (and even a server restart), and when it exits you are woken with its outcome — never use `nohup …/​… &` for long work, and never launch work longer than ~10 minutes with Bash run_in_background (it is killed when the turn\'s wait budget ends). After starting one you may end your turn; you will be woken. A headless worker (`claude -p …`) MUST be launched this way.',
        { command: z.string().min(1).describe('Shell command line. Runs detached, in the session cwd; stdout+stderr go to the job log.') },
        async ({ command }) => {
          try {
            const id = await reg.start(command);
            return text(`Started background job ${id}. It keeps running after this turn ends; you will be woken when it exits. Check it with job_status/job_output. Its exit is NOT completion — on wake, verify the job\'s deliverable itself.`);
          } catch (e) { return text(`job_start failed: ${(e as Error).message}`, true); }
        },
      ),
      tool(
        'job_status',
        'Status of one background job (running/exited + exit code). Returns no output; a finished job still wakes you later unless you read job_output.',
        { id: z.string().min(1) },
        async ({ id }) => {
          const s = reg.status(id);
          return s ? text(JSON.stringify(s)) : text(`no such job in this session: ${id}`, true);
        },
      ),
      tool(
        'job_output',
        'Tail of a background job\'s log. Reading a FINISHED job\'s output marks it observed (no follow-up wake) — so only read it when you will act on the result now.',
        { id: z.string().min(1) },
        async ({ id }) => {
          const out = reg.output(id);
          return out == null ? text(`no such job in this session: ${id}`, true) : text(out || '(no output yet)');
        },
      ),
      tool(
        'job_kill',
        'Kill a background job (its whole process group).',
        { id: z.string().min(1) },
        async ({ id }) => (reg.kill(id) ? text(`killed ${id}`) : text(`no such running job: ${id}`, true)),
      ),
      tool(
        'job_list',
        'List this session\'s background jobs.',
        {},
        async () => text(JSON.stringify(reg.list())),
      ),
    ],
  });
}
