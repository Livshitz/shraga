import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { CLOSED, UsageCard, ageLabel, UsageMetric, binding, nextCardState, untilLabel, windowLabel, type CardEvent, type Usage } from '../MachineStats';

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


describe('the hover breakdown card', () => {
  const html = () => renderToStaticMarkup(<UsageCard usage={REAL} />);

  it('lists every reported window, not just the headline one', () => {
    const h = html();
    expect(h).toContain('current session');
    expect(h).toContain('all models');
    expect(h).toContain('Fable window'); // scopeLabel names WHICH model the scoped window covers
  });

  it('never prints the weekly_* kinds as "weekly" or "7 days" — that window rolls on ~72h', () => {
    const h = html().toLowerCase();
    expect(h).not.toContain('weekly');
    expect(h).not.toContain('7 days');
    expect(h).not.toContain('week');
  });

  it('shows the plan', () => {
    expect(html()).toContain('max');
  });

  it('shows a per-window countdown derived from resetsAt', () => {
    const soon = new Date(Date.now() + (76 * 60 + 12) * 60_000).toISOString();
    const h = renderToStaticMarkup(
      <UsageCard usage={{ subscriptionType: 'max', limits: [{ kind: 'session', group: 'session', percent: 6, severity: 'normal', resetsAt: soon }] }} />
    );
    expect(h).toContain('resets in 3d 4h');
  });

  it('shows NO countdown for a window with resetsAt: null', () => {
    const h = renderToStaticMarkup(
      <UsageCard usage={{ subscriptionType: 'max', limits: [{ kind: 'weekly_scoped', group: 'weekly', percent: 0, severity: 'normal', resetsAt: null, scopeLabel: 'Fable' }] }} />
    );
    expect(h).toContain('no reset reported');
    expect(h).not.toContain('resets in');
  });

  it('marks which row the headline gauge is showing', () => {
    // The marker must sit on the FULLEST window, not simply the first row.
    const hot: Usage = { ...REAL, limits: REAL.limits.map(l => (l.kind === 'weekly_all' ? { ...l, percent: 85 } : l)) };
    const rows = renderToStaticMarkup(<UsageCard usage={hot} />).split('data-headline="true"');
    expect(rows.length).toBe(2);             // exactly one row is marked
    expect(rows[1]).toContain('▸');          // it carries the visible marker
    expect(rows[1].slice(0, 400)).toContain('all models'); // and it is the 85% window, not the first row
  });

  it('colours a hot window without recolouring the calm ones', () => {
    const hot: Usage = { ...REAL, limits: REAL.limits.map(l => (l.kind === 'weekly_all' ? { ...l, percent: 85 } : l)) };
    const h = renderToStaticMarkup(<UsageCard usage={hot} />);
    expect(h).toContain('text-amber-500');
    expect(h).toContain('text-emerald-500');
  });
});

describe('windowLabel', () => {
  it('prefers the scope label so a scoped window says WHICH model it covers', () => {
    expect(windowLabel({ kind: 'weekly_scoped', group: 'weekly', percent: 0, severity: 'normal', resetsAt: null, scopeLabel: 'Fable' })).toBe('Fable window');
  });
  it('falls back to a de-underscored kind for a vocabulary we have not seen', () => {
    expect(windowLabel({ kind: 'five_hour_burst', group: 'x', percent: 0, severity: 'normal', resetsAt: null })).toBe('five hour burst');
  });
});

describe('untilLabel compound precision', () => {
  const inMin = (m: number) => untilLabel(new Date(Date.now() + m * 60_000).toISOString());
  it('reads hours AND minutes under two days', () => expect(inMin(72)).toBe('1h 12m'));
  it('reads days AND hours beyond two days', () => expect(inMin(4 * 24 * 60 + 2 * 60)).toBe('4d 2h'));
  it('drops a zero remainder', () => { expect(inMin(120)).toBe('2h'); expect(inMin(3 * 24 * 60)).toBe('3d'); });
});

describe('the native title is gone from the usage metric', () => {
  it('does not duplicate the card as a browser tooltip', () => {
    expect(renderToStaticMarkup(<UsageMetric usage={REAL} />)).not.toContain('title=');
  });
});

describe('the breakdown is reachable by TAP, not only by hover', () => {
  // The shipped bug: Radix HoverCard is pointer-only, so on a phone the card could not be opened at
  // all. The trigger must therefore be an activatable, focusable control.
  const trigger = () => renderToStaticMarkup(<UsageMetric usage={REAL} />);

  it('renders a real button, not an inert span', () => {
    const h = trigger();
    expect(h).toContain('<button');
    expect(h).toContain('type="button"');
  });

  it('is keyboard-reachable and not tab-trapped out', () => {
    expect(trigger()).not.toContain('tabindex="-1"');
  });

  it('names itself for a screen reader', () => {
    expect(trigger()).toContain('aria-label="claude usage breakdown"');
  });
});

describe('nextCardState — who may open and close the card', () => {
  const hover = (t: string) => ({ type: 'pointerenter', pointerType: t }) as CardEvent;
  const leave = (t: string) => ({ type: 'pointerleave', pointerType: t }) as CardEvent;

  it('a TAP opens the card (the whole point of the fix)', () => {
    expect(nextCardState(CLOSED, { type: 'activate' })).toEqual({ open: true, byHover: false });
  });

  it('a second activation / Escape / outside press dismisses it', () => {
    expect(nextCardState({ open: true, byHover: false }, { type: 'dismiss' })).toEqual(CLOSED);
  });

  it('a MOUSE hover still opens and closes it — desktop is not degraded to click-only', () => {
    const opened = nextCardState(CLOSED, hover('mouse'));
    expect(opened.open).toBe(true);
    expect(nextCardState(opened, leave('mouse'))).toEqual(CLOSED);
  });

  it('a TOUCH pointerenter does NOT open it — the tap does', () => {
    expect(nextCardState(CLOSED, hover('touch'))).toEqual(CLOSED);
  });

  it('a touch pointerleave does not slam a tap-opened card shut', () => {
    // A tap emits pointerenter/leave around the click; honouring the leave would close the card
    // in the same gesture that opened it, which is exactly the "card never opens on mobile" bug.
    const tapped = nextCardState(CLOSED, { type: 'activate' });
    expect(nextCardState(tapped, leave('touch'))).toEqual(tapped);
  });

  it('a deliberately opened card survives the mouse wandering off', () => {
    const clicked = nextCardState(CLOSED, { type: 'activate' });
    expect(nextCardState(clicked, leave('mouse'))).toEqual(clicked);
  });
});

describe('reading age', () => {
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

  it('says how long ago a fresh reading was taken', () => {
    expect(ageLabel({ fetchedAt: ago(3) })).toBe('updated 3m ago');
    expect(ageLabel({ fetchedAt: ago(0) })).toBe('updated just now');
    expect(ageLabel({ fetchedAt: ago(150) })).toBe('updated 2h 30m ago');
  });

  it('says the refresh failed when the server is serving its last known-good numbers', () => {
    expect(ageLabel({ fetchedAt: ago(12), stale: true })).toBe('12m old — refresh failed');
    expect(ageLabel({ stale: true })).toBe('last reading — refresh failed');
  });

  it('renders the age inside the card', () => {
    const html = renderToStaticMarkup(
      <UsageCard usage={{ subscriptionType: 'max', fetchedAt: ago(4), limits: [{ kind: 'session', group: 'session', percent: 6, severity: 'normal', resetsAt: null }] }} />,
    );
    expect(html).toContain('updated 4m ago');
  });
});
