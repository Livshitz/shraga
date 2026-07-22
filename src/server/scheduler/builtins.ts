import { fileURLToPath } from 'node:url';
import type { Schedule } from './types.ts';

// The conversation summarizer is one of Shraga's own scripts. Reference it by an ABSOLUTE path
// resolved from this module, so `bun run <it>` works from any cwd and whether Shraga runs from
// source (src/) or is consumed as an npm package (node_modules/shraga/src/). A bare
// `bun run summarize:conversations` only works when the app-root package.json is Shraga's own,
// which it is NOT for an npm-consumer app.
const SUMMARIZER_CMD = `bun run ${fileURLToPath(new URL('../../scripts/summarize-conversations.ts', import.meta.url))}`;

export const SYSTEM_UID = '__system__';
export const NIGHTLY_RECONCILE_SCHEDULE_ID = 'builtin-nightly-reconcile';
export const DAILY_GARDEN_SCHEDULE_ID = 'builtin-daily-garden';
export const HOURLY_SUMMARIZER_SCHEDULE_ID = 'builtin-conversation-summarizer';
export const FAILURE_NOTIFIER_SCHEDULE_ID = 'builtin-failure-notifier';

/** Generic triage prompt for the failure notifier. Deployments override the prompt
 *  (recipients, runbooks, severity rules) — their edits survive reconcile. The session link
 *  is NOT part of that: it comes from the event payload (see getSessionUrl), precisely so it
 *  reaches deployments whose stored prompt reconcile will never touch. */
const FAILURE_NOTIFIER_PROMPT = [
  'A scheduled job just FAILED. The failure event payload is included in this message',
  '(fields: name, scheduleId, status, error, sessionId, sessionUrl). Duplicate alerts for the same',
  'job+error are already suppressed by this trigger\'s throttle, so just handle this one.',
  '',
  'TRIAGE — classify the error:',
  '  - Credential/auth expiry ("token expired", invalid_grant, 401/403, OAuthException): fix = regenerate/refresh the credential.',
  '  - Rate limit (429, "rate limit", "request limit reached"): likely transient/self-healing.',
  '  - Data issue (empty/missing results, 0 rows): check the upstream source.',
  '  - Otherwise: generic failure; surface the raw error.',
  'Severity is HIGH for revenue/reporting-critical jobs, otherwise NORMAL.',
  '',
  'NOTIFY — send exactly ONE concise alert to the deployment owner, then stop. Prefer a Slack DM',
  'if a Slack tool is configured (resolve the owner from $SHRAGA_ALERT_SLACK_EMAIL (or legacy $UNCLAW_ALERT_SLACK_EMAIL), else the first',
  'entry in data/whitelist.json); otherwise email them. Suggested format:',
  '  :rotating_light: *<category>*<add " [HIGH]" if high severity> — scheduled job failed: *<name>*',
  '  *What:* <one plain-language line>',
  '  *Fix:* <actionable next step from triage>',
  '  *Error:* <error, truncated to ~400 chars, in backticks>',
  '  *Session:* <the payload\'s sessionUrl, verbatim>',
  'The payload carries a ready-made absolute sessionUrl. Use it EXACTLY as given — never build a',
  'link yourself. If sessionUrl is absent the deployment has no public origin configured: OMIT the',
  'Session line entirely. Do NOT substitute localhost, $PORT or any host you infer from the box —',
  'the alert is read off-box and such a link is always dead.',
  'Do NOT try to fix the job yourself.',
].join('\n');

/** The pre-sessionUrl Session line: it asked the model to improvise "<deployment URL>", which
 *  nothing ever supplied, so it fell back to the only host it could see ($PORT → localhost).
 *  Reconcile deliberately preserves a builtin's stored `task.prompt` so deployment edits survive
 *  upgrades — which also means a stored prompt keeps this broken line forever. Heal just the line
 *  (not the whole prompt), so a deployment's other customisations are untouched.
 *  Only the placeholder itself and the label before it are replaced: anything the deployment
 *  appended after the placeholder is a hand-written annotation, so it is carried over verbatim,
 *  and every occurrence is healed (a stored prompt may mention the link more than once). */
const LEGACY_SESSION_LINE = /^.*<deployment URL>\/\?session=<sessionId>(.*)$/gm;
const SESSION_LINE_FIX = "  *Session:* <the payload's sessionUrl, verbatim — omit this line if absent>";

export function isSystemSchedule(schedule: Schedule): boolean {
  return schedule.scope === 'system';
}

/** Backfill `scope` and migrate legacy task.kind names on schedules persisted before the rename. */
export function backfillScope(schedules: Schedule[]): void {
  for (const s of schedules) {
    if (!s.scope) {
      s.scope = s.createdBy?.uid === SYSTEM_UID ? 'system' : 'user';
    }
    const kind = (s.task as { kind: string } | undefined)?.kind;
    if (kind === 'agent') (s.task as { kind: string }).kind = 'prompt';
    else if (kind === 'builtin') (s.task as { kind: string }).kind = 'job';

    // Migrate legacy jobId-based tasks to command-based
    const task = s.task as any;
    if (task.kind === 'job' && task.jobId && !task.command) {
      const legacyMap: Record<string, string> = {
        'daily-facebook-ads-spend': 'bun run data/scripts/daily-fb-ads-spend.ts',
        'daily-payback-sheet': 'bun run data/scripts/daily-payback-sheet.ts --slack',
        'conversation-summarizer': SUMMARIZER_CMD,
      };
      task.command = legacyMap[task.jobId] ?? task.jobId;
      delete task.jobId;
    }
    // Heal a persisted summarizer command that still uses the app-root package-script form
    // (breaks for npm-consumer apps) → the resolved absolute path.
    if (task.kind === 'job' && task.command === 'bun run summarize:conversations') {
      task.command = SUMMARIZER_CMD;
    }
    // Heal a persisted failure-notifier prompt still carrying the un-supplied "<deployment URL>"
    // placeholder — reconcile won't touch task.prompt, so this is the only path that reaches it.
    if (s.id === FAILURE_NOTIFIER_SCHEDULE_ID && typeof task.prompt === 'string') {
      // `$1` keeps whatever the deployment wrote after the placeholder. No .test() guard:
      // LEGACY_SESSION_LINE is global, and a global regex's .test() carries lastIndex between calls.
      task.prompt = task.prompt.replace(LEGACY_SESSION_LINE, `${SESSION_LINE_FIX}$1`);
    }
  }
}

export function ensureBuiltinSchedules(schedules: Schedule[]): Schedule[] {
  const now = Date.now();
  const builtins: Schedule[] = [
    defaultAgentSchedule({
      id: DAILY_GARDEN_SCHEDULE_ID,
      name: 'Daily Knowledge Garden',
      expr: '0 13 * * *',
      prompt: '/garden',
      now,
    }),
    defaultAgentSchedule({
      id: NIGHTLY_RECONCILE_SCHEDULE_ID,
      name: 'Nightly Knowledge Reconciliation',
      expr: '0 3 * * *',
      prompt: '/reconcile',
      now,
    }),
    {
      id: HOURLY_SUMMARIZER_SCHEDULE_ID,
      name: 'Conversation Summarizer',
      enabled: false,
      trigger: { kind: 'cron', expr: '0 * * * *', tz: 'UTC' },
      task: { kind: 'job', command: SUMMARIZER_CMD },
      scope: 'system',
      createdBy: { uid: SYSTEM_UID, email: 'system@shraga.local' },
      createdAt: now,
      updatedAt: now,
      runCount: 0,
    },
    {
      id: FAILURE_NOTIFIER_SCHEDULE_ID,
      name: 'Scheduled-job failure notifier',
      enabled: false,
      // Fires on any failed schedule run; throttle dedups same job+error within 6h
      // BEFORE spawning a run. (schedule.finished is suppressed for event-triggered
      // runs, so the notifier can't trigger itself.)
      trigger: {
        kind: 'event',
        source: 'schedule.finished',
        match: { status: 'error' },
        throttle: { byFields: ['name', 'error'], windowSec: 21600 },
      },
      task: { kind: 'prompt', prompt: FAILURE_NOTIFIER_PROMPT },
      scope: 'system',
      createdBy: { uid: SYSTEM_UID, email: 'system@shraga.local' },
      createdAt: now,
      updatedAt: now,
      runCount: 0,
    },
  ];

  const builtinIds = new Set(builtins.map((b) => b.id));

  // Remove system schedules no longer in the builtins list (renamed/retired)
  for (let i = schedules.length - 1; i >= 0; i--) {
    if (schedules[i].scope === 'system' && schedules[i].createdBy?.uid === SYSTEM_UID && !builtinIds.has(schedules[i].id)) {
      schedules.splice(i, 1);
    }
  }

  for (const builtin of builtins) {
    const existing = schedules.find((s) => s.id === builtin.id);
    if (existing) {
      existing.name = builtin.name;
      existing.scope = builtin.scope;
      existing.trigger = existing.trigger ?? builtin.trigger;
      existing.createdBy = builtin.createdBy;
    } else {
      schedules.push(builtin);
    }
  }

  return schedules;
}

function defaultAgentSchedule(options: {
  id: string;
  name: string;
  expr: string;
  prompt: string;
  now: number;
  scope?: 'system' | 'user';
}): Schedule {
  return {
    id: options.id,
    name: options.name,
    enabled: false,
    trigger: { kind: 'cron', expr: options.expr, tz: 'UTC' },
    task: { kind: 'prompt', prompt: options.prompt },
    scope: options.scope || 'system',
    createdBy: { uid: SYSTEM_UID, email: 'system@shraga.local' },
    createdAt: options.now,
    updatedAt: options.now,
    runCount: 0,
  };
}
