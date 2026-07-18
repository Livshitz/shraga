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
 *  (recipients, runbooks, base URL, severity rules) — their edits survive reconcile. */
const FAILURE_NOTIFIER_PROMPT = [
  'A scheduled job just FAILED. The failure event payload is included in this message',
  '(fields: name, scheduleId, status, error, sessionId). Duplicate alerts for the same',
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
  '  *Session:* <deployment URL>/?session=<sessionId>',
  'Do NOT try to fix the job yourself.',
].join('\n');

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
