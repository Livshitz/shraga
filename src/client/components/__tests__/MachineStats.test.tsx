import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { UsageMetric, binding, untilLabel, type Usage } from '../MachineStats';

// Captured verbatim from a live 200 on the prod box (api.anthropic.com/api/oauth/usage).
const REAL: Usage = {
  subscriptionType: 'max',
  limits: [
    { kind: 'session', group: 'session', percent: 5, severity: 'normal', resetsAt: '2026-08-27T20:50:00.087873+00:00' },
    { kind: 'weekly_all', group: 'weekly', percent: 0, severity: 'normal', resetsAt: '2026-09-01T21:00:00.087899+00:00' },
    { kind: 'weekly_scoped', group: 'weekly', percent: 0, severity: 'normal', resetsAt: null, scopeLabel: 'Fable' },
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

describe('the headline is the window closest to exhausting', () => {
  // Observed on prod: the vendor reports `is_active: false` on a window that is genuinely accruing,
  // so it means "currently binding", not "running". Filtering on it painted a reassuring green 6%
  // while 85% of the weekly window was gone, and called that live window "dormant".
  const WEEKLY_HOT: Usage = {
    subscriptionType: 'max',
    limits: [
      { kind: 'session', group: 'session', percent: 6, severity: 'normal', resetsAt: null },
      { kind: 'weekly_all', group: 'weekly', percent: 85, severity: 'normal', resetsAt: null },
    ],
  };

  it('headlines the fullest window even when the vendor calls it non-binding', () => {
    expect(binding(WEEKLY_HOT.limits)?.kind).toBe('weekly_all');
    const html = renderToStaticMarkup(<UsageMetric usage={WEEKLY_HOT} />);
    expect(html).toContain('>85%<');
    expect(html).not.toContain('6% of the binding limit');
    expect(html).toContain('text-amber-500'); // 85% must not paint reassuringly green
    expect(html).not.toContain('text-emerald-500');
  });

  it('never annotates a window as dormant', () => {
    expect(renderToStaticMarkup(<UsageMetric usage={WEEKLY_HOT} />)).not.toContain('dormant');
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
    limits: [{ kind: 'session', group: 'session', percent, severity, resetsAt: null }],
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
