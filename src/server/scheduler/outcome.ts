// A scheduled run's DECLARED outcome — the run saying what actually happened, instead of the
// scheduler inferring success from "the agent's turn returned".
//
// The bug this exists for: a prompt run whose real work failed (or never started) still records
// `ok`, because the only thing measured was that the turn came back. On 2026-08-28 the 15:30 social
// run's scout died, nothing was delivered, the run stored `ok`, and the (enabled) failure notifier
// stayed silent all day — it is event-driven on `status: 'error'` and was never given one.
//
// It gets worse with background jobs (server/background-jobs.ts): there, ending the turn early is
// the CORRECT behaviour — the work outlives it and the job store wakes the session when it exits.
// So "the turn returned" stops being even a weak proxy for the run's outcome.
//
// Shape: one JSON file per run session, written by the run itself (any tool that can write a file —
// no new tool surface, nothing to plumb through the engine), read by runner.ts when the turn ends.
//   { "status": "ok" }                                  → the run delivered
//   { "status": "error", "error": "…" }                 → it did not; this fires the notifier
//   { "status": "pending", "deadline": <epoch ms|ISO> }  → work is still in flight; the run stays
//                                                          open until a terminal declaration lands,
//                                                          and FAILS if the deadline passes first
// Absent file ⇒ unchanged legacy behaviour (turn returned = ok), so no existing schedule changes.
// Deliberately domain-free: it knows nothing about what the run was doing.
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { dataPath } from '../paths.ts';

/** Cap on how long a `pending` run may hold the window open, whatever deadline it asked for. */
export const MAX_PENDING_MS = 6 * 60 * 60_000;
/** Used when a `pending` declaration names no deadline. */
export const DEFAULT_PENDING_MS = 60 * 60_000;

export interface DeclaredOutcome {
  status: 'ok' | 'error' | 'pending';
  error?: string;
  /** For `pending`: when the run gives up and is recorded as failed. Epoch ms or ISO-8601. */
  deadline?: number | string;
}

const dir = (): string => { const d = dataPath('scheduler', 'outcomes'); mkdirSync(d, { recursive: true }); return d; };
/** Session ids are server-minted (`sched-<id>-<ts>`), but this value reaches `path.join` and `rmSync`
 *  — so it is validated rather than trusted. A `../` in there would delete outside the outcomes dir. */
const safeId = (sessionId: string): string => {
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId) || sessionId.startsWith('.')) throw new Error(`unsafe session id for an outcome file: ${sessionId}`);
  return sessionId;
};
export const outcomeFile = (sessionId: string): string => path.join(dir(), `${safeId(sessionId)}.json`);

export function readOutcome(sessionId: string): DeclaredOutcome | null {
  let raw: string;
  try { raw = readFileSync(outcomeFile(sessionId), 'utf-8'); } catch { return null; }
  let o: DeclaredOutcome;
  // A malformed declaration is not "no declaration": the run tried to say something. Surfacing it
  // as an error beats silently falling back to the optimistic default this module exists to remove.
  // But a plain `Write` is not atomic, so a read can also land MID-write — that is a torn read, not
  // a malformed declaration, and failing a run for it would be the same class of lie in reverse.
  // Re-read once after a beat before believing it (the prompt also asks for write-temp-then-rename).
  try { o = JSON.parse(raw) as DeclaredOutcome; }
  catch {
    try { raw = readFileSync(outcomeFile(sessionId), 'utf-8'); o = JSON.parse(raw) as DeclaredOutcome; }
    catch { return { status: 'error', error: `run outcome file is not valid JSON: ${raw.slice(0, 200)}` }; }
  }
  if (o?.status !== 'ok' && o?.status !== 'error' && o?.status !== 'pending')
    return { status: 'error', error: `run outcome file has an invalid status: ${JSON.stringify(o?.status)}` };
  return o;
}

export function clearOutcome(sessionId: string): void {
  try { rmSync(outcomeFile(sessionId)); } catch { /* nothing to clear */ }
}

/** Test/host seam — writes a declaration the way a run's own file write would. */
export function writeOutcome(sessionId: string, o: DeclaredOutcome): void {
  writeFileSync(outcomeFile(sessionId), JSON.stringify(o));
}

/** Absolute epoch ms a `pending` run expires at, clamped to MAX_PENDING_MS. */
export function pendingDeadline(o: DeclaredOutcome, now: number): number {
  const raw = typeof o.deadline === 'string' ? Date.parse(o.deadline) : o.deadline;
  const asked = Number.isFinite(raw) ? (raw as number) : now + DEFAULT_PENDING_MS;
  return Math.min(Math.max(asked, now), now + MAX_PENDING_MS);
}

/** The contract, appended to a scheduled prompt run so a run can report itself truthfully. */
export function outcomePrompt(sessionId: string): string {
  return `# Reporting this run's outcome
This is a scheduled run. Unless you say otherwise, it is recorded as SUCCESSFUL the moment your turn returns — which is a lie whenever the work failed, was skipped, or is still in flight. Correct that by writing this file:
\`${outcomeFile(sessionId)}\`
- \`{"status":"ok"}\` — the run delivered what it was for.
- \`{"status":"error","error":"<what went wrong>"}\` — it did not. This is what raises the failure alert; write it for a leg that never ran, a worker that died, or work you could not finish.
- \`{"status":"pending","deadline":"<ISO-8601>"}\` — work you started outlives this turn (e.g. a background job). The run stays open and NOT successful until you write a terminal status from a later turn; if the deadline passes with no terminal status, the run is recorded as failed automatically.
Write it atomically — write a temp file next to it and \`mv\` it into place — so a reader can never catch it half-written.
Declare \`pending\` BEFORE you end a turn that leaves work running, and re-declare \`ok\`/\`error\` from the turn that sees it finish. Never declare \`ok\` for a run that did not deliver.`;
}
