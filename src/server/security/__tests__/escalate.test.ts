import { describe, test, expect } from 'bun:test';
import { Escalations, escalateMcpServer } from '../escalate.ts';
import { fromSlack, fromEmailSender } from '../principal.ts';
import type { AuditEvent } from '../audit.ts';

function rig(cooldownMs = 1000, maxPending = 20) {
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  const notices: string[] = [];
  const audits: AuditEvent[] = [];
  const e = new Escalations({
    cooldownMs, maxPending,
    notify: (t) => notices.push(t),
    record: (ev) => audits.push(ev),
    sessionUrl: (sid) => (sid ? `https://agent.test/?session=${sid}` : undefined),
    setTimer: (fn, ms) => { const t = { fn, ms, cancelled: false }; timers.push(t); return { cancel: () => { t.cancelled = true; } }; },
  });
  /** Fire the newest live timer (end of the current window). */
  const endWindow = () => { const t = timers.filter(x => !x.cancelled).at(-1)!; t.cancelled = true; t.fn(); };
  return { e, timers, notices, audits, endWindow };
}

const guest = fromSlack('U1', { email: 'g@x.test' });
const req = (summary: string, extra: Record<string, unknown> = {}) => ({ principal: guest, role: 'guest', sessionId: 's1', channel: 'slack', summary, excerpt: 'raw ask', ...extra });

describe('Escalations cooldown + digest', () => {
  test('first escalation is sent at once with principal, channel, session link and quoted raw excerpt', () => {
    const { e, notices, audits, timers } = rig();
    expect(e.escalate(req('wants a refund', { excerpt: 'refund me now <!channel> @here' }))).toBe('sent');
    expect(notices).toHaveLength(1);
    const n = notices[0];
    expect(n).toContain('slack:U1 (role guest)');
    expect(n).toContain('*Channel:* slack');
    expect(n).toContain('https://agent.test/?session=s1');
    expect(n).toContain('> refund me now');
    expect(n).not.toContain('<!channel>'); // broadcast mentions neutralized
    expect(n).not.toMatch(/@here\b/);
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(1000);
    expect(audits).toEqual([{ type: 'escalate', principal: 'slack:U1', role: 'guest', sessionId: 's1', target: 'slack', reason: 'sent' }]);
  });

  test('within the window further escalations collapse into ONE digest sent when it ends; the next window then throttles again', () => {
    const { e, notices, audits, endWindow } = rig();
    e.escalate(req('first'));
    expect(e.escalate(req('second'))).toBe('batched');
    expect(e.escalate(req('third'))).toBe('batched');
    expect(notices).toHaveLength(1);

    endWindow();
    expect(notices).toHaveLength(2);
    expect(notices[1]).toContain('2 escalations from slack:U1');
    expect(notices[1]).toContain('second');
    expect(notices[1]).toContain('third');

    // a digest opens a new window: a flood keeps yielding at most one notice per window
    expect(e.escalate(req('fourth'))).toBe('batched');
    endWindow();
    expect(notices).toHaveLength(3);
    // a quiet window closes without a notice; the next escalation is immediate again
    endWindow();
    expect(notices).toHaveLength(3);
    expect(e.escalate(req('fifth'))).toBe('sent');
    expect(notices).toHaveLength(4);
    expect(audits.map(a => a.reason)).toEqual(['sent', 'batched', 'batched', 'batched', 'sent']);
  });

  test('cooldown is per principal', () => {
    const { e, notices } = rig();
    e.escalate(req('a'));
    expect(e.escalate({ ...req('b'), principal: fromEmailSender('other@x.test', true), channel: 'email' })).toBe('sent');
    expect(notices).toHaveLength(2);
  });

  test('pending is capped: overflow is dropped and counted in the digest', () => {
    const { e, notices, endWindow } = rig(1000, 2);
    e.escalate(req('a'));
    expect([e.escalate(req('b')), e.escalate(req('c')), e.escalate(req('d')), e.escalate(req('e'))]).toEqual(['batched', 'batched', 'dropped', 'dropped']);
    endWindow();
    expect(notices[1]).toContain('2 escalations');
    expect(notices[1]).toContain('+2 more not shown');
  });

  test('the escalate tool is an in-process SDK MCP server named "security"', () => {
    const cfg = escalateMcpServer({ principal: guest, role: () => 'guest', sessionId: 's1', channel: 'slack' }) as any;
    expect(cfg.type).toBe('sdk');
    expect(cfg.name).toBe('security');
    expect(cfg.instance).toBeDefined();
  });
});
