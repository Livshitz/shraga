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
  /** Show a transient inline marker per tool call, as the Slack streamer does. Default on.
   *  Ignored when `sendSegments` is on — see `ParaStreamerOptions.sendSegments`. */
  toolMarkers?: boolean;
  /**
   * Emit STRUCTURED segments (`text` + `tool`) alongside the accumulated text.
   *
   * OFF BY DEFAULT, AND THAT IS THE POINT. This is a negotiated capability, not a preference: the
   * receiver tells us per turn (`accepts: ['segments']` on the turn request) whether it can store
   * and render them. A receiver that cannot gets the flattened `_🔧 Tool_` markers in the text, as
   * it always did. So the fallback is EXPLICIT — one flag, decided by the receiver — instead of
   * "the field is there, hopefully they ignore it".
   *
   * The two representations are mutually exclusive on purpose. Sending both would double-render on
   * a receiver that shows segments AND falls back to text for a preview.
   */
  sendSegments?: boolean;
  /** Per-POST wall clock. See `POST_TIMEOUT_MS`. Overridable for tests. */
  postTimeout?: number;
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

// ── Structured segments ──────────────────────────────────────────────────────
//
// SHAPE-COMPATIBLE WITH para-li's OWN `MessageSegment`/`ToolCallInfo` (`lib/para-relay.ts`), which
// its `ConversationChannel` already renders as collapsible tool pills. This is a deliberate reuse:
// the external-agent lane emits the SAME shape the Para's own turns do, so no second renderer, no
// second row field, and no second thing to keep in sync. Duplicated here rather than imported for
// the same reason `signPara` is — the two repos publish separately.

export interface ToolCallInfo {
  id: string;
  tool: string;
  status: 'running' | 'completed' | 'error';
  args?: Record<string, unknown>;
  result?: string;
}

export type MessageSegment =
  | { type: 'text'; content: string }
  | { type: 'tool'; tool: ToolCallInfo };

/**
 * SIZE DISCIPLINE. A `Read` of a big file or a chatty `Bash` produces tool input/output measured in
 * hundreds of KB, and every flush re-sends the WHOLE accumulated state (see ACCUMULATE, DON'T
 * APPEND at the top). Unclamped, one such call would be re-uploaded on every subsequent delta for
 * the rest of the turn and then parked in a database row forever.
 *
 * The caps are chosen against what the pill actually shows: para-li's `ToolPill` renders args as
 * one JSON line and slices the result at 500 chars, so anything past a few KB is invisible detail
 * that still costs bandwidth and storage. Truncation is MARKED with the true length — a silently
 * shortened `Bash` output is a lie the reader cannot detect.
 *
 * These are the SENDER's caps. para-li re-clamps on ingest (`parseSegments`) because a cap that
 * only exists on the sender is not a cap.
 */
export const MAX_TOOL_ARGS_CHARS = 2_000;
export const MAX_TOOL_RESULT_CHARS = 4_000;
/** Beyond this many tool calls in one turn, later calls stop being recorded as segments (the text
 *  reply is unaffected). A 100-call turn is already unreadable as pills; the cap is what stops a
 *  runaway loop from growing the row without bound. */
export const MAX_TOOL_SEGMENTS = 100;

/** Truncate with an honest marker naming the TRUE length. */
export function clampText(s: string, cap: number): string {
  return s.length <= cap ? s : `${s.slice(0, cap)}… [truncated, ${s.length} chars total]`;
}

/** Clamp a tool's input to `MAX_TOOL_ARGS_CHARS` across all its values, preserving the key
 *  structure (that is what makes the pill readable) and marking every truncation. */
export function clampArgs(input: unknown): Record<string, unknown> | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { value: clampText(String(input), MAX_TOOL_ARGS_CHARS) };
  }
  const out: Record<string, unknown> = {};
  let budget = MAX_TOOL_ARGS_CHARS;
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (budget <= 0) { out['…'] = 'more arguments omitted'; break; }
    const s = typeof v === 'string' ? v : (JSON.stringify(v) ?? String(v));
    if (s.length > budget) out[k] = clampText(s, budget);
    else out[k] = v;
    budget -= Math.min(s.length, budget);
  }
  return out;
}

/**
 * Wall clock on ONE delivery. Mirrors the 20s AbortController on para-li's own `dispatchAgentTurn`,
 * which is the other half of this lane.
 *
 * WHY A TIMEOUT IS LOAD-BEARING HERE AND NOT A NICETY: flushes are serialized through `flushChain`,
 * and `finish()` awaits that chain. `fetch` has no default timeout, so ONE POST that connects and
 * then never answers (a stalled proxy, a receiver wedged mid-handler, a half-open socket a dead NAT
 * entry never RSTs) blocks every later delta AND the `final` — for the process's lifetime. The
 * visible symptom is not an error: the reply freezes mid-sentence, no `final` ever lands, and
 * nothing is logged, because the failure never returns. A bounded POST turns that permanent wedge
 * into one logged, skipped delta and a `final` that still arrives.
 */
export const POST_TIMEOUT_MS = 20_000;

/** One signed POST. Returns false on any non-2xx, timeout, or network error, having logged it — the
 *  caller keeps streaming rather than aborting the agent's turn over a transport hiccup. */
export async function postPara(cb: ParaCallback, payload: object, timeoutMs: number = POST_TIMEOUT_MS): Promise<boolean> {
  const raw = JSON.stringify(payload);
  const ts = Date.now();
  // Per-DELIVERY id, not per-turn: para-li's replay guard dedupes on this, so a shared id across
  // the deltas of one turn would drop every delta after the first. Minted here so the exact same
  // value goes into the header AND the signature — they must not be able to diverge.
  const delivery = randomUUID();
  // Abort on a timer rather than `AbortSignal.timeout`: the same shape para-li uses, and the timer
  // is cleared in `finally` so a fast POST leaves nothing pending on the event loop.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(cb.url, {
      signal: ac.signal,
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
    const e = err as Error;
    console.warn('[para-streamer] delivery failed:', e.name === 'AbortError' ? `no response within ${timeoutMs}ms` : e.message);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export class ParaStreamer {
  private buffer = '';
  private fullText = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushChain: Promise<void> = Promise.resolve();
  private aborted = false;
  private afterTool = false;
  /** Structured mirror of the turn. Empty unless `sendSegments`. */
  private segments: MessageSegment[] = [];
  /** toolUseId → the live `ToolCallInfo` inside `segments`, so a `tool_result` can flip the status
   *  of the call it belongs to rather than of whichever ran last. */
  private readonly toolById = new Map<string, ToolCallInfo>();
  private toolCount = 0;

  private readonly flushInterval: number;
  private readonly flushThreshold: number;
  private readonly toolMarkers: boolean;
  private readonly sendSegments: boolean;
  private readonly postTimeout: number;

  constructor(private readonly opts: ParaStreamerOptions) {
    this.flushInterval = opts.flushInterval ?? 300;
    this.flushThreshold = opts.flushThreshold ?? 30;
    this.sendSegments = opts.sendSegments ?? false;
    // The marker is the FALLBACK, so it is off exactly when segments are on. Not "both, harmless" —
    // a receiver that renders segments and also derives a preview from the text would show the
    // markers in the preview of a reply whose body has real pills.
    this.toolMarkers = this.sendSegments ? false : (opts.toolMarkers ?? true);
    this.postTimeout = opts.postTimeout ?? POST_TIMEOUT_MS;
  }

  feed(ev: { type: string; text?: string; tool?: string; toolUseId?: string; input?: unknown; output?: string; isError?: boolean }): void {
    if (this.aborted || !this.opts.msgId) return;

    if (ev.type === 'text_delta' && ev.text) {
      if (this.afterTool) { this.fullText += '\n'; this.afterTool = false; }
      this.buffer += ev.text;
      this.fullText += ev.text;
      this.appendSegmentText(ev.text);
      if (this.buffer.length >= this.flushThreshold) this.enqueueFlush();
      else this.scheduleTimer();
    } else if (ev.type === 'tool_use' && ev.tool) {
      if (this.sendSegments) {
        // A tool call is progress the reader wants IMMEDIATELY, at `running` — that is the whole
        // point of the pill. So it flushes rather than waiting for the text threshold.
        if (this.toolCount < MAX_TOOL_SEGMENTS) {
          const id = ev.toolUseId || `tool_${this.toolCount}`;
          const info: ToolCallInfo = { id, tool: ev.tool.slice(0, 200), status: 'running', ...(clampArgs(ev.input) ? { args: clampArgs(ev.input) } : {}) };
          this.toolById.set(id, info);
          this.segments.push({ type: 'tool', tool: info });
        }
        this.toolCount++;
        this.enqueueFlush();
      } else if (this.toolMarkers) {
        // In-band, transient: `finish()` sends the clean final text, which replaces the row wholesale
        // (para-li writes the whole row), so the marker disappears on its own.
        this.afterTool = true;
        this.fullText += `\n\n_🔧 ${ev.tool.slice(0, 200)}_\n\n`;
        this.enqueueFlush();
      }
    } else if (ev.type === 'tool_result' && this.sendSegments && ev.toolUseId) {
      const info = this.toolById.get(ev.toolUseId);
      // A result for a call past MAX_TOOL_SEGMENTS (or for one we never saw) has nothing to settle;
      // dropping it is correct — inventing a segment for it would put the pill out of order.
      if (!info) return;
      info.status = ev.isError ? 'error' : 'completed';
      if (ev.output) info.result = clampText(ev.output, MAX_TOOL_RESULT_CHARS);
      this.enqueueFlush();
    }
  }

  /** Grow the trailing text segment, or start one. Mirrors `buildSegmentHost` in para-li's own
   *  `lib/para-agent.ts` — consecutive text stays ONE segment, so the pills sit between paragraphs
   *  instead of shredding the answer into a segment per delta. */
  private appendSegmentText(text: string): void {
    if (!this.sendSegments) return;
    const last = this.segments[this.segments.length - 1];
    if (last && last.type === 'text') last.content += text;
    else this.segments.push({ type: 'text', content: text });
  }

  /** A deep copy with empty text segments dropped. Deep because `toolById` holds live references
   *  into `segments`: a flush snapshot that shared them would be MUTATED by a later `tool_result`
   *  while its POST was still in flight, so an in-order pair of deltas could show the same call as
   *  `completed` and then `running`. */
  private segmentSnapshot(): MessageSegment[] {
    return this.segments
      .filter((s) => s.type === 'tool' || s.content.trim().length > 0)
      .map((s) => (s.type === 'tool' ? { type: 'tool' as const, tool: { ...s.tool } } : { type: 'text' as const, content: s.content }));
  }

  /** Settle the row with the final text. Returns the text actually sent. */
  async finish(): Promise<string> {
    this.clearTimer();
    this.buffer = '';
    await this.flushChain;
    if (this.aborted || !this.opts.msgId) return this.fullText;
    const text = this.fullText.trim() || '(no output)';
    await postPara(this.opts.callback, {
      type: 'final', convId: this.opts.convId, msgId: this.opts.msgId, text,
      ...(this.sendSegments ? { segments: this.segmentSnapshot() } : {}),
    }, this.postTimeout);
    return text;
  }

  /** Settle the row as a visible failure. The owner sees WHY, in the thread, not only in a log. */
  async fail(message: string): Promise<void> {
    this.aborted = true;
    this.clearTimer();
    await this.flushChain;
    if (!this.opts.msgId) return;
    await postPara(this.opts.callback, { type: 'error', convId: this.opts.convId, msgId: this.opts.msgId, message }, this.postTimeout);
  }

  private enqueueFlush(): void {
    this.clearTimer();
    // `segments` matters here too: a turn that opens with a tool call has produced NO text yet, and
    // the old guard would have swallowed that flush — so the first pill would not appear until the
    // model started talking, and, worse, the delta that bumps para-li's stall watchdog
    // (`lastActivityAt`) would never be sent for a long tool-only stretch.
    if (!this.fullText && !this.segments.length) return;
    this.buffer = '';
    const snapshot = this.fullText;
    const segs = this.sendSegments ? this.segmentSnapshot() : null;
    // Serialized: a later, longer snapshot must never be overtaken by an earlier one, or the row
    // visibly rewinds mid-stream.
    this.flushChain = this.flushChain
      .then(async () => { await postPara(this.opts.callback, { type: 'delta', convId: this.opts.convId, msgId: this.opts.msgId, text: snapshot, ...(segs ? { segments: segs } : {}) }, this.postTimeout); })
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
