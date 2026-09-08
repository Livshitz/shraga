/**
 * Webhook lane — the public extension point for wiring an EXTERNAL CHAT PRODUCT to this agent.
 *
 * The shape of the problem, name-neutrally: some other product holds the conversation UI. It wants
 * to hand this agent one turn and render the answer as it is produced. It cannot hold an HTTP
 * response open for the minutes an agent run takes, and it needs the answer authenticated when it
 * comes back. So the lane is TWO independent requests:
 *
 *   1. INGRESS  — the product POSTs one turn to a route THIS module mounts for you.
 *   2. CALLBACK — this agent POSTs the answer back, progressively, to a URL the product supplied
 *                 IN that turn, each delivery HMAC-signed with a secret the product supplied too.
 *
 * The core registers NOTHING here, exactly as in `features.ts`. It ships the machinery — the signed
 * transport, the flush/coalescing policy, the segment wire shape, and the turn-ingress contract —
 * and an add-on names its own product:
 *
 * ```ts
 * import { registerFeature } from 'shraga/server/features';
 * import { createWebhookLaneFeature } from 'shraga/server/webhook-lane/feature';
 *
 * registerFeature(createWebhookLaneFeature({
 *   name: 'acme',
 *   route: '/api/acme/turn',
 *   onTurnAccepted: (link) => rememberLink(link),   // your persistence, your policy
 * }));
 * ```
 *
 * WHAT THE ADD-ON OWNS, and why the core cannot: where links are persisted and under what filename,
 * which links may receive PROACTIVE posts (an owner-notice policy is a product decision — see
 * `postNotice` in `streamer.ts` for the transport), the route path, and any CLI surface. None of
 * that is generalizable without inventing policy, so the seam hands it back.
 *
 * TRUST. The ingress is authenticated with an ordinary shraga API key (`POST /api/api-keys`), so
 * reaching the route requires a credential the owner minted. The callback URL + secret arrive IN
 * that authenticated request — per turn — which is what makes a rotated webhook secret take effect
 * on the very next message with no configuration on this side. The URL is still validated here
 * (https, or loopback for development) rather than trusted because the request authenticated: we
 * hold the owner's credential and will POST to whatever it names.
 */
import crypto from 'node:crypto';
import type { ServerFeature, FeatureContext } from '../features.ts';
import { streamChat } from '../claude.ts';
import { getMcpConfig } from '../mcp.ts';
import {
  appendMessage, upsertSession, setRunStatus, acquireSessionLock, releaseSessionLock,
  type ConvBlock,
} from '../sessions.ts';
import { validateApiKey } from '../api-keys.ts';
import { WebhookStreamer, type WebhookTarget } from './streamer.ts';

/** One receiver connection, as learned from a turn. Handed to `onTurnAccepted` so an add-on can
 *  persist it and later reach the same conversation proactively.
 *
 *  `uid` is the shraga user whose API key opened this link, and `email` is that user's address,
 *  taken from `validateApiKey` and never from the request body. An add-on that fans PROACTIVE
 *  notices out to "owners" must join on the email — a uid does not join to an owner list. */
export type WebhookLaneLink = WebhookTarget & { convId: string; at: number; uid: string; email?: string };

export interface WebhookLaneOptions {
  /** Feature name (must be unique in the registry). Also the default transcript `channel` and
   *  turn-context `source` tag, so a one-line registration is coherent. */
  name: string;
  /** Absolute ingress path to mount, e.g. `/api/acme/turn`. Named by the add-on: the core must not
   *  contain a product's route. */
  route: string;
  /** Transcript channel tag stamped on the user message. Defaults to `name`. */
  channel?: string;
  /** `context.source` handed to the turn-context seam. Defaults to `name`. */
  source?: string;
  /**
   * Called once per ACCEPTED turn, before the run starts, with the connection this turn negotiated.
   * This is the add-on's chance to persist the link for its proactive lane.
   *
   * NOTIFICATION, NOT A GATE — and deliberately so. Whether a `connId` may be re-pointed at a
   * different user's callback is the add-on's model, so the add-on refuses the WRITE inside this
   * hook; the turn itself still runs and still answers on the callback the caller supplied, because
   * that caller authenticated with their own API key and is entitled to their own answer. Throwing
   * is contained: a broken persistence layer must not cost the user their reply.
   */
  onTurnAccepted?(link: WebhookLaneLink): void;
  /** Streamer knobs, if the defaults in `streamer.ts` do not suit the receiver. */
  streamer?: { flushInterval?: number; flushThreshold?: number; postTimeout?: number };
}

/** The ingress body, as it arrives on the wire. This IS the contract a receiver implements. */
export interface TurnRequestBody {
  /** Stable id for the receiver connection. Inside the signed material of every callback. */
  connId?: string;
  /** The receiver's conversation id. Echoed on every callback. */
  convId?: string;
  /** Agent session to run in. Defaults to `convId`, so a receiver may omit it entirely. */
  sessionId?: string;
  /** The row to patch with the answer. The receiver mints it before calling. */
  msgId?: string;
  prompt?: string;
  callback?: { url?: string; secret?: string };
  /** Receiver capability negotiation. `'segments'` means "I can store and render structured tool
   *  segments" — see `WebhookStreamerOptions.sendSegments`. ABSENT means no, and the receiver gets
   *  the flattened in-text tool markers instead. A list, so it can grow without a new field. */
  accepts?: unknown;
}

/** Run one turn, streaming into the receiver's row. Errors settle the row VISIBLY — a reader must
 *  never be left watching a "typing…" placeholder that will never resolve. Exported so an add-on
 *  with its own ingress (a queue consumer, say) can reuse the run half without the route half. */
export async function runWebhookTurn(args: {
  callback: WebhookTarget; convId: string; msgId: string; sessionId: string; prompt: string;
  uid: string; userEmail: string; sendSegments: boolean;
  channel: string; source: string;
  streamer?: WebhookLaneOptions['streamer'];
}): Promise<void> {
  const { callback, convId, msgId, sessionId, prompt, uid, userEmail, sendSegments, channel, source } = args;
  const streamer = new WebhookStreamer({ callback, convId, msgId, sendSegments, ...(args.streamer ?? {}) });
  const abortController = new AbortController();

  // Lock origin is 'api': the union in sessions.ts is a closed set ('web'|'slack'|'scheduler'|
  // 'api') and this is an authenticated API caller. Widening it just to label the medium would
  // touch recovery and status code paths for no behavioural gain.
  if (!acquireSessionLock(sessionId, 'api', abortController)) {
    // sessionId defaults to convId, so this is genuinely "you sent two messages into the same
    // thread while the first was still running". Say so rather than dropping it silently.
    await streamer.fail('That conversation is already processing a message — wait for it to finish.');
    return;
  }
  upsertSession(sessionId, prompt, { uid, email: userEmail });
  appendMessage(sessionId, { id: crypto.randomUUID(), role: 'user', blocks: [{ type: 'text', text: prompt }], channel });
  setRunStatus(sessionId, 'running', 'web');

  const blocks: ConvBlock[] = [];
  let text = '';
  try {
    for await (const ev of streamChat({
      prompt, sessionId, uid, userEmail,
      mcpServers: getMcpConfig(uid),
      abortController,
      context: { source, user: userEmail },
      onPermissionRequest: async () => ({ allow: true }),
    })) {
      if (ev.type === 'text_delta') { text += ev.text; streamer.feed({ type: 'text_delta', text: ev.text }); }
      else if (ev.type === 'tool_use') {
        if (text) { blocks.push({ type: 'text', text }); text = ''; }
        blocks.push({ type: 'tool_use', tool: ev.tool, toolUseId: ev.toolUseId, input: ev.input });
        streamer.feed({ type: 'tool_use', tool: ev.tool, toolUseId: ev.toolUseId, input: ev.input });
      }
      else if (ev.type === 'tool_result') {
        blocks.push({ type: 'tool_result', toolUseId: ev.toolUseId, output: ev.output });
        // The `running` → `completed`/`error` transition. Fed unconditionally; the streamer ignores
        // it unless the receiver negotiated segments.
        streamer.feed({ type: 'tool_result', toolUseId: ev.toolUseId, output: ev.output, isError: ev.isError });
      }
      else if (ev.type === 'done') break;
      else if (ev.type === 'error') {
        if (text) { blocks.push({ type: 'text', text }); text = ''; }
        blocks.push({ type: 'error', text: ev.message });
        await streamer.fail(ev.message);
        return;
      }
    }
    if (text) blocks.push({ type: 'text', text });
    await streamer.finish();
  } catch (err) {
    console.error(`[${channel}] turn failed:`, (err as Error).message);
    await streamer.fail((err as Error).message || 'agent error');
  } finally {
    // The transcript is persisted whatever happened, so the shraga UI and the next turn's context
    // see the same history the receiver saw.
    if (blocks.length) appendMessage(sessionId, { id: crypto.randomUUID(), role: 'assistant', blocks });
    if (releaseSessionLock(sessionId, abortController)) setRunStatus(sessionId, 'idle');
  }
}

/**
 * Build a `ServerFeature` that mounts one turn ingress. Register it with `registerFeature()`.
 *
 * No capability flag is declared: `flags` tells the CLIENT that a surface exists, and this lane is
 * driven entirely by the external product calling in — nothing in the client gates on it. An add-on
 * that DOES have a client surface can declare its own flag by spreading this feature.
 */
export function createWebhookLaneFeature(opts: WebhookLaneOptions): ServerFeature {
  const channel = opts.channel ?? opts.name;
  const source = opts.source ?? opts.name;
  // Per-INSTANCE, not module-global: two lanes may be registered, and a shared guard would let the
  // first one mounted silence the second.
  let mounted = false;

  return {
    name: opts.name,

    register(ctx: FeatureContext): void {
      if (ctx.passive || mounted) return;
      mounted = true;

      ctx.app.post(opts.route, (req, res) => {
        const bearer = /^Bearer\s+(.+)$/i.exec(req.get('authorization') ?? '')?.[1];
        const caller = bearer ? validateApiKey(bearer) : null;
        if (!caller) return void res.status(401).json({ error: 'unauthorized' });

        const { connId, convId, sessionId, msgId, prompt, callback, accepts } = req.body as TurnRequestBody;
        if (!connId || !convId || !msgId || !prompt) return void res.status(400).json({ error: 'connId, convId, msgId and prompt are required' });
        if (!callback?.url || !callback?.secret) return void res.status(400).json({ error: 'callback.url and callback.secret are required' });
        try {
          const u = new URL(callback.url);
          if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') throw new Error('https required');
        } catch { return void res.status(400).json({ error: 'callback.url must be a valid HTTPS URL' }); }

        const cb: WebhookTarget = { url: callback.url, secret: callback.secret, connId };
        try {
          opts.onTurnAccepted?.({ ...cb, convId, at: Date.now(), uid: caller.uid, email: caller.email });
        } catch (err) {
          console.warn(`[${opts.name}] onTurnAccepted threw:`, (err as Error).message);
        }

        // ACCEPT, then run. The answer arrives on the callback, so holding this response open would
        // only give the caller's trigger a socket to time out on.
        res.json({ status: 'accepted', sessionId: sessionId || convId });
        void runWebhookTurn({
          callback: cb, convId, msgId, sessionId: sessionId || convId, prompt,
          uid: caller.uid, userEmail: caller.email,
          sendSegments: Array.isArray(accepts) && accepts.includes('segments'),
          channel, source, streamer: opts.streamer,
        });
      });

      console.log(`[${opts.name}] turn ingress mounted at POST ${opts.route}`);
    },
  };
}
