// `escalate` — the one tool a reply-only principal gets: hand the request to a human owner, who opens the session
// link and continues AS THEMSELVES (a new owner-owned turn). The escalated session never upgrades.
//
// Anti alert-fatigue: per-principal cooldown with digest batching. The first escalation in a window is sent at once
// and opens a `cooldownMs` window; further ones in that window are collected and sent as ONE digest when it ends
// (which opens the next window, so a sustained flood yields at most one notice per window). Pending is capped.
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';
import type { Principal } from './principal.ts';
import type { AuditEvent } from './audit.ts';
import { security } from './runtime.ts';
import { getSessionUrl } from '../shraga-config.ts';
import { ESCALATE_SERVER, ESCALATE_TOOL } from './enforce.ts';

export interface EscalationRequest {
  principal: Principal;
  /** Effective role at escalation time. */
  role: string;
  sessionId?: string;
  /** Channel/lane, e.g. `slack`, `email via gmail`, `internal:scheduler`. */
  channel: string;
  /** The model's summary (untrusted text). */
  summary: string;
  /** The raw request that triggered it (untrusted text). */
  excerpt?: string;
}
export type EscalationStatus = 'sent' | 'batched' | 'dropped';

export class EscalationsOptions {
  cooldownMs: number = 15 * 60_000;
  excerptChars: number = 500;
  summaryChars: number = 500;
  /** Max escalations held for one principal's digest; beyond it they are counted, not kept. */
  maxPending: number = 20;
  notify: (text: string) => void = (text) => {
    import('../notify-owners.ts')
      .then(m => m.notifyOwners('security', text))
      .catch((e: any) => console.error('[escalate] owner notice failed:', e?.message ?? e));
  };
  record: (ev: AuditEvent) => void = (ev) => security()?.record(ev);
  sessionUrl: (sessionId?: string) => string | undefined = getSessionUrl;
  setTimer: (fn: () => void, ms: number) => { cancel(): void } = (fn, ms) => {
    const t = setTimeout(fn, ms); (t as { unref?: () => void }).unref?.();
    return { cancel: () => clearTimeout(t) };
  };
}

interface Window { pending: EscalationRequest[]; dropped: number; timer: { cancel(): void } }

const clip = (s: string | undefined, n: number) => { const t = (s ?? '').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
/** Untrusted text into a Slack/push notice: no broadcast mentions (`<!channel>`, `<!here>`), quoted as data. */
const neutral = (s: string) => s.replace(/<!/g, '<​!').replace(/@(channel|here|everyone)\b/gi, '@​$1');
const quote = (s: string) => s.split('\n').map(l => `> ${l}`).join('\n');

export class Escalations {
  public options: EscalationsOptions;
  private windows = new Map<string, Window>();

  public constructor(options?: Partial<EscalationsOptions>) {
    this.options = { ...new EscalationsOptions(), ...options };
  }

  public escalate(req: EscalationRequest): EscalationStatus {
    const key = req.principal.id;
    const w = this.windows.get(key);
    let status: EscalationStatus;
    if (!w) {
      this.send([req], 0);
      this.open(key);
      status = 'sent';
    } else if (w.pending.length < this.options.maxPending) {
      w.pending.push(req);
      status = 'batched';
    } else {
      w.dropped++;
      status = 'dropped';
    }
    this.audit(req, status);
    return status;
  }

  /** Test/shutdown: send every pending digest now and clear the windows. */
  public flushAll(): void {
    for (const key of [...this.windows.keys()]) { this.windows.get(key)!.timer.cancel(); this.flush(key, false); }
  }

  private open(key: string): void {
    const timer = this.options.setTimer(() => this.flush(key, true), this.options.cooldownMs);
    this.windows.set(key, { pending: [], dropped: 0, timer });
  }

  private flush(key: string, reopen: boolean): void {
    const w = this.windows.get(key);
    this.windows.delete(key);
    if (!w || (!w.pending.length && !w.dropped)) return;
    if (w.pending.length) this.send(w.pending, w.dropped);
    if (reopen) this.open(key);
  }

  private send(reqs: EscalationRequest[], dropped: number): void {
    try { this.options.notify(this.format(reqs, dropped)); }
    catch (e: any) { console.error(`[escalate] notify failed: ${e?.message ?? e}`); }
  }

  private format(reqs: EscalationRequest[], dropped: number): string {
    const { excerptChars, summaryChars, sessionUrl } = this.options;
    const first = reqs[0];
    const who = `${first.principal.id} (role ${first.role})`;
    const item = (r: EscalationRequest) => {
      const link = sessionUrl(r.sessionId);
      const lines = [`*Summary:* ${neutral(clip(r.summary, summaryChars))}`, `*Channel:* ${r.channel}`, `*Session:* ${link ?? r.sessionId ?? '(none)'}`];
      if (r.excerpt?.trim()) lines.push(quote(neutral(clip(r.excerpt, excerptChars))));
      return lines.join('\n');
    };
    const footer = 'Open the session and continue as yourself — the escalated session itself keeps its restricted role.';
    if (reqs.length === 1 && !dropped) return `:rotating_light: Escalation from ${who}\n${item(first)}\n\n${footer}`;
    const more = dropped ? ` (+${dropped} more not shown)` : '';
    return `:rotating_light: ${reqs.length} escalations from ${who} in the last ${Math.round(this.options.cooldownMs / 60_000)} min${more}\n\n${reqs.map(item).join('\n\n')}\n\n${footer}`;
  }

  private audit(req: EscalationRequest, status: EscalationStatus): void {
    try {
      this.options.record({ type: 'escalate', principal: req.principal.id, role: req.role, sessionId: req.sessionId, target: req.channel, reason: status });
    } catch (e: any) { console.error(`[escalate] audit failed: ${e?.message ?? e}`); }
  }
}

let current: Escalations | undefined;
/** Process-wide instance (cooldowns must be shared across turns). */
export function escalations(): Escalations { return (current ??= new Escalations()); }
/** Test-only. */
export function __setEscalationsForTest(e: Escalations | undefined): void { current = e; }

/** In-process MCP server exposing `escalate` for one turn. */
export function escalateMcpServer(ctx: { principal: Principal; role: () => string; sessionId?: string; channel: string; excerpt?: string }) {
  return createSdkMcpServer({
    name: ESCALATE_SERVER,
    version: '1.0.0',
    tools: [tool(
      ESCALATE_TOOL,
      'Hand this request to a human owner when it needs something you are not permitted to do here (tools, data, actions). ' +
      'Owners are notified with your summary and the original message; they follow up themselves. Call it at most once per request, then tell the sender a human will follow up.',
      { summary: z.string().min(1).max(2000).describe('One or two sentences: what the sender wants and why it needs a human.') },
      async ({ summary }) => {
        const status = escalations().escalate({ principal: ctx.principal, role: ctx.role(), sessionId: ctx.sessionId, channel: ctx.channel, summary, excerpt: ctx.excerpt });
        const text = status === 'sent' ? 'Escalated: the owners have been notified.' : 'Noted: the owners were notified recently and will receive this in their next digest.';
        return { content: [{ type: 'text' as const, text }] };
      },
    )],
  });
}
