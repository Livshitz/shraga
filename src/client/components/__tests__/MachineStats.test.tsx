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
    expect(renderToStaticMarkup(<UsageMetric usage={null} />)).toBe('');
  });

  it('renders nothing when the response carries no limits', () => {
    expect(renderToStaticMarkup(<UsageMetric usage={{ subscriptionType: 'max', limits: [] }} />)).toBe('');
  });

  it('renders the readout for a real subscription payload', () => {
    const html = renderToStaticMarkup(<UsageMetric usage={REAL} />);
    expect(html).toContain('usage');
    expect(html).toContain('5%');
  });
});

describe('binding limit', () => {
  it('picks the fullest window, whichever kind it is', () => {
    expect(binding(REAL.limits)?.kind).toBe('session');
    // isActive must move with it: a dormant window is not the binding one (see the suite below).
    const weeklyHot = REAL.limits.map(l => (l.kind === 'weekly_all' ? { ...l, percent: 80, isActive: true } : l));
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

describe('binding limit ignores windows that are not in effect', () => {
  // is_active marks the window that is actually accruing. A dormant window at 42% is not what
  // gates you, and the tooltip calls the headline "the binding limit".
  const DORMANT_HOT: Usage = {
    subscriptionType: 'max',
    limits: [
      { kind: 'session', group: 'session', percent: 7, severity: 'normal', resetsAt: null, isActive: true },
      { kind: 'weekly_all', group: 'weekly', percent: 42, severity: 'normal', resetsAt: null, isActive: false },
    ],
  };

  it('never headlines an inactive window over an active one', () => {
    expect(binding(DORMANT_HOT.limits)?.kind).toBe('session');
    expect(renderToStaticMarkup(<UsageMetric usage={DORMANT_HOT} />)).toContain('7%');
  });

  it('degrades to the fullest window when NOTHING is active (unknown vendor state, still render)', () => {
    const allDormant = DORMANT_HOT.limits.map(l => ({ ...l, isActive: false }));
    expect(binding(allDormant)?.kind).toBe('weekly_all');
  });

  it('is null for an empty list', () => {
    expect(binding([])).toBeNull();
  });
});

describe('the usage gauge is complete on the FIRST paint', () => {
  // It used to render a bare percent with no gauge for the first 60-120s of every page load,
  // because the sparkline needed two poll samples it did not have yet.
  it('draws a gauge with no history at all', () => {
    const html = renderToStaticMarkup(<UsageMetric usage={REAL} />);
    expect(html).toContain('<svg');
    expect(html).toContain('5%');
  });
});

describe('severity colouring survives an unknown vocabulary', () => {
  const at = (percent: number, severity: string): Usage => ({
    subscriptionType: 'max',
    limits: [{ kind: 'session', group: 'session', percent, severity, resetsAt: null, isActive: true }],
  });

  it('paints red for a known critical severity', () => {
    expect(renderToStaticMarkup(<UsageMetric usage={at(10, 'critical')} />)).toContain('text-red-500');
  });

  it('paints amber for a known warning severity', () => {
    expect(renderToStaticMarkup(<UsageMetric usage={at(10, 'warning')} />)).toContain('text-amber-500');
  });

  it('an UNKNOWN severity falls back to the percentage, not a permanent amber', () => {
    const html = renderToStaticMarkup(<UsageMetric usage={at(10, 'allow_with_warning_v2')} />);
    expect(html).not.toContain('text-amber-500');
    expect(html).toContain('text-emerald-500');
  });
});
