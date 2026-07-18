import { CronExpressionParser } from 'cron-parser';
import type { Trigger } from './types.ts';

/**
 * Returns the next fire time strictly after `from` (epoch ms), or null if
 * the trigger has no more fires (e.g. a `once` trigger in the past).
 */
export function computeNextRun(trigger: Trigger, from: number = Date.now()): number | null {
  // Event triggers never fire on a timer — they wait for the event bus. No next run.
  if (trigger.kind === 'event') return null;

  if (trigger.kind === 'once') {
    return trigger.at > from ? trigger.at : null;
  }

  if (trigger.kind === 'interval') {
    if (!Number.isFinite(trigger.everyMs) || trigger.everyMs < 1000) return null;
    return from + trigger.everyMs;
  }

  if (trigger.kind === 'cron') {
    try {
      const it = CronExpressionParser.parse(trigger.expr, {
        currentDate: new Date(from),
        tz: trigger.tz,
      });
      return it.next().getTime();
    } catch (err) {
      console.error(`[scheduler] invalid cron "${trigger.expr}":`, err);
      return null;
    }
  }

  return null;
}

export function computePrevRun(trigger: Trigger, from: number = Date.now()): number | null {
  if (trigger.kind !== 'cron') return null;
  try {
    const it = CronExpressionParser.parse(trigger.expr, {
      currentDate: new Date(from),
      tz: trigger.tz,
    });
    return it.prev().getTime();
  } catch (err) {
    console.error(`[scheduler] invalid cron "${trigger.expr}":`, err);
    return null;
  }
}

/** Validate a trigger; returns a human-readable error or null. */
export function validateTrigger(trigger: Trigger): string | null {
  if (trigger.kind === 'event' && !trigger.source?.trim()) {
    return 'Event trigger must have a source';
  }
  if (trigger.kind === 'once' && trigger.at <= Date.now()) {
    return 'Once trigger must be in the future';
  }
  if (trigger.kind === 'cron') {
    try {
      CronExpressionParser.parse(trigger.expr, { tz: trigger.tz });
    } catch (err: any) {
      return `Invalid cron expression: ${err?.message ?? String(err)}`;
    }
  }
  if (trigger.kind === 'interval' && trigger.everyMs < 1000) {
    return 'Interval must be at least 1000ms';
  }
  return null;
}
