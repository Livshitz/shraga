import { describe, test, expect } from 'bun:test';
import { Escalations, escalateMcpServer, escalateReply } from '../escalate.ts';
import { fromSlack, fromEmailSender } from '../principal.ts';
import type { AuditEvent } from '../audit.ts';

function rig(cooldownMs = 1000, maxPending = 20, extra: Record<string, unknown> = {}) {
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  const notices: string[] = [];
  const audits: AuditEvent[] = [];
  const e = new Escalations({
    cooldownMs, maxPending, globalWindowMs: 5000,
    notify: (t) => { notices.push(t); },
    record: (ev) => audits.push(ev),
    sessionUrl: (sid) => (sid ? `https://agent.test/?session=${sid}` : undefined),
    setTimer: (fn, ms) => { const t = { fn, ms, cancelled: false }; timers.push(t); return { cancel: () => { t.cancelled = true; } }; },
    ...extra,
  });
  /** Fire the newest live per-principal timer (end of the current cooldown window). */
  const endWindow = () => { const t = timers.filter(x => !x.cancelled && x.ms === cooldownMs).at(-1)!; t.cancelled = true; t.fn(); };
  const endGlobal = () => { const t = timers.filter(x => !x.cancelled && x.ms === 5000).at(-1)!; t.cancelled = true; t.fn(); };
  return { e, timers, notices, audits, endWindow, endGlobal };
}
const tick = () => new Promise(r => setTimeout(r, 0));

const guest = fromSlack('U1', { email: 'g@x.test' });
const req = (summary: string, extra: Record<string, unknown> = {}) => ({ principal: guest, role: 'guest', sessionId: 's1', channel: 'slack', summary, excerpt: 'raw ask', ...extra });

describe('Escalations cooldown + digest', () => {
  test('first escalation is sent at once with principal, channel, session link and quoted raw excerpt', async () => {
    const { e, notices, audits, timers } = rig();
    expect(await e.escalate(req('wants a refund', { excerpt: 'refund me now <!channel> @here' }))).toBe('sent');
    expect(notices).toHaveLength(1);
    const n = notices[0];
    expect(n).toContain('slack:U1 (role guest)');
    expect(n).toContain('*Channel:* slack');
    expect(n).toContain('https://agent.test/?session=s1');
    expect(n).toContain('> refund me now');
    expect(n).not.toContain('<!channel>'); // broadcast mentions neutralized
    expect(n).not.toMatch(/@here\b/);
    expect(timers.map(t => t.ms).sort()).toEqual([1000, 5000]); // the principal's cooldown + the global window
    expect(audits).toEqual([{ type: 'escalate', principal: 'slack:U1', role: 'guest', sessionId: 's1', target: 'slack', reason: 'sent' }]);
  });

  test('within the window further escalations collapse into ONE digest sent when it ends; the next window then throttles again', async () => {
    const { e, notices, audits, endWindow } = rig();
    await e.escalate(req('first'));
    expect(await e.escalate(req('second'))).toBe('batched');
    expect(await e.escalate(req('third'))).toBe('batched');
    expect(notices).toHaveLength(1);

    endWindow(); await tick();
    expect(notices).toHaveLength(2);
    expect(notices[1]).toContain('2 escalations from slack:U1');
    expect(notices[1]).toContain('second');
    expect(notices[1]).toContain('third');

    // a digest opens a new window: a flood keeps yielding at most one notice per window
    expect(await e.escalate(req('fourth'))).toBe('batched');
    endWindow(); await tick();
    expect(notices).toHaveLength(3);
    // a quiet window closes without a notice; the next escalation is immediate again
    endWindow(); await tick();
    expect(notices).toHaveLength(3);
    expect(await e.escalate(req('fifth'))).toBe('sent');
    expect(notices).toHaveLength(4);
    expect(audits.map(a => a.reason)).toEqual(['sent', 'batched', 'batched', 'batched', 'sent']);
  });

  test('cooldown is per principal', async () => {
    const { e, notices } = rig();
    await e.escalate(req('a'));
    expect(await e.escalate({ ...req('b'), principal: fromEmailSender('other@x.test', true), channel: 'email' })).toBe('sent');
    expect(notices).toHaveLength(2);
  });

  test('pending is capped: overflow is dropped and counted in the digest', async () => {
    const { e, notices, endWindow } = rig(1000, 2);
    await e.escalate(req('a'));
    expect([await e.escalate(req('b')), await e.escalate(req('c')), await e.escalate(req('d')), await e.escalate(req('e'))]).toEqual(['batched', 'batched', 'dropped', 'dropped']);
    endWindow(); await tick();
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

describe('notice injection (reviewer probe payloads)', () => {
  test('principal id, summary, excerpt and channel are Slack-escaped; single-line fields collapse; summary/excerpt are quoted', async () => {
    const { e, notices } = rig();
    await e.escalate({
      principal: fromEmailSender('"<!channel>"@evil.test', true),
      role: 'guest', sessionId: 'sid-1', channel: 'email\n*Session:* <https://evil.test|x>',
      summary: 'wants a refund\n*Session:* <https://evil.test/login|https://shraga.example/s/sid-1> <@U0OWNER>',
      excerpt: 'hi <@U0OWNER> see <https://evil.test|docs>',
    });
    const lines = notices[0].split('\n');
    expect(notices[0]).not.toMatch(/<[!@#]|<https?:/); // no Slack markup survives: <!channel>, <@U…>, <url|label>
    expect(lines[0]).toContain('&lt;!channel&gt;');
    // the ONLY unquoted *Session:* line is the real one
    expect(lines.filter(l => l.startsWith('*Session:*'))).toEqual(['*Session:* https://agent.test/?session=sid-1']);
    expect(lines).toContain('> *Session:* &lt;https://evil.test/login|https://shraga.example/s/sid-1&gt; &lt;@U0OWNER&gt;');
    expect(lines.filter(l => l.startsWith('*Channel:*'))).toEqual(['*Channel:* email *Session:* &lt;https://evil.test|x&gt;']);
    expect(lines).toContain('> hi &lt;@U0OWNER&gt; see &lt;https://evil.test|docs&gt;');
    expect(notices[0]).not.toContain('&amp;lt;'); // escaped once
  });
});

describe('global cap (rotating principals)', () => {
  test('50 rotated senders: 5 immediate notices, the rest in ONE global digest listing 20 + "+K more"', async () => {
    const { e, notices, audits, endGlobal } = rig();
    const statuses: string[] = [];
    for (let i = 0; i < 50; i++) statuses.push(await e.escalate({ principal: fromEmailSender(`a${i}@evil.test`, true), role: 'guest', channel: 'email', summary: `s${i}` }));
    expect(notices).toHaveLength(5);
    expect(statuses.filter(s => s === 'sent')).toHaveLength(5);
    expect(statuses.filter(s => s === 'batched')).toHaveLength(20);
    expect(statuses.filter(s => s === 'dropped')).toHaveLength(25);
    expect(audits).toHaveLength(50);

    endGlobal(); await tick();
    expect(notices).toHaveLength(6);
    const digest = notices[5];
    expect(digest).toContain('45 escalations from 45 senders'); // dropped senders counted too, not just the 20 listed
    expect(digest).toContain('(+25 more not shown)');
    expect(digest.match(/^\*From:\*/gm)).toHaveLength(20);
    expect(digest).toContain('*From:* email:a5@evil.test (role guest)');
    expect(digest).not.toContain('email:a25@evil.test');

    // the next global window allows immediate notices again
    expect(await e.escalate({ principal: fromEmailSender('fresh@x.test', true), role: 'guest', channel: 'email', summary: 'x' })).toBe('sent');
  });

  test('a failed notice is not reported as sent: it waits in the digest', async () => {
    const { e, notices, endWindow } = rig(1000, 20, { notify: () => { throw new Error('slack down'); } });
    expect(await e.escalate(req('first'))).toBe('batched');
    expect(escalateReply('batched')).not.toContain('have been notified');
    expect(escalateReply('sent')).toContain('have been notified');
    e.options.notify = (t) => { notices.push(t); };
    endWindow(); await tick();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('first');
  });

  test('a failed immediate notice does not consume the global cap', async () => {
    let fail = true;
    const { e, notices } = rig(1000, 20, { globalMax: 1, notify: (t: string) => { if (fail) throw new Error('slack down'); notices.push(t); } });
    expect(await e.escalate(req('first'))).toBe('batched');
    fail = false;
    expect(await e.escalate({ ...req('other'), principal: fromEmailSender('o@x.test', true) })).toBe('sent');
    expect(await e.escalate({ ...req('third'), principal: fromEmailSender('t@x.test', true) })).toBe('batched'); // cap now used
  });

  test('a dropped escalation is not promised a digest listing; the digest header counts distinct senders', async () => {
    expect(escalateReply('dropped')).not.toMatch(/have been notified|will reach them/);
    expect(escalateReply('dropped')).toContain('counted');
    const { e, notices, endGlobal } = rig(1000, 1, { globalMax: 0 });
    const a = fromEmailSender('a@x.test', true), b = fromEmailSender('b@x.test', true);
    expect([await e.escalate({ ...req('1'), principal: a }), await e.escalate({ ...req('2'), principal: a }), await e.escalate({ ...req('3'), principal: b })]).toEqual(['batched', 'dropped', 'dropped']);
    endGlobal(); await tick();
    expect(notices[0]).toContain('3 escalations from 2 senders');
    expect(notices[0]).toContain('(+2 more not shown)');
  });

  test('flushAll sends per-principal and global digests (shutdown) and awaits delivery', async () => {
    const { e, notices, timers } = rig(1000, 20, { globalMax: 1 });
    await e.escalate(req('a'));
    await e.escalate(req('b')); // per-principal digest
    await e.escalate({ ...req('c'), principal: fromEmailSender('z@x.test', true) }); // over the global cap
    let delivered = 0;
    e.options.notify = async (t) => { await new Promise(r => setTimeout(r, 5)); notices.push(t); delivered++; };
    expect(await e.flushAll()).toBe(2);
    expect(delivered).toBe(2);
    expect(timers.every(t => t.cancelled)).toBe(true);
    expect(await e.flushAll()).toBe(0);
  });
});
