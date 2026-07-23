import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, isAbsolute } from 'node:path';
import { DATA_DIR } from '../paths.ts';
import { streamChat, type PermissionHandler } from '../claude.ts';
import { getMcpConfig } from '../mcp.ts';
import { appendMessage, createScheduledSession, updateScheduledSessionStatus, setRunStatus, registerLivePartial, unregisterLivePartial, writePartial, clearPartial, acquireSessionLock, releaseSessionLock, type ConvBlock } from '../sessions.ts';
import type { Schedule, ScheduleRunSummary } from './types.ts';
import { writeRunningMarker, clearRunningMarker } from './storage.ts';
import { addUnread } from '../unread.ts';

export interface RunContext {
  sessionId: string;
  abortController: AbortController;
}

function emitAbortMessage(sessionId: string, onEvent: (ev: object) => void): void {
  appendMessage(sessionId, {
    id: crypto.randomUUID(),
    role: 'assistant',
    blocks: [{ type: 'text', text: '⛔ Run aborted by user.' }],
  });
  onEvent({ type: 'session_messages_changed', sessionId });
}

/**
 * Execute one fire of a schedule. Creates a real session, streams the agent,
 * persists conversation blocks to JSONL, returns a run summary.
 *
 * For bash tasks: synthesizes an agent prompt and auto-approves ONLY the exact
 * Bash invocation matching `task.command`. Other tools fall through to deny —
 * the model can't silently expand scope.
 */
export interface ResumeOptions {
  /** Existing scheduler session to resume in-place (no new session is created). */
  sessionId: string;
  /** Prompt to feed the agent to continue (e.g. "continue from where you left off"). */
  prompt: string;
}

/** The event that fired an `event`-trigger schedule. Injected into the run so the
 *  agent (prompt task) or the spawned process (job task) can see what happened. */
export interface EventContext {
  source: string;
  payload: unknown;
}

/** Render an event as a prompt block (prompt tasks). Payload is capped so a large
 *  webhook body can't blow the context window. */
/**
 * Resolve a schedule's `promptFile` independently of process.cwd().
 *
 * Reading it CWD-relative only worked when the server happened to be launched from the app root;
 * a deployment with a different WorkingDirectory made every relative promptFile throw ENOENT and
 * silently kill the run. Anchors, in order:
 *   1. dirname(DATA_DIR) — the app root. Values written by this app are app-root-relative and
 *      ALREADY include the data dir (e.g. "data/workspace/x.md"). Same convention as job cwd.
 *   2. DATA_DIR — the intuitive data-dir-relative form (e.g. "workspace/x.md").
 * Absolute paths pass through. If neither exists, return the app-root path so the ENOENT names it.
 */
export function resolvePromptFile(p: string): string {
  if (isAbsolute(p)) return p;
  const rootAnchored = resolve(dirname(DATA_DIR), p);
  if (existsSync(rootAnchored)) return rootAnchored;
  const dataAnchored = resolve(DATA_DIR, p);
  return existsSync(dataAnchored) ? dataAnchored : rootAnchored;
}

/**
 * Bounded retry for transient engine failures on a prompt run.
 *
 * A cold-open race in the engine (observed: `database is locked` from @cursor/sdk, and an
 * unreachable ANTHROPIC_BASE_URL) can kill a run in ~600ms having produced NOTHING — no first
 * token, no tool call, no side effect. One blip then costs the whole day's run. The race window is
 * milliseconds, so these delays are deliberately short: this is a blip retry, not an outage retry.
 * Each delay is jittered (×0.5–1.5) so concurrent schedules don't retry in lockstep.
 */
const RETRY_BACKOFF_MS = [500, 2_000];
const MAX_ATTEMPTS = RETRY_BACKOFF_MS.length + 1;

/** Resolves after `ms`, or immediately on abort — a cancelled run must not sit out its backoff
 *  holding the session lock and the running marker. */
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  if (signal?.aborted) return resolve();
  const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
  const timer = setTimeout(done, ms);
  signal?.addEventListener('abort', done, { once: true });
});

function formatEventBlock(e: EventContext): string {
  let body: string;
  try { body = JSON.stringify(e.payload, null, 2); } catch { body = String(e.payload); }
  if (body.length > 8000) body = `${body.slice(0, 8000)}\n…(truncated)`;
  return `An external event triggered this automation.\nSource: ${e.source}\nEvent data:\n\`\`\`json\n${body}\n\`\`\``;
}

export async function runSchedule(
  schedule: Schedule,
  onEvent: (ev: object) => void,
  registerRun: (sid: string, ac: AbortController) => void,
  override?: string,
  resume?: ResumeOptions,
  eventCtx?: EventContext,
): Promise<ScheduleRunSummary> {
  const now = Date.now();
  // Resume reuses the interrupted run's session (same convo) instead of spawning a new one.
  const sessionId = resume ? resume.sessionId : `sched-${schedule.id}-${now}`;
  const abortController = new AbortController();
  registerRun(sessionId, abortController);

  const title = `⏰ ${schedule.name}`;
  // On resume the session already exists in the store — don't recreate it.
  if (!resume) createScheduledSession(sessionId, schedule.id, title, schedule.createdBy, schedule.scope);
  acquireSessionLock(sessionId, 'scheduler', abortController);
  setRunStatus(sessionId, 'running', 'scheduler');
  onEvent({ type: 'session_busy', sessionId, busy: true });
  // Mark this period as running with the live pid so startup catch-up won't double-fire it.
  writeRunningMarker({ pid: process.pid, startedAt: now, scheduleId: schedule.id });

  const task = schedule.task;
  if (task.kind === 'job') {
    return await runJobSchedule(schedule, sessionId, abortController, onEvent, eventCtx).finally(() => {
      if (releaseSessionLock(sessionId, abortController)) {
        setRunStatus(sessionId, 'idle');
        onEvent({ type: 'session_busy', sessionId, busy: false });
      }
    });
  }

  let prompt: string;
  if (resume) {
    // The original task prompt is already in the conversation from the interrupted run.
    prompt = resume.prompt;
  } else if (task.kind === 'bash') {
    const cmd = override || task.command;
    prompt = `Run exactly this bash command and report the result concisely:\n\n\`\`\`bash\n${cmd}\n\`\`\``;
  } else {
    let base = task.promptFile ? readFileSync(resolvePromptFile(task.promptFile), 'utf-8').trim() : (task.prompt ?? '');
    if (override) base = `${base}\n\n---\nAdditional instructions for this run:\n${override}`;
    if (eventCtx) base = `${base}\n\n---\n${formatEventBlock(eventCtx)}`;
    prompt = base;
  }
  // task.model rides the same [model] prompt-directive channel users type by hand — parseDirectives
  // strips it and resolves aliases. Prepending (vs new plumbing) also persists the choice into the
  // saved prompt, so the session UI shows which model the schedule actually requested.
  if (!resume && task.model) prompt = `[${task.model}] ${prompt}`;

  // Save the synthesized user prompt to the conversation (skip on resume — task prompt already persisted).
  if (!resume) {
    appendMessage(sessionId, {
      id: crypto.randomUUID(),
      role: 'user',
      blocks: [{ type: 'text', text: prompt }],
      channel: 'scheduler',
    });
  }

  // Scoped permission handler for bash runs
  const allowedCmd = task.kind === 'bash' ? (override || task.command) : null;
  const onPermissionRequest: PermissionHandler | undefined = task.kind === 'bash'
    ? async (_id, tool, input) => {
        if (tool === 'Bash' && typeof (input as any).command === 'string' && (input as any).command === allowedCmd) {
          return { allow: true };
        }
        return { allow: false };
      }
    : async () => ({ allow: true }); // prompt tasks: fully trusted scheduled run

  const mcpServers = getMcpConfig(schedule.createdBy.uid);

  let assistantText = '';
  // Thinking is real, billed model output but lands in no block (we don't persist it), so it needs
  // its own flag to suppress retry — see the side-effect boundary below.
  let producedThinking = false;
  const assistantBlocks: ConvBlock[] = [];
  const collectPartialBlocks = () => [
    ...assistantBlocks,
    ...(assistantText ? [{ type: 'text' as const, text: assistantText }] : []),
  ];
  registerLivePartial(sessionId, collectPartialBlocks);
  const partialInterval = setInterval(() => {
    const blocks = collectPartialBlocks();
    if (blocks.length) writePartial(sessionId, blocks);
  }, 5_000);
  const flush = () => {
    clearInterval(partialInterval);
    unregisterLivePartial(sessionId);
    clearPartial(sessionId);
    if (assistantText) assistantBlocks.push({ type: 'text', text: assistantText });
    if (assistantBlocks.length === 0) return;
    appendMessage(sessionId, { id: crypto.randomUUID(), role: 'assistant', blocks: assistantBlocks });
  };

  let status: ScheduleRunSummary['status'] = 'ok';
  let error: string | undefined;

  onEvent({ type: 'schedule:run_started', scheduleId: schedule.id, sessionId, at: now });

  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      status = 'ok';
      error = undefined;
      try {
        for await (const ev of streamChat({
          prompt,
          sessionId,
          uid: schedule.createdBy.uid,
          userEmail: schedule.createdBy.email,
          userName: schedule.createdBy.email.split('@')[0],
          mcpServers,
          abortController,
          onPermissionRequest,
        })) {
          onEvent({ type: 'session_stream', sessionId, event: ev });
          if (ev.type === 'text_delta') {
            assistantText += ev.text;
          } else if (ev.type === 'tool_use') {
            if (assistantText) { assistantBlocks.push({ type: 'text', text: assistantText }); assistantText = ''; }
            assistantBlocks.push({ type: 'tool_use', tool: ev.tool, toolUseId: ev.toolUseId, input: ev.input });
          } else if (ev.type === 'thinking_delta') {
            producedThinking = true;
          } else if (ev.type === 'tool_result') {
            assistantBlocks.push({ type: 'tool_result', toolUseId: ev.toolUseId, output: ev.output });
          } else if (ev.type === 'done') {
            break;
          } else if (ev.type === 'error') {
            status = abortController.signal.aborted ? 'aborted' : 'error';
            error = ev.message;
            break;
          }
        }
      } catch (err: any) {
        if (abortController.signal.aborted) {
          status = 'aborted';
        } else {
          status = 'error';
          error = err?.message ?? String(err);
        }
      }

      if (status !== 'error') break;

      // The side-effect boundary. This is NOT an exact `ttft=-1` test — the engine emits events we
      // don't track (model_resolved, stats) — it is the weaker but sufficient guarantee we actually
      // need: if all three are empty, no side effect can have occurred, so re-running can't
      // double-apply one (a posted DM, a written file). That holds because `tool_use` is yielded at
      // content_block_start, BEFORE the tool executes — any tool that ran is always preceded by a
      // `tool_use` already in `assistantBlocks`. `assistantText`/`producedThinking` additionally
      // stop us re-billing a long model call that genuinely started producing before dying.
      // Deliberately NOT counted: `model_resolved` and `stats` fire at spawn/on a timer before any
      // generation — counting them would disable retry for the exact incident this exists for.
      // `tool_use_input`, `tool_result_image`, `permission_request` and `question_request` need no
      // separate flag: each is necessarily preceded by the `tool_use` that already set the boundary.
      const producedOutput = assistantBlocks.length > 0 || assistantText.length > 0 || producedThinking;
      if (producedOutput || abortController.signal.aborted || attempt >= MAX_ATTEMPTS) {
        // Nobody watches stderr on a scheduled run — record the failure in the transcript.
        if (assistantText) { assistantBlocks.push({ type: 'text', text: assistantText }); assistantText = ''; }
        assistantBlocks.push({ type: 'error', text: error ?? 'Unknown error' });
        console.error(`[scheduler] run error for ${schedule.id} (attempt ${attempt}/${MAX_ATTEMPTS}):`, error);
        break;
      }

      // Retries stay visible: a silent one would hide that the upstream engine is flaky.
      const delay = Math.round(RETRY_BACKOFF_MS[attempt - 1]! * (0.5 + Math.random()));
      console.warn(`[scheduler] attempt ${attempt}/${MAX_ATTEMPTS} for ${schedule.id} failed before any output, retrying in ${delay}ms:`, error);
      appendMessage(sessionId, {
        id: crypto.randomUUID(),
        role: 'assistant',
        blocks: [{ type: 'text', text: `⚠️ Attempt ${attempt}/${MAX_ATTEMPTS} failed before producing any output — retrying in ${delay}ms.\n\n\`${error}\`` }],
      });
      onEvent({ type: 'session_messages_changed', sessionId });
      await sleep(delay, abortController.signal);
      // Cancelling during the backoff is a user cancel, not a failure — don't spawn attempt N+1.
      if (abortController.signal.aborted) { status = 'aborted'; error = undefined; break; }
    }
  } finally {
    flush();
    // Run reached a terminal state in-process — drop the running marker (a crash leaves it
    // behind on purpose; catch-up's isProcessAlive guard then handles the dead pid).
    clearRunningMarker(schedule.id);
    if (status === 'aborted') emitAbortMessage(sessionId, onEvent);
    if (releaseSessionLock(sessionId, abortController)) {
      setRunStatus(sessionId, 'idle');
      onEvent({ type: 'session_busy', sessionId, busy: false });
    }
    updateScheduledSessionStatus(sessionId, status);
  }

  const preview = assistantText.slice(0, 120) || (status === 'ok' ? 'Schedule completed' : `Schedule ${status}`);
  addUnread(schedule.createdBy.uid, sessionId, preview, 'schedule', schedule.name);

  const summary: ScheduleRunSummary = { at: now, sessionId, status, error };
  onEvent({ type: 'schedule:run_finished', scheduleId: schedule.id, sessionId, summary });
  return summary;
}

async function runJobSchedule(
  schedule: Schedule,
  sessionId: string,
  abortController: AbortController,
  onEvent: (ev: object) => void,
  eventCtx?: EventContext,
): Promise<ScheduleRunSummary> {
  const now = Date.now();
  const task = schedule.task;
  if (task.kind !== 'job') throw new Error(`Expected job task for schedule ${schedule.id}`);
  const command = task.command;
  appendMessage(sessionId, {
    id: crypto.randomUUID(),
    role: 'user',
    blocks: [{ type: 'text', text: `Run: \`${task.command}\`` }],
  });
  onEvent({ type: 'schedule:run_started', scheduleId: schedule.id, sessionId, at: now });

  let output = '';
  const prefix = `\`$ ${command}\`\n\n\`\`\`\n`;
  const collectPartial = () => [{ type: 'text' as const, text: `⏳ Running…\n\n${prefix}${output}\`\`\`` }];
  registerLivePartial(sessionId, collectPartial);
  const partialInterval = setInterval(() => {
    if (output) {
      writePartial(sessionId, collectPartial());
      onEvent({ type: 'session_messages_changed', sessionId });
    }
  }, 2_000);

  let status: ScheduleRunSummary['status'] = 'ok';
  let error: string | undefined;
  // Event-fired jobs see the payload as SHRAGA_EVENT (JSON) — isolated to this spawn, never the
  // command string. Also written as the legacy UNCLAW_EVENT for jobs already reading that name.
  const extraEnv = eventCtx
    ? { SHRAGA_EVENT: JSON.stringify(eventCtx), UNCLAW_EVENT: JSON.stringify(eventCtx) }
    : undefined;
  try {
    await runCommandWithMarker(command, abortController, schedule.id, (chunk) => { output += chunk; }, extraEnv);
    appendMessage(sessionId, {
      id: crypto.randomUUID(),
      role: 'assistant',
      blocks: [{ type: 'text', text: `✅ Job completed successfully.\n\n${prefix}${output.trim() || '(no output)'}\n\`\`\`` }],
    });
  } catch (err: any) {
    status = abortController.signal.aborted ? 'aborted' : 'error';
    error = err?.message ?? String(err);
    appendMessage(sessionId, {
      id: crypto.randomUUID(),
      role: 'assistant',
      blocks: [{ type: 'text', text: `❌ Job failed.\n\n${prefix}${error}\n\`\`\`` }],
    });
    console.error(`[scheduler] job run error for ${schedule.id}:`, error);
  } finally {
    clearInterval(partialInterval);
    unregisterLivePartial(sessionId);
    clearPartial(sessionId);
    clearRunningMarker(schedule.id);
    if (status === 'aborted') emitAbortMessage(sessionId, onEvent);
    updateScheduledSessionStatus(sessionId, status);
    onEvent({ type: 'session_messages_changed', sessionId });
  }

  const jobPreview = status === 'ok' ? 'Job completed successfully' : `Job ${status}`;
  addUnread(schedule.createdBy.uid, sessionId, jobPreview, 'schedule', schedule.name);

  const summary: ScheduleRunSummary = { at: now, sessionId, status, error };
  onEvent({ type: 'schedule:run_finished', scheduleId: schedule.id, sessionId, summary });
  return summary;
}


function runCommandWithMarker(command: string, abortController: AbortController, scheduleId: string, onChunk?: (chunk: string) => void, extraEnv?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      // Anchor job cwd to the dir CONTAINING the data dir, not the server's launch dir. Builtin +
      // user job commands are cwd-relative (`bun run data/scripts/X.ts`), so they must resolve
      // against DATA_DIR regardless of where/how the server was started. `process.cwd()` only worked
      // by coincidence when the process was launched from dirname(DATA_DIR); a deploy that sets a
      // different WorkingDirectory (e.g. running the app against a data dir at a different mount, like /some/data-dir) then
      // silently broke every data/ path. dirname(DATA_DIR) makes it launch-dir-independent.
      cwd: dirname(DATA_DIR),
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (child.pid) {
      writeRunningMarker({ pid: child.pid, startedAt: Date.now(), scheduleId });
    }

    let output = '';
    const handleData = (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      onChunk?.(text);
    };
    child.stdout?.on('data', handleData);
    child.stderr?.on('data', handleData);

    abortController.signal.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });
    child.on('error', reject);
    child.on('close', (code) => {
      const trimmed = output.trim();
      if (code === 0) resolve(trimmed);
      else reject(new Error(trimmed || `Command failed with exit code ${code}`));
    });
  });
}
