import { describe, expect, it } from 'bun:test';
import { annotateLimitReset, untilLabel } from '../limit-reset';

const anchor = Date.parse('2026-09-07T10:47:00Z');

describe('annotateLimitReset', () => {
  it('rewrites a UTC reset into local time plus a countdown', () => {
    const out = annotateLimitReset("You've hit your limit · resets 1pm (UTC)", anchor, anchor);
    expect(out).not.toContain('(UTC)');
    expect(out).toContain('in 2h 13m');
  });

  it('rolls to the next day when the stamp is already past at the message time', () => {
    const out = annotateLimitReset('resets 9am (UTC)', anchor, anchor);
    expect(out).toContain('in 22h 13m');
  });

  // A week-old failure must not claim a live countdown, nor roll its reset forward to today.
  it('drops the countdown once the reset is in the past', () => {
    const out = annotateLimitReset('resets 1pm (UTC)', anchor, anchor + 7 * 86_400_000);
    expect(out).not.toContain('in ');
  });

  it('leaves unrelated errors untouched', () => {
    expect(annotateLimitReset('Claude API error: boom')).toBe('Claude API error: boom');
    expect(annotateLimitReset('resets 99pm (UTC)')).toBe('resets 99pm (UTC)');
  });

  it('handles minutes and a 12am/12pm stamp', () => {
    expect(annotateLimitReset('resets 1:30pm (UTC)', anchor, anchor)).toContain('in 2h 43m');
    expect(annotateLimitReset('resets 12am (UTC)', anchor, anchor)).toContain('in 13h 13m');
  });
});

describe('untilLabel', () => {
  it('is null for a past or absent timestamp', () => {
    expect(untilLabel(null)).toBeNull();
    expect(untilLabel(new Date(Date.now() - 60_000).toISOString())).toBeNull();
  });
});
