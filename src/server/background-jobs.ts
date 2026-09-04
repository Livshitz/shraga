// Background shell jobs that OUTLIVE the turn that started them.
//
// The bug this exists for: an agent dispatches long work, promises "I'll report back", and the turn
// is then cut at the engine's wall clock. The work finishes fine — and nobody is left to say so.
// Any dispatch-and-poll pattern loses that race whenever the work outlasts the remaining budget, so
// polling is not the fix; something has to WAKE the session when the process exits.
//
// Shape:
//   • The registry is owned by the SERVER (module singleton), not by the turn. agentx builds a fresh
//     `Agent` per turn, so a registry created there would die with the turn — the very failure above.
//     Hosts hand each turn a thin per-session VIEW (`sessionJobRegistry`) over this one store; the
//     view is duck-compatible with agentx's `ShellJobRegistry`, so `Shell({background:true})` and the
//     ShellOutput/ShellStatus/ShellKill tools light up with no folklore `nohup`.
//   • On exit we report through wake.ts — the same "close then report" path polls.ts already uses in
//     production, so a job outcome lands wherever the session speaks (Slack thread / web UI).
//   • No double-report: reading a finished job's OUTPUT from inside a turn marks it `observed` — the
//     model had the result in hand and can speak for itself. Only that. `status`/`list` return no
//     output, so seeing "exited" there is not holding the result; marking those observed suppressed
//     the follow-up and lost the outcome entirely. We wake for every job whose output nobody read.
//     (Known narrow gap: a turn that reads the output and is then cut before it speaks gets no
//     follow-up. Much smaller window than the one being fixed.)
//   • No collision with a live turn: the report defers while `isSessionLocked` — with a cap, past
//     which it is delivered as plain text rather than never.
//
// Restart survival is PARTIAL and deliberately visible. Children are detached, so they keep running
// across a server restart and their output keeps landing in the job's log file; boot re-adopts them
// by pid and reports on exit as usual. What cannot survive is the exit CODE of a job that finished
// while we were down — nothing was waiting on the process. Those are reported with an explicit
// "exit code unknown (server restarted)" instead of a fabricated success.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, openSync, closeSync, readSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import path from 'node:path';
import { dataPath } from './paths.ts';
import { isSessionLocked, getSession } from './sessions.ts';
import { wakeSession, deliverToSession, wakeReady } from './wake.ts';

const PREFIX = '[jobs]';

// ── Bounds. Every one of these caps a blast radius the incident's `nohup` had none of. ──
/** Hard cap on a job's log, enforced by `head -c` inside the job's own pipeline (see buildShell).
 *  Polling a size and killing late cannot bound anything: at a 5s cadence an 8MB cap measured 830MB
 *  on disk. `head` closes the pipe at exactly this many bytes instead — the writer then dies of
 *  SIGPIPE, so the bound is the kernel's, not a timer's. */
const MAX_LOG_BYTES = 8 * 1024 * 1024;
/** How much of the tail we ever read back into memory (for a tool result or a report). */
const TAIL_BYTES = 16 * 1024;
/** How much of that tail goes into the wake prompt (the rest stays readable via ShellOutput). */
const REPORT_CHARS = 4_000;
const MAX_RUNNING_PER_SESSION = 4;
const MAX_RUNNING_GLOBAL = 16;
/** Grace before reporting: lets a still-live turn poll the just-finished job and own the telling. */
const GRACE_MS = 8_000;
/** Re-check cadence while the session is busy, or while an adopted (post-restart) job still runs. */
const POLL_MS = 5_000;
/** Give up deferring behind a busy session after this long and deliver the outcome as plain text. */
const MAX_DEFER_MS = 30 * 60_000;
/** Delete finished job records + logs after this long. */
const PRUNE_AFTER_MS = 24 * 60 * 60_000;

export type JobStatus = 'running' | 'exited' | 'killed' | 'error';

export interface JobOwner {
  sessionId: string;
  uid: string;
  userEmail?: string;
  /** Working directory for the job's shell (the deployment/project root). */
  cwd: string;
  /** Extra env merged over the server's own for the child. */
  env?: Record<string, string>;
}

interface JobRecord {
  id: string;
  sessionId: string;
  uid: string;
  userEmail?: string;
  command: string;
  cwd: string;
  pid?: number;
  startedAt: number;
  status: JobStatus;
  exitCode?: number;
  endedAt?: number;
  /** A turn read this job's terminal state — the model can report it itself, so we must not. */
  observed?: boolean;
  /** Terminal outcome of the follow-up delivery (absent = not attempted yet). */
  reported?: 'woke' | 'raw' | 'skipped-observed' | 'no-session' | 'failed';
  /** The exit code is unknown because the server restarted while this job ran. */
  orphaned?: boolean;
  /** The job hit MAX_LOG_BYTES: its output was cut off and the command was killed by SIGPIPE. */
  truncated?: boolean;
}

// ── Storage ────────────────────────────────────────────────────────────────────
const dir = (): string => { const d = dataPath('jobs'); mkdirSync(d, { recursive: true }); return d; };
const recFile = (id: string): string => path.join(dir(), `${id}.json`);
const logFile = (id: string): string => path.join(dir(), `${id}.log`);
/** The command's REAL exit status, written by the job's own shell (see buildShell). */
const statusFile = (id: string): string => path.join(dir(), `${id}.status`);

/** The command's exit code as its shell recorded it, or null if it never got that far. */
function readStatus(id: string): number | null {
  try {
    const n = Number(readFileSync(statusFile(id), 'utf-8').trim());
    return Number.isInteger(n) ? n : null;
  } catch { return null; }
}

/** Current size of a job's log, 0 if it does not exist yet. */
function logSize(id: string): number {
  try { return statSync(logFile(id)).size; } catch { return 0; }
}

/**
 * Wrap the user's command so the log is bounded and the real exit code survives.
 *
 * `{ ( cmd ); echo $? > status; } 2>&1 | head -c N`, and every piece of that shape is load-bearing:
 *   • `head -c N` — the actual disk bound. It closes the pipe at exactly N bytes; the writer then
 *     takes SIGPIPE. Chosen over `ulimit -f`, which is also kernel-enforced but caps EVERY file the
 *     job writes — that would kill an ordinary build the moment it emitted a >8MB artifact.
 *   • the inner `( … )` subshell — a command ending in `exit 3` (agents write those) would otherwise
 *     exit the group before the status line ever ran, and we'd lose the code. Verified.
 *   • the status file — the pipeline's own exit code is `head`'s (always 0), so without this every
 *     job would report success. The shell is not the process writing to the pipe, so it survives the
 *     SIGPIPE that kills the command and still records the code.
 * It also outlives us: the whole pipeline is in the job's detached process group, so a job adopted
 * after a server restart can be given its true exit code instead of "unknown".
 */
function buildShell(id: string, cmd: string): string {
  return `{\n(\n${cmd}\n)\n__st=$?\necho $__st > '${statusFile(id)}'\n} 2>&1 | head -c ${MAX_LOG_BYTES}`;
}

/** In-memory mirror of the on-disk records (disk is the restart-durable copy; this is the hot path). */
const records = new Map<string, JobRecord>();
/** Live timers per job, so nothing is left ticking after a job is reported or the record pruned. */
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function save(j: JobRecord): void {
  records.set(j.id, j);
  try { writeFileSync(recFile(j.id), JSON.stringify(j, null, 2)); }
  catch (e) { console.error(`${PREFIX} persist ${j.id} failed:`, (e as Error).message); }
}

function setTimer(id: string, ms: number, fn: () => void): void {
  clearTimer(id);
  timers.set(id, setTimeout(() => { timers.delete(id); fn(); }, ms));
}
function clearTimer(id: string): void {
  const t = timers.get(id);
  if (t) { clearTimeout(t); timers.delete(id); }
}

/** Last `TAIL_BYTES` of a job's log, decoded as utf-8. Never loads the whole file. */
function readTail(id: string): string {
  let fd: number | undefined;
  try {
    const size = statSync(logFile(id)).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const len = size - start;
    if (len <= 0) return '';
    const buf = Buffer.allocUnsafe(len);
    fd = openSync(logFile(id), 'r');
    readSync(fd, buf, 0, len, start);
    // A head-truncated read can split a multi-byte char — the replacement char is cosmetic, not corruption.
    return (start > 0 ? `…(truncated, showing last ${TAIL_BYTES >> 10}KB)\n` : '') + buf.toString('utf-8');
  } catch { return ''; }
  finally { if (fd !== undefined) try { closeSync(fd); } catch { /* already closed */ } }
}

const runningCount = (sessionId?: string): number =>
  [...records.values()].filter((j) => j.status === 'running' && (!sessionId || j.sessionId === sessionId)).length;

/**
 * Seconds this pid has been alive, or null if there is no such process.
 *
 * `etime` (formatted `[[DD-]HH:]MM:SS`), NOT `etimes` (raw seconds): etimes is a procps/Linux
 * extension and BSD ps — macOS, which is what the live box runs — rejects it outright, so the whole
 * adoption check silently degraded to "process gone" and every job that survived a restart was
 * reported as `exit code unknown`. etime is in POSIX and works on both.
 */
function pidAgeSeconds(pid: number): number | null {
  let out: string;
  try {
    // stderr piped: a missing pid is an expected outcome here, not something to print.
    out = execFileSync('ps', ['-o', 'etime=', '-p', String(pid)], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch { return null; /* no such process */ }
  const m = out.match(/^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  const [, d, h, mi, sec] = m;
  return Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(mi) * 60 + Number(sec);
}

/**
 * Env for a job's shell: the server's own, minus anything that looks like a credential.
 *
 * agentx's foreground `Bash` redacts these by default (RealShellOptions.redactEnv). Backgrounding a
 * command must not be a way around that — otherwise `Bash({background:true})` becomes a strictly
 * weaker sandbox than `Bash({})`, and `echo $ANTHROPIC_API_KEY` lands in a job log we then feed back
 * into the model. Mirrors agentx's SECRET_ENV_RE; a job that genuinely needs a credential gets it
 * explicitly via `JobOwner.env`.
 */
const SECRET_ENV_RE = /(API_KEY|_TOKEN|_SECRET|_PASSWORD|_PRIVATE_KEY|^AWS_|^GITHUB_TOKEN$|^OPENAI_|^ANTHROPIC_|^GOOGLE_|^GEMINI_|^GROQ_|^NPM_TOKEN$|^SLACK_)/i;
function childEnv(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) if (!SECRET_ENV_RE.test(k)) out[k] = v;
  return out;
}

// ── Lifecycle ──────────────────────────────────────────────────────────────────

/** Start `command` detached, in its own process group, with stdout+stderr appended to the job log.
 *  Detached (setsid) for two reasons: the group is killable as a subtree, and the child is NOT torn
 *  down with the server — which is what makes restart adoption possible at all. */
export async function startJob(owner: JobOwner, command: string): Promise<string> {
  const cmd = command.trim();
  if (!cmd) throw new Error('empty command');
  if (runningCount(owner.sessionId) >= MAX_RUNNING_PER_SESSION)
    throw new Error(`too many background jobs in this session (max ${MAX_RUNNING_PER_SESSION}) — wait for one to finish or ShellKill it`);
  if (runningCount() >= MAX_RUNNING_GLOBAL)
    throw new Error(`too many background jobs on this server (max ${MAX_RUNNING_GLOBAL})`);

  const id = `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const j: JobRecord = {
    id, sessionId: owner.sessionId, uid: owner.uid, userEmail: owner.userEmail,
    command: cmd, cwd: owner.cwd, startedAt: Date.now(), status: 'running',
  };
  let fd: number;
  try { fd = openSync(logFile(id), 'a'); }
  catch (e) { throw new Error(`cannot open job log: ${(e as Error).message}`); }
  try {
    // stdin is /dev/null so a child can never block on (or steal) input; stdout+stderr go straight
    // to the fd — nothing is buffered in this process, so a chatty job costs disk, not memory.
    const proc = spawn('/bin/sh', ['-c', buildShell(id, cmd)], {
      cwd: owner.cwd,
      env: {
        ...childEnv(),
        ...owner.env,
        // A long-running launcher can gate on these: only a REGISTERED job gets a completion wake,
        // so one started in the foreground orphans silently when its 60s tool call is killed.
        SHRAGA_JOB_ID: id,
        SHRAGA_BG_JOB: '1',
      },
      detached: true, stdio: ['ignore', fd, fd],
    });
    j.pid = proc.pid;
    proc.on('error', (err) => finish(id, 'error', undefined, `spawn error: ${err.message}`));
    // The pipeline's own code is `head`'s; the command's real one is in the status file.
    proc.on('close', (code) => finish(id, 'exited', readStatus(id) ?? code ?? undefined));
    proc.unref(); // never hold the event loop open for a background job
  } catch (e) {
    j.status = 'error';
    save(j);
    closeSync(fd);
    throw new Error(`failed to spawn: ${(e as Error).message}`);
  }
  closeSync(fd); // the child holds its own dup of the fd
  save(j);
  console.log(`${PREFIX} started ${id} pid=${j.pid} session=${j.sessionId.slice(0, 8)} cmd=${cmd.slice(0, 120)}`);
  return id;
}

/** Record a terminal state exactly once, then schedule the follow-up. */
function finish(id: string, status: JobStatus, exitCode?: number, note?: string): void {
  const j = records.get(id);
  if (!j || j.status !== 'running') return; // already terminal (e.g. killed, then close fires)
  j.status = status;
  j.exitCode = exitCode;
  j.endedAt = Date.now();
  if (logSize(id) >= MAX_LOG_BYTES) {
    // Say so IN the log: every path the model can read the result through goes via readTail, so the
    // notice reaches it whether it polls ShellOutput or gets the wake report.
    j.truncated = true;
    try { writeFileSync(logFile(id), `\n[output limit: ${MAX_LOG_BYTES >> 20}MB reached — output was cut off here and the command was terminated]\n`, { flag: 'a' }); }
    catch { /* nothing more we can do about the log */ }
    console.warn(`${PREFIX} ${id} hit the ${MAX_LOG_BYTES >> 20}MB log cap — output truncated`);
  }
  save(j);
  console.log(`${PREFIX} ${id} ${status}${exitCode != null ? ` exit=${exitCode}` : ''} in ${Math.round((j.endedAt - j.startedAt) / 1000)}s${note ? ` (${note})` : ''}`);
  // Grace: a turn that is still alive gets first refusal on telling the user (see `observed`).
  setTimer(id, GRACE_MS, () => { void report(id, Date.now()); });
}

export function killJob(id: string): boolean {
  const j = records.get(id);
  if (!j) return false;
  if (j.status === 'running') {
    // Group-kill: the child is its own group leader, so signalling `-pid` reaps the whole subtree —
    // `kill(pid)` alone would hit /bin/sh and orphan whatever it forked.
    if (j.pid) { try { process.kill(-j.pid, 'SIGTERM'); } catch { try { process.kill(j.pid, 'SIGTERM'); } catch { /* already gone */ } } }
    finish(id, 'killed');
  }
  return true;
}

/** A job the model explicitly killed inside a turn needs no follow-up — it already knows. */
function markObservedIfTerminal(j: JobRecord): void {
  if (j.status !== 'running' && !j.observed) { j.observed = true; save(j); }
}

// ── Follow-up delivery ─────────────────────────────────────────────────────────

function reportPrompt(j: JobRecord): string {
  const dur = Math.round(((j.endedAt ?? Date.now()) - j.startedAt) / 1000);
  const result = (j.orphaned
    ? 'ended while the server was restarting — exit code unknown'
    : j.status === 'killed' ? 'killed'
    : j.status === 'error' ? 'failed to run'
    : `exit ${j.exitCode ?? 0}`)
    + (j.truncated ? `, cut off at the ${MAX_LOG_BYTES >> 20}MB output limit` : '');
  const tail = readTail(j.id).slice(-REPORT_CHARS).trim();
  return [
    `[Background job finished] A command you started in an earlier turn has completed, after that turn ended.`,
    `Command: \`${j.command}\``,
    `Result: ${result} (after ${dur}s)`,
    ``,
    `Output (tail):`,
    tail || '(no output)',
    ``,
    `Report this outcome to the user now — that turn promised a follow-up and this is it.`,
    `Be brief and concrete. Do NOT re-run the command.`,
  ].join('\n');
}

/** Plain-text form, for when we cannot run a turn (no runner, or the session never went idle). */
function rawReport(j: JobRecord): string {
  const dur = Math.round(((j.endedAt ?? Date.now()) - j.startedAt) / 1000);
  const result = (j.orphaned ? 'exit code unknown (server restarted)' : j.status === 'exited' ? `exit ${j.exitCode ?? 0}` : j.status)
    + (j.truncated ? `, cut off at the ${MAX_LOG_BYTES >> 20}MB output limit` : '');
  const tail = readTail(j.id).slice(-REPORT_CHARS).trim();
  return `Background job finished — \`${j.command}\`\nResult: ${result} (after ${dur}s)\n\n\`\`\`\n${tail || '(no output)'}\n\`\`\``;
}

/**
 * Deliver a finished job's outcome, once.
 *
 * Order matters: `observed` is checked AFTER the grace window, so a turn that was still alive when
 * the job exited has had its chance to poll and own the telling. `firstAttemptAt` bounds how long
 * we defer behind a busy session.
 */
const report = (id: string, firstAttemptAt: number): Promise<void> =>
  tryReport(id, firstAttemptAt).catch((e) => console.error(`${PREFIX} ${id} report threw:`, (e as Error).message));

async function tryReport(id: string, firstAttemptAt: number): Promise<void> {
  const j = records.get(id);
  if (!j || j.reported) return;

  if (j.observed) {
    j.reported = 'skipped-observed';
    save(j);
    console.log(`${PREFIX} ${id} observed inside a turn — no follow-up needed`);
    return;
  }
  if (!getSession(j.sessionId)) {
    j.reported = 'no-session';
    save(j);
    console.warn(`${PREFIX} ${id} session ${j.sessionId} is gone — dropping follow-up`);
    return;
  }
  // Never start a turn on top of a live one — they would interleave into one transcript.
  if (isSessionLocked(j.sessionId)) {
    if (Date.now() - firstAttemptAt < MAX_DEFER_MS) {
      setTimer(id, POLL_MS, () => { void report(id, firstAttemptAt); });
      return;
    }
    console.warn(`${PREFIX} ${id} session busy for ${Math.round(MAX_DEFER_MS / 60_000)}min — delivering raw`);
    await deliverToSession({ sessionId: j.sessionId, uid: j.uid, text: rawReport(j), title: 'Background job' })
      .catch((e) => console.error(`${PREFIX} raw deliver failed:`, (e as Error).message));
    j.reported = 'raw';
    save(j);
    return;
  }
  try {
    if (!wakeReady()) {
      await deliverToSession({ sessionId: j.sessionId, uid: j.uid, text: rawReport(j), title: 'Background job' });
      j.reported = 'raw';
    } else {
      const outcome = await wakeSession({
        sessionId: j.sessionId, uid: j.uid, userEmail: j.userEmail,
        prompt: reportPrompt(j), channel: 'job', title: 'Background job',
      });
      if (outcome === 'woke') j.reported = 'woke';
      else {
        // The wake ran but said nothing (or the session vanished mid-flight). Falling back to raw
        // keeps the promise: the user sees the result rather than nothing at all.
        await deliverToSession({ sessionId: j.sessionId, uid: j.uid, text: rawReport(j), title: 'Background job' });
        j.reported = 'raw';
        console.warn(`${PREFIX} ${id} wake returned '${outcome}' — delivered raw instead`);
      }
    }
    console.log(`${PREFIX} ${id} follow-up delivered (${j.reported})`);
  } catch (e) {
    j.reported = 'failed';
    console.error(`${PREFIX} ${id} follow-up FAILED:`, (e as Error).message);
  }
  save(j);
}

// ── Boot: adopt what survived, prune what is stale ─────────────────────────────

/**
 * Load persisted records and reconcile them with reality.
 *
 * `running` records are jobs we lost the `close` listener for when the process ended. Their children
 * are detached, so many are genuinely still running — re-adopt those by polling the pid. The rest
 * finished while we were down: we know THAT they ended but not with what code, which is reported
 * honestly rather than guessed.
 */
export function initBackgroundJobs(): void {
  let files: string[] = [];
  try { files = readdirSync(dir()).filter((f) => f.endsWith('.json')); } catch { return; }
  let adopted = 0, orphaned = 0;
  for (const f of files) {
    let j: JobRecord;
    try { j = JSON.parse(readFileSync(path.join(dir(), f), 'utf-8')) as JobRecord; } catch { continue; }
    if (!j?.id) continue;
    records.set(j.id, j);

    if (j.status !== 'running') {
      // A terminal job whose follow-up never went out (we died between finish and report) still owes one.
      if (!j.reported) setTimer(j.id, GRACE_MS, () => { void report(j.id, Date.now()); });
      continue;
    }
    // pid liveness, guarded against pid REUSE. Our process started when the job did, so a pid that
    // is still ours is AT LEAST as old as the job. A recycled pid belongs to a process the OS started
    // later — i.e. YOUNGER than the job — which is exactly what this rejects. (Getting the comparison
    // backwards adopts the stranger: we would report its exit as the job's, and ShellKill would
    // `kill(-pid)` an unrelated process tree.) The 5s slack absorbs `etime`'s 1s granularity.
    const age = j.pid ? pidAgeSeconds(j.pid) : null;
    const jobAgeSec = (Date.now() - j.startedAt) / 1000;
    if (age != null && age >= jobAgeSec - 5) { adoptRunning(j.id); adopted++; }
    else {
      if (age != null) console.warn(`${PREFIX} ${j.id} pid ${j.pid} is ${Math.round(age)}s old but the job is ${Math.round(jobAgeSec)}s old — pid was reused, not adopting`);
      // Its own shell may still have recorded the real code before we went down.
      const st = readStatus(j.id);
      if (st != null) j.exitCode = st; else j.orphaned = true;
      j.status = 'exited';
      j.endedAt = Date.now();
      save(j);
      orphaned++;
      setTimer(j.id, GRACE_MS, () => { void report(j.id, Date.now()); });
    }
  }
  pruneOld();
  setInterval(pruneOld, 60 * 60_000).unref?.();
  if (adopted || orphaned) console.log(`${PREFIX} boot: adopted ${adopted} running job(s), ${orphaned} ended while down`);
}

/** Watch a job we no longer have a child handle for; report when its pid disappears. */
function adoptRunning(id: string): void {
  const j = records.get(id);
  if (!j || j.status !== 'running' || !j.pid) return;
  if (pidAgeSeconds(j.pid) == null) {
    // `wait` only works for your own child, so the pid vanishing tells us THAT it ended, not how.
    // Its own shell wrote the code down before exiting, though — prefer that over guessing.
    const st = readStatus(id);
    if (st == null) j.orphaned = true;
    finish(id, 'exited', st ?? undefined);
    return;
  }
  setTimer(id, POLL_MS, () => adoptRunning(id));
}

function pruneOld(): void {
  const now = Date.now();
  for (const j of [...records.values()]) {
    if (j.status === 'running' || !j.endedAt || now - j.endedAt < PRUNE_AFTER_MS) continue;
    clearTimer(j.id);
    records.delete(j.id);
    for (const p of [recFile(j.id), logFile(j.id), statusFile(j.id)]) try { rmSync(p); } catch { /* already gone */ }
  }
}

// ── The per-turn view handed to the agent engine ───────────────────────────────

/**
 * A session-scoped facade over the process-wide store, duck-compatible with agentx's
 * `ShellJobRegistry` — pass it as `makeRealShellTool({ registry })` and to `makeShellJobTools`.
 *
 * Cheap to build per turn (it holds no state); the jobs it starts belong to the server, so they
 * outlive the turn that made it. Every lookup is session-scoped: one session's agent can neither
 * read nor kill another's jobs.
 */
export function sessionJobRegistry(owner: JobOwner) {
  const mine = (id: string): JobRecord | undefined => {
    const j = records.get(id);
    return j && j.sessionId === owner.sessionId ? j : undefined;
  };
  return {
    start: (command: string) => startJob(owner, command),
    output(id: string): string | null {
      const j = mine(id);
      if (!j) return null;
      markObservedIfTerminal(j);
      return readTail(id);
    },
    // NB: status() and list() deliberately do NOT mark the job observed — they return no output, so
    // the model has not got the result and still needs the follow-up. Only output() may.
    status(id: string): { status: JobStatus; exitCode?: number; bytes: number } | null {
      const j = mine(id);
      if (!j) return null;
      return { status: j.status, exitCode: j.exitCode, bytes: logSize(id) };
    },
    list(): Array<{ id: string; command: string; status: JobStatus }> {
      return [...records.values()]
        .filter((j) => j.sessionId === owner.sessionId)
        .map((j) => ({ id: j.id, command: j.command, status: j.status }));
    },
    kill(id: string): boolean {
      const j = mine(id);
      if (!j) return false;
      const ok = killJob(id);
      markObservedIfTerminal(j); // the model asked for this end — it does not need telling about it
      return ok;
    },
  };
}

/** Test/introspection seam: the current record for a job (undefined once pruned). */
export function getJob(id: string): Readonly<JobRecord> | undefined { return records.get(id); }
