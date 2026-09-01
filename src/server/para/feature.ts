/**
 * paraFeature — the sender half of the para-li external-agent lane.
 *
 * Mirrors `slackFeature` exactly in shape: one `ServerFeature` that (a) mounts an ingress route and
 * (b) subscribes the owner-notice event bus so deploy / self-upgrade / downtime notices reach the
 * medium. Slack is untouched and the two coexist — both subscribe the same bus, neither knows about
 * the other, and a notice is delivered to each independently.
 *
 * TRANSPORT. para-li POSTs one turn here and we stream the answer BACK to it over signed webhook
 * calls (see `streamer.ts`), rather than holding this response open. para-li's caller is a Bodify
 * trigger whose lifetime is the turn, so a multi-minute agent run held on one response body dies to
 * a proxy idle timeout with a half-written row. Two independent requests also give the proactive
 * lane the same transport for free.
 *
 * TRUST. The turn request is authenticated with an ordinary shraga API key (`POST /api/api-keys`),
 * so reaching this route requires a credential the owner minted. The callback URL + secret arrive
 * IN that authenticated request — para-li tells us where to answer and with what, per turn, which
 * is what makes a rotated webhook secret take effect on the very next message with no config here.
 */
import type { ServerFeature, FeatureContext } from '../features.ts';
import crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { subscribeEvents } from '../events/bus.ts';
import { streamChat } from '../claude.ts';
import { getMcpConfig } from '../mcp.ts';
import { dataPath } from '../paths.ts';
import {
  appendMessage, upsertSession, setRunStatus, acquireSessionLock, releaseSessionLock,
  type ConvBlock,
} from '../sessions.ts';
import { validateApiKey } from '../api-keys.ts';
import { isOwnerEmail } from '../notify-owners.ts';
import { ParaStreamer, postProactive, type ParaCallback } from './streamer.ts';

interface DeployNotice { kind: 'deploy'; owners: { name?: string; slackId: string }[]; text: string }

/** Last known para conversation per connection — the proactive lane's destination.
 *
 *  Learned from the first turn rather than configured: para-li already tells us the conv and the
 *  callback on every turn, so a second source of truth would only be a thing to drift. Persisted
 *  because a deploy notice fires right after a RESTART, which is exactly when an in-memory map is
 *  empty — the one moment the feature has to work. Lives beside `api-keys.json` in the data dir and
 *  holds the webhook secret, so it inherits that file's protection, no more and no less. */
const LINKS_PATH = dataPath('para-links.json');
/** `uid` is the shraga user whose API key opened this link. It is the OWNER of the entry — see
 *  `rememberLink`.
 *
 *  `email` is that user's address, recorded so the PROACTIVE lane can answer "is this link's user
 *  an owner of this deployment?" — `OWNERS` is an email list, and a uid does not join to it. It is
 *  taken from `validateApiKey`, never from the request body. A link written before this field
 *  existed has no email and is therefore not an owner: it receives no notices until its next turn
 *  refreshes the entry. */
export type Link = ParaCallback & { convId: string; at: number; uid: string; email?: string };

export function loadLinks(): Record<string, Link> {
  if (!existsSync(LINKS_PATH)) return {};
  try { return JSON.parse(readFileSync(LINKS_PATH, 'utf-8')); } catch (err) {
    console.warn('[para] links file unreadable, starting empty:', (err as Error).message);
    return {};
  }
}
/** Record (or refresh) a connection's callback.
 *
 *  ONE USER OWNS A connId. `connId` is chosen by the caller, so without this an API key for user A
 *  could claim a connId already linked by user B and re-point every future PROACTIVE notice
 *  (deploy reports, self-upgrade outcomes) at A's URL + secret. An API key is already full agent
 *  access to its own user, so this is not a privilege boundary being invented — it is the one
 *  cross-user step that access does not otherwise imply, so it is refused rather than logged. */
function rememberLink(link: Link): void {
  try {
    const all = loadLinks();
    const prev = all[link.connId];
    if (prev?.uid && prev.uid !== link.uid) {
      console.warn(`[para] refusing to re-link ${link.connId}: owned by another user`);
      return;
    }
    all[link.connId] = link;
    mkdirSync(dataPath(''), { recursive: true });
    writeFileSync(LINKS_PATH, JSON.stringify(all, null, 2));
  } catch (err) {
    console.warn('[para] could not persist link:', (err as Error).message);
  }
}

/** Run one turn, streaming into the para row. Errors settle the row visibly — the owner must never
 *  be left watching a "typing…" placeholder that will never resolve. */
async function runParaTurn(args: {
  callback: ParaCallback; convId: string; msgId: string; sessionId: string; prompt: string;
  uid: string; userEmail: string; sendSegments: boolean;
}): Promise<void> {
  const { callback, convId, msgId, sessionId, prompt, uid, userEmail, sendSegments } = args;
  const streamer = new ParaStreamer({ callback, convId, msgId, sendSegments });
  const abortController = new AbortController();

  // Lock origin is 'api': the union in sessions.ts is a closed set ('web'|'slack'|'scheduler'|
  // 'api') and this is an authenticated API caller. Widening it just to label the medium would
  // touch recovery and status code paths for no behavioural gain.
  if (!acquireSessionLock(sessionId, 'api', abortController)) {
    // sessionId === convId, so this is genuinely "you sent two messages into the same thread while
    // the first was still running". Say so rather than dropping it silently.
    await streamer.fail('That conversation is already processing a message — wait for it to finish.');
    return;
  }
  upsertSession(sessionId, prompt, { uid, email: userEmail });
  appendMessage(sessionId, { id: crypto.randomUUID(), role: 'user', blocks: [{ type: 'text', text: prompt }], channel: 'para' });
  setRunStatus(sessionId, 'running', 'web');

  const blocks: ConvBlock[] = [];
  let text = '';
  try {
    for await (const ev of streamChat({
      prompt, sessionId, uid, userEmail,
      mcpServers: getMcpConfig(uid),
      abortController,
      context: { source: 'para', user: userEmail },
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
    console.error('[para] turn failed:', (err as Error).message);
    await streamer.fail((err as Error).message || 'agent error');
  } finally {
    // The transcript is persisted whatever happened, so the shraga UI and the next turn's context
    // see the same history para saw.
    if (blocks.length) appendMessage(sessionId, { id: crypto.randomUUID(), role: 'assistant', blocks });
    if (releaseSessionLock(sessionId, abortController)) setRunStatus(sessionId, 'idle');
  }
}

let mounted = false;
let busSubscribed = false;

export const paraFeature: ServerFeature = {
  name: 'para',

  // No capability flag. `flags` is the seam's way to tell the CLIENT a surface exists, and nothing
  // in the client gates on para — the lane is driven entirely by para.li calling in. Declaring one
  // would be dead public surface on /api/features (slackFeature declares none for the same reason).

  register(ctx: FeatureContext): void {
    // Owner notices → the linked para conversations OF THIS DEPLOYMENT'S OWNERS. Keyed on the
    // notice KIND, not the source, for the reason spelled out in slackFeature: self-upgrade emits
    // under its own source and a source-gated subscriber silently dropped every one of them.
    //
    // WHY NOT `payload.owners`. That field is `{name?, slackId}[]` — the SLACK join, computed by
    // `resolveOwners` as OWNERS ∩ contacts-that-have-a-Slack-id. A para link carries no Slack id,
    // so the field is unmatchable here. Unfiltered, this loop posted every deploy / self-upgrade /
    // data-sync report to EVERY entry in para-links.json — and any shraga user with an API key
    // gets an entry on their first turn (`rememberLink`). The `uid` guard does not help: it stops
    // STEALING another user's connId, not adding your own.
    // The join that works is the one OWNERS is actually expressed in — the email of the API key
    // that opened the link — checked with the same `isOwnerEmail` that backs `resolveOwners`.
    if (!ctx.passive && !busSubscribed) {
      busSubscribed = true;
      subscribeEvents((evt) => {
        const payload = evt.payload as DeployNotice;
        if (payload?.kind !== 'deploy' || !payload.text) return;
        for (const link of Object.values(loadLinks())) {
          if (!isOwnerEmail(link.email)) continue;
          postProactive({ url: link.url, secret: link.secret, connId: link.connId }, link.convId, payload.text)
            .then((ok) => console.log(`[para] owner notice ${ok ? 'delivered' : 'FAILED'} → ${link.convId}`))
            .catch((err) => console.warn('[para] owner notice failed:', (err as Error).message));
        }
      });
    }

    if (ctx.passive || mounted) return;
    mounted = true;

    ctx.app.post('/api/para/turn', (req, res) => {
      const bearer = /^Bearer\s+(.+)$/i.exec(req.get('authorization') ?? '')?.[1];
      const caller = bearer ? validateApiKey(bearer) : null;
      if (!caller) return void res.status(401).json({ error: 'unauthorized' });

      const { connId, convId, sessionId, msgId, prompt, callback, accepts } = req.body as {
        connId?: string; convId?: string; sessionId?: string; msgId?: string; prompt?: string;
        callback?: { url?: string; secret?: string };
        /** Receiver capability negotiation. `'segments'` means "I can store and render structured
         *  tool segments" — see `ParaStreamerOptions.sendSegments`. ABSENT means no: a para-li that
         *  predates this field, and a lane (groups) that deliberately declines, both fall back to
         *  the flattened `_🔧 Tool_` markers in the text. */
        accepts?: unknown;
      };
      if (!connId || !convId || !msgId || !prompt) return void res.status(400).json({ error: 'connId, convId, msgId and prompt are required' });
      if (!callback?.url || !callback?.secret) return void res.status(400).json({ error: 'callback.url and callback.secret are required' });
      try {
        const u = new URL(callback.url);
        // We hold the owner's credential and will POST to whatever this says, so it is validated
        // here too rather than trusted because the request authenticated.
        if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') throw new Error('https required');
      } catch { return void res.status(400).json({ error: 'callback.url must be a valid HTTPS URL' }); }

      const cb: ParaCallback = { url: callback.url, secret: callback.secret, connId };
      rememberLink({ ...cb, convId, at: Date.now(), uid: caller.uid, email: caller.email });

      // ACCEPT, then run. The answer arrives on the callback, so holding this response open would
      // only give para-li's trigger a socket to time out on.
      res.json({ status: 'accepted', sessionId: sessionId || convId });
      void runParaTurn({
        callback: cb, convId, msgId, sessionId: sessionId || convId, prompt,
        uid: caller.uid, userEmail: caller.email,
        sendSegments: Array.isArray(accepts) && accepts.includes('segments'),
      });
    });

    console.log('[para] turn ingress mounted at POST /api/para/turn');
  },
};
