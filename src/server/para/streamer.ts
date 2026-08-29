/**
 * ParaStreamer — progressive delivery of one agent turn into a para-li conversation row.
 *
 * WHY NOT `SlackStreamer`. The brief said to reuse `mcp-slack-use/src/streamer.ts` rather than
 * write a second streamer. Its throttling contract IS reused — buffer, `flushInterval` (300ms),
 * `flushThreshold` (30 chars), and a serialized `flushChain` so sends never overtake each other,
 * all mirrored here deliberately and with the same defaults. Its *transport* cannot be: every
 * send in that class is a `slackApi(token, 'chat.appendStream'|'chat.startStream'|'chat.update')`
 * call against Slack's three-call streaming protocol, and it lives in a vendored package in a
 * different repo. Para's transport is one signed POST per flush carrying the accumulated text —
 * there is no start/append/stop handshake and no ts to thread. Forking that package to
 * parameterize the transport would be a larger, riskier change to Slack's live path than these
 * ~60 lines, so the shared thing is the CONTRACT, not the code, and this comment is the seam.
 *
 * ACCUMULATE, DON'T APPEND: each flush sends the full text so far. para-li patches the message row
 * with a whole-row `set` (its existing partial-update convention), so a dropped or reordered delta
 * self-heals on the next flush instead of leaving a hole. That is worth more than the bytes.
 */
import { createHmac, randomUUID } from 'node:crypto';

export interface ParaCallback {
  /** Absolute webhook URL, handed to us per-turn by para-li (never configured here). */
  url: string;
  /** HMAC key for THIS connection, handed over per-turn so a rotation lands on the next message. */
  secret: string;
  /** Connection id — inside the signed material, so a delivery is bound to its connection. */
  connId: string;
}

export interface ParaStreamerOptions {
  callback: ParaCallback;
  convId: string;
  /** The row to patch. Omit for a PROACTIVE post (no preceding user turn) — see `post()`. */
  msgId?: string;
  flushInterval?: number;
  flushThreshold?: number;
  /** Show a transient inline marker per tool call, as the Slack streamer does. Default on. */
  toolMarkers?: boolean;
}

/** Signature contract, mirrored byte-for-byte in para-li's `lib/agent-conn.ts#signPayload`.
 *  The two repos are separately published, so this is duplicated on purpose; if you change one,
 *  change both — a drift here presents as a silent 401 on every delta.
 *
 *  The DELIVERY id is in the material because para-li's replay guard dedupes on that header alone;
 *  unsigned, it would be the one field an attacker could vary freely to replay a captured delivery
 *  inside the signature window.
 *
 *  UNESCAPED `.` — why the field boundaries cannot be shifted. There are no length prefixes, so in
 *  general `a.b.c` is ambiguous. It holds here because the receiver PINS every field but the last
 *  before it verifies: `connId` must be exactly 24 lowercase hex chars (`isConnId`, checked before
 *  the signature) and `ts` is `Number(header)` re-stringified, so it is a canonical, dot-free digit
 *  run that must also land within 300s of now. `rawBody` is trailing and can absorb nothing. That
 *  leaves `deliveryId` as the only free field, and it sits between two fixed-shape neighbours, so
 *  no (deliveryId, ts) pair can be re-cut into a different one. If either check is ever relaxed,
 *  length-prefix the material instead of relying on this. */
export function signPara(secret: string, connId: string, deliveryId: string, ts: number, rawBody: string): string {
  return 'v1=' + createHmac('sha256', secret).update(`${connId}.${deliveryId}.${ts}.${rawBody}`).digest('hex');
}

/** One signed POST. Returns false on any non-2xx or network error, having logged it — the caller
 *  keeps streaming rather than aborting the agent's turn over a transport hiccup. */
export async function postPara(cb: ParaCallback, payload: object): Promise<boolean> {
  const raw = JSON.stringify(payload);
  const ts = Date.now();
  // Per-DELIVERY id, not per-turn: para-li's replay guard dedupes on this, so a shared id across
  // the deltas of one turn would drop every delta after the first. Minted here so the exact same
  // value goes into the header AND the signature — they must not be able to diverge.
  const delivery = randomUUID();
  try {
    const res = await fetch(cb.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-agent-conn': cb.connId,
        'x-agent-timestamp': String(ts),
        'x-agent-signature': signPara(cb.secret, cb.connId, delivery, ts, raw),
        'x-agent-delivery': delivery,
      },
      body: raw,
    });
    if (!res.ok) {
      console.warn(`[para-streamer] ${(payload as any).type} rejected: ${res.status} ${await res.text().catch(() => '')}`.slice(0, 300));
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[para-streamer] delivery failed:', (err as Error).message);
    return false;
  }
}

export class ParaStreamer {
  private buffer = '';
  private fullText = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushChain: Promise<void> = Promise.resolve();
  private aborted = false;
  private afterTool = false;

  private readonly flushInterval: number;
  private readonly flushThreshold: number;
  private readonly toolMarkers: boolean;

  constructor(private readonly opts: ParaStreamerOptions) {
    this.flushInterval = opts.flushInterval ?? 300;
    this.flushThreshold = opts.flushThreshold ?? 30;
    this.toolMarkers = opts.toolMarkers ?? true;
  }

  feed(ev: { type: string; text?: string; tool?: string }): void {
    if (this.aborted || !this.opts.msgId) return;

    if (ev.type === 'text_delta' && ev.text) {
      if (this.afterTool) { this.fullText += '\n'; this.afterTool = false; }
      this.buffer += ev.text;
      this.fullText += ev.text;
      if (this.buffer.length >= this.flushThreshold) this.enqueueFlush();
      else this.scheduleTimer();
    } else if (ev.type === 'tool_use' && ev.tool && this.toolMarkers) {
      // In-band, transient: `finish()` sends the clean final text, which replaces the row wholesale
      // (para-li writes the whole row), so the marker disappears on its own.
      this.afterTool = true;
      this.fullText += `\n\n_🔧 ${ev.tool.slice(0, 200)}_\n\n`;
      this.enqueueFlush();
    }
  }

  /** Settle the row with the final text. Returns the text actually sent. */
  async finish(): Promise<string> {
    this.clearTimer();
    this.buffer = '';
    await this.flushChain;
    if (this.aborted || !this.opts.msgId) return this.fullText;
    const text = this.fullText.trim() || '(no output)';
    await postPara(this.opts.callback, { type: 'final', convId: this.opts.convId, msgId: this.opts.msgId, text });
    return text;
  }

  /** Settle the row as a visible failure. The owner sees WHY, in the thread, not only in a log. */
  async fail(message: string): Promise<void> {
    this.aborted = true;
    this.clearTimer();
    await this.flushChain;
    if (!this.opts.msgId) return;
    await postPara(this.opts.callback, { type: 'error', convId: this.opts.convId, msgId: this.opts.msgId, message });
  }

  private enqueueFlush(): void {
    this.clearTimer();
    if (!this.fullText) return;
    this.buffer = '';
    const snapshot = this.fullText;
    // Serialized: a later, longer snapshot must never be overtaken by an earlier one, or the row
    // visibly rewinds mid-stream.
    this.flushChain = this.flushChain
      .then(async () => { await postPara(this.opts.callback, { type: 'delta', convId: this.opts.convId, msgId: this.opts.msgId, text: snapshot }); })
      .catch((err) => console.warn('[para-streamer] flush error:', (err as Error).message));
  }

  private scheduleTimer(): void {
    this.clearTimer();
    this.timer = setTimeout(() => this.enqueueFlush(), this.flushInterval);
  }

  private clearTimer(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }
}

/** PROACTIVE post — a scheduled run, a deploy notice, a downtime report. No preceding user turn,
 *  so there is no row to patch: para-li mints one. Same signed transport, same fence. */
export function postProactive(cb: ParaCallback, convId: string, text: string): Promise<boolean> {
  return postPara(cb, { type: 'post', convId, text });
}
