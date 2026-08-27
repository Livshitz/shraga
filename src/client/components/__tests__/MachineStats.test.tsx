import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { UsageMetric, binding, untilLabel, type Usage } from '../MachineStats';

// Captured verbatim from a live 200 on the prod box (api.anthropic.com/api/oauth/usage).
const REAL: Usage = {
  subscriptionType: 'max',
  limits: [
    { kind: 'session', group: 'session', percent: 5, severity: 'normal', resetsAt: '2026-08-27T20:50:00.087873+00:00', isActive: true },
    { kind: 'weekly_all', group: 'weekly', percent: 0, severity: 'normal', resetsAt: '2026-09-01T21:00:00.087899+00:00', isActive: false },
    { kind: 'weekly_scoped', group: 'weekly', percent: 0, severity: 'normal', resetsAt: null, isActive: false, scopeLabel: 'Fable' },
  ],
};

describe('UsageMetric gate', () => {
  it('renders nothing when there is no subscription (the 204 / fail-closed branch)', () => {
    expect(renderToStaticMarkup(<UsageMetric usage={null} series={[]} />)).toBe('');
  });

  it('renders nothing when the response carries no limits', () => {
    expect(renderToStaticMarkup(<UsageMetric usage={{ subscriptionType: 'max', limits: [] }} series={[]} />)).toBe('');
  });

  it('renders the readout for a real subscription payload', () => {
    const html = renderToStaticMarkup(<UsageMetric usage={REAL} series={[3, 5]} />);
    expect(html).toContain('usage');
    expect(html).toContain('5%');
  });
});

describe('binding limit', () => {
  it('picks the fullest window, whichever kind it is', () => {
    expect(binding(REAL.limits)?.kind).toBe('session');
    const weeklyHot = REAL.limits.map(l => (l.kind === 'weekly_all' ? { ...l, percent: 80 } : l));
    expect(binding(weeklyHot)?.kind).toBe('weekly_all');
  });
});

describe('untilLabel', () => {
  // The weekly_* windows do NOT reset weekly — the label must come from resets_at, never the kind.
  it('derives the window from resets_at only', () => {
    const now = Date.now();
    expect(untilLabel(new Date(now + 30 * 60_000).toISOString())).toBe('30m');
    expect(untilLabel(new Date(now + 4 * 3_600_000).toISOString())).toBe('4h');
    expect(untilLabel(new Date(now + 72 * 3_600_000).toISOString())).toBe('3d');
  });

  it('is null for a missing or already-past reset', () => {
    expect(untilLabel(null)).toBeNull();
    expect(untilLabel('not-a-date')).toBeNull();
    expect(untilLabel(new Date(Date.now() - 60_000).toISOString())).toBeNull();
  });
});
