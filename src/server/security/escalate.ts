// `escalate` — the one tool a reply-only principal gets: hand the request to a human owner, who opens the session
// link and continues AS THEMSELVES (a new owner-owned turn). The escalated session never upgrades.
//
// Anti alert-fatigue: per-principal cooldown with digest batching. The first escalation in a window is sent at once
// and opens a `cooldownMs` window; further ones in that window are collected and sent as ONE digest when it ends
// (which opens the next window, so a sustained flood yields at most one notice per window). Principals are cheap to
// rotate (a new From address each time), so a GLOBAL cap bounds immediate notices across all of them: beyond
// `globalMax` per `globalWindowMs`, everything goes into one global digest. Every digest lists at most `maxPending`.
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
/** `sent` = the owner notice was handed off; `batched` = queued for a digest; `dropped` = over the digest cap (counted). */
export type EscalationStatus = 'sent' | 'batched' | 'dropped';

export class EscalationsOptions {
  cooldownMs: number = 15 * 60_000;
  /** At most this many IMMEDIATE notices per `globalWindowMs`, across all principals. */
  globalMax: number = 5;
  globalWindowMs: number = 15 * 60_000;
  excerptChars: number = 500;
  summaryChars: number = 500;
  /** Max escalations listed in one digest (per principal, and the global one); beyond it they are counted, not kept. */
  maxPending: number = 20;
  /** Deliver a notice; a rejection means it was NOT sent. */
  notify: (text: string) => void | Promise<void> = (text) => import('../notify-owners.ts').then(m => m.notifyOwners('security', text));
  record: (ev: AuditEvent) => void = (ev) => security()?.record(ev);
  sessionUrl: (sessionId?: string) => string | undefined = getSessionUrl;
  setTimer: (fn: () => void, ms: number) => { cancel(): void } = (fn, ms) => {
    const t = setTimeout(fn, ms); (t as { unref?: () => void }).unref?.();
    return { cancel: () => clearTimeout(t) };
  };
}

/** `senders`: every principal held in the window, listed or dropped (the digest header counts them). */
interface Window { pending: EscalationRequest[]; dropped: number; senders: Set<string>; timer: { cancel(): void } }
interface GlobalWindow extends Window { sent: number }

const clip = (s: string | undefined, n: number) => { const t = (s ?? '').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
/** Untrusted text into a Slack notice: `&<>` escaped (no `<!channel>`, `<@U…>`, `<url|label>` markup), no bare broadcasts. */
const slack = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/@(channel|here|everyone)\b/gi, '@\u200b$1');
const NEWLINE = /\r\n|[\r\n\u2028\u2029]/;
/** A single-line field: newlines collapsed, so it can't forge `*Session:*`-style lines. */
const oneLine = (s: string) => slack(s).split(NEWLINE).map(l => l.trim()).filter(Boolean).join(' ');
/** A multi-line field: every line quoted, so nothing in it reads as one of the notice's own lines. */
const quote = (s: string) => slack(s).split(NEWLINE).map(l => `> ${l}`).join('\n');

export class Escalations {
  public options: EscalationsOptions;
  private windows = new Map<string, Window>();
  private global?: GlobalWindow;

  public constructor(options?: Partial<EscalationsOptions>) {
    this.options = { ...new EscalationsOptions(), ...options };
  }

  public async escalate(req: EscalationRequest): Promise<EscalationStatus> {
    const w = this.windows.get(req.principal.id);
    let status: EscalationStatus;
    if (w) status = this.hold(w, req);
    else if ((this.global?.sent ?? 0) >= this.options.globalMax) status = this.hold(this.globalWindow(), req);
    else {
      const g = this.globalWindow();
      g.sent++;
      this.open(req.principal.id);
      // `sent` only once the notice was handed off; a failed one frees its global slot and waits in the digest instead.
      if (await this.send([req], 0)) status = 'sent';
      else { g.sent--; status = this.hold(this.windows.get(req.principal.id) ?? this.globalWindow(), req); }
    }
    this.audit(req, status);
    return status;
  }

  /** Shutdown/test: send every pending digest now (awaiting delivery) and clear all windows. Returns digests sent. */
  public async flushAll(): Promise<number> {
    const jobs: Promise<boolean>[] = [];
    for (const [key, w] of [...this.windows]) { w.timer.cancel(); jobs.push(this.flush(key, false)); }
    if (this.global) { this.global.timer.cancel(); jobs.push(this.flushGlobal()); }
    return (await Promise.all(jobs)).filter(Boolean).length;
  }

  private hold(w: Window, req: EscalationRequest): EscalationStatus {
    w.senders.add(req.principal.id);
    if (w.pending.length < this.options.maxPending) { w.pending.push(req); return 'batched'; }
    w.dropped++;
    return 'dropped';
  }

  private globalWindow(): GlobalWindow {
    return (this.global ??= { pending: [], dropped: 0, senders: new Set(), sent: 0, timer: this.options.setTimer(() => void this.flushGlobal(), this.options.globalWindowMs) });
  }

  private open(key: string): void {
    const timer = this.options.setTimer(() => void this.flush(key, true), this.options.cooldownMs);
    this.windows.set(key, { pending: [], dropped: 0, senders: new Set(), timer });
  }

  private async flush(key: string, reopen: boolean): Promise<boolean> {
    const w = this.windows.get(key);
    this.windows.delete(key);
    if (!w || (!w.pending.length && !w.dropped)) return false;
    if (reopen) this.open(key);
    return w.pending.length ? this.send(w.pending, w.dropped) : false;
  }

  private async flushGlobal(): Promise<boolean> {
    const g = this.global;
    this.global = undefined;
    return g?.pending.length ? this.send(g.pending, g.dropped, g.senders.size) : false;
  }

  /** `senders` set = a global digest (lists who sent each item). */
  private async send(reqs: EscalationRequest[], dropped: number, senders?: number): Promise<boolean> {
    try { await this.options.notify(this.format(reqs, dropped, senders)); return true; }
    catch (e: any) { console.error(`[escalate] owner notice failed: ${e?.message ?? e}`); return false; }
  }

  private format(reqs: EscalationRequest[], dropped: number, senders?: number): string {
    const { excerptChars, summaryChars, sessionUrl, cooldownMs, globalWindowMs } = this.options;
    const global = senders !== undefined;
    const who = (r: EscalationRequest) => `${oneLine(r.principal.id)} (role ${oneLine(r.role)})`;
    const item = (r: EscalationRequest) => {
      const link = sessionUrl(r.sessionId);
      const lines = global ? [`*From:* ${who(r)}`] : [];
      lines.push(`*Channel:* ${oneLine(r.channel)}`, `*Session:* ${link ?? (r.sessionId ? oneLine(r.sessionId) : '(none)')}`, '*Summary:*', quote(clip(r.summary, summaryChars)));
      if (r.excerpt?.trim()) lines.push('*Original message:*', quote(clip(r.excerpt, excerptChars)));
      return lines.join('\n');
    };
    const footer = 'Open the session and continue as yourself — the escalated session itself keeps its restricted role.';
    const more = dropped ? ` (+${dropped} more not shown)` : '';
    const first = reqs[0];
    if (!global && reqs.length === 1 && !dropped) return `:rotating_light: Escalation from ${who(first)}\n${item(first)}\n\n${footer}`;
    const head = global
      ? `${reqs.length + dropped} escalations from ${senders} sender${senders === 1 ? '' : 's'} while immediate notices were capped (${this.options.globalMax} per ${Math.round(globalWindowMs / 60_000)} min)`
      : `${reqs.length} escalations from ${who(first)} in the last ${Math.round(cooldownMs / 60_000)} min`;
    return `:rotating_light: ${head}${more}\n\n${reqs.map(item).join('\n\n')}\n\n${footer}`;
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
/** Shutdown: deliver batched digests (they live in memory only). No-op when nothing ever escalated. */
export function flushEscalations(): Promise<number> { return current ? current.flushAll() : Promise.resolve(0); }

/** What the model tells the sender: a delivery claim only when the notice was handed off; a digest promise only when the
 *  request is listed in one. A dropped request is only COUNTED in the digest ("+N more not shown"). */
export const escalateReply = (status: EscalationStatus) => status === 'sent'
  ? 'Escalated: the owners have been notified.'
  : status === 'batched'
    ? 'Queued for the owners: this request will reach them in their next digest. Do not tell the sender they were already notified.'
    : 'Owners are receiving many requests right now: this one is counted in their next summary, but its details are not included. Do not tell the sender they were notified or that the owners have their request; suggest they try again later if it is urgent.';

/** In-process MCP server exposing `escalate` for one turn. */
export function escalateMcpServer(ctx: { principal: Principal; role: () => string; sessionId?: string; channel: string; excerpt?: string }) {
  return createSdkMcpServer({
    name: ESCALATE_SERVER,
    version: '1.0.0',
    tools: [tool(
      ESCALATE_TOOL,
      'Hand this request to a human owner when it needs something you are not permitted to do here (tools, data, actions). ' +
      'Owners get your summary and the original message (immediately, or in a digest when busy); they follow up themselves. Call it at most once per request, then tell the sender a human will follow up.',
      { summary: z.string().min(1).max(2000).describe('One or two sentences: what the sender wants and why it needs a human.') },
      async ({ summary }) => {
        const status = await escalations().escalate({ principal: ctx.principal, role: ctx.role(), sessionId: ctx.sessionId, channel: ctx.channel, summary, excerpt: ctx.excerpt });
        return { content: [{ type: 'text' as const, text: escalateReply(status) }] };
      },
    )],
  });
}
