// Slack agent-glue — the app-side half of the Slack bot. The Slack transport/protocol (routes, HMAC
// verify, dedupe, DM identity, file hydrate, streamer wiring, reaction lifecycle) lives in the
// mcp-slack-use package `ingress`. This module owns only what this app owns: sessions, locks, contacts,
// thread-context sync, artifacts, broadcast, and message persistence — surfaced to the ingress as
// callbacks (shouldRespond / onMessage / onReplied) plus the crash-recovery resume path.
import crypto from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { streamChat, type AttachmentMeta, type WsEvent } from '../claude.ts';
import { handleArtifactToolUse } from '../artifacts/artifacts.handler.ts';
import { getMcpConfig } from '../mcp.ts';
import { dataPath } from '../paths.ts';
import { appendMessage, setSlackContext, setRunStatus, setVisibleTo, writePartial, clearPartial, registerLivePartial, unregisterLivePartial, acquireSessionLock, releaseSessionLock, getSession, recordSeenSlackTs, type ConvBlock, type SessionMeta } from '../sessions.ts';
import { injectFile } from '../file-inject.ts';
import {
  postMessage, addReaction, removeReaction, getBotUserId, getAgentUserId, getThreadMessages, getMessage,
  getChannelName, getUserName, getUserProfile, resolveUserMentions, isSupportedFile, SUPPORTED_FILE_MIMES,
  downloadSlackFileBuffer,
} from './api.ts';
import { pipeAgentReply, type AgentEvent, type IngressMessage } from 'mcp-slack-use/src/ingress.ts';
import { makeSlackQuestionHandler } from './questions.ts';
import * as contacts from '../contacts.ts';
import { getChannelContext, invalidateChannelContext } from './context-cache.ts';
import { getOrCreateSession, registerThreadAlias, setLastMessageTs, setUseUserToken, findSlackSessionBySessionId, getProactiveOrigin, hasSessionForThread, isSlackBotPlaceholderEmail } from './sessions.ts';

const MAX_DOWNLOAD_SIZE = 25 * 1024 * 1024;
const isDownloadable = (f: { url_private?: string; mimetype?: string; size?: number; name?: string }): boolean =>
  !!(f.url_private && f.mimetype) &&
  (isSupportedFile(f as any) || (!SUPPORTED_FILE_MIMES.has(f.mimetype) && (f.size ?? 0) <= MAX_DOWNLOAD_SIZE));

// The "agent channel" gets summon rules beyond @mentions (auto-respond / owned-thread follow-ups).
// Configure per workspace via SLACK_AGENT_CHANNEL (a channel id); empty means no special channel,
// so a drop-in bot responds only to @mentions and DMs.
const AGENT_CHANNEL = process.env.SLACK_AGENT_CHANNEL || '';
const SLACK_UID = 'slack-bot';

type Broadcast = (data: object) => void;
let broadcastFn: Broadcast = () => {};
export function setBroadcast(fn: Broadcast): void { broadcastFn = fn; }

const mdText = (b: ConvBlock): b is { type: 'text'; text: string } => b.type === 'text';

// ── Semantic gate ─────────────────────────────────────────────────────────────
// Protocol-level routing (bot echoes, DM identity, dedupe) is the ingress's job. This is the app-side
// half: agent-channel summon rules + threads the agent already owns. Referenced app session state
// (proactive origins, known threads) is why it can't live in the package.
export function shouldRespond(msg: IngressMessage): boolean {
  const isAgentChannel = msg.channel === AGENT_CHANNEL;
  const isAgentOriginatedThread = msg.isThreadReply && !!(msg.rawThreadTs && getProactiveOrigin(msg.channel, msg.rawThreadTs));
  const isKnownAgentChannelThread = isAgentChannel && msg.isThreadReply && !!(msg.rawThreadTs && hasSessionForThread(msg.channel, msg.rawThreadTs));
  if (isAgentChannel && msg.isThreadReply && !msg.isMention && !msg.textMentionsAgent && !isAgentOriginatedThread && !isKnownAgentChannelThread) {
    console.log(`[slack-bot] Skipping thread reply without mention in agent channel (user=${msg.user} thread=${msg.rawThreadTs})`);
    return false;
  }
  const agentChannelAutoRespond = process.env.SLACK_AGENT_CHANNEL_AUTORESPOND === '1';
  const isAgentChannelSummon = isAgentChannel && (agentChannelAutoRespond || isKnownAgentChannelThread);
  if (!(isAgentChannelSummon || msg.isMention || msg.textMentionsAgent || msg.isDM || isAgentOriginatedThread)) return false;
  return true;
}

// ── Shared stream pump ─────────────────────────────────────────────────────────
// Drive a streamChat generator: accumulate assistant blocks, mirror to the web UI via broadcast,
// yield the events the SlackStreamer consumes (text_delta / tool_use), then persist the assistant
// message. The ingress finishes the streamer after this generator returns.
async function* pumpStream(
  gen: AsyncGenerator<WsEvent>,
  sessionId: string,
  opts: { partial?: boolean; artifacts?: boolean } = {},
): AsyncGenerator<AgentEvent> {
  let assistantText = '';
  const assistantBlocks: ConvBlock[] = [];
  const collect = () => [...assistantBlocks, ...(assistantText ? [{ type: 'text' as const, text: assistantText }] : [])];
  let partialInterval: ReturnType<typeof setInterval> | undefined;
  if (opts.partial) {
    registerLivePartial(sessionId, collect);
    partialInterval = setInterval(() => { const b = collect(); if (b.length) writePartial(sessionId, b); }, 5_000);
  }
  let stopReason = '';
  try {
    for await (const ev of gen) {
      if (ev.type === 'text_delta') {
        assistantText += ev.text;
        broadcastFn({ type: 'session_stream', sessionId, event: { type: 'text_delta', text: ev.text } });
        yield { type: 'text_delta', text: ev.text };
      } else if (ev.type === 'tool_use') {
        if (assistantText) { assistantBlocks.push({ type: 'text', text: assistantText }); assistantText = ''; }
        assistantBlocks.push({ type: 'tool_use', tool: ev.tool, toolUseId: ev.toolUseId, input: ev.input });
        broadcastFn({ type: 'session_stream', sessionId, event: { type: 'tool_use', tool: ev.tool, toolUseId: ev.toolUseId, input: ev.input } });
        if (opts.artifacts) { const e = handleArtifactToolUse(sessionId, ev.tool, ev.input); if (e) broadcastFn(e); }
        yield { type: 'tool_use', tool: ev.tool, toolUseId: ev.toolUseId, input: ev.input };
      } else if (ev.type === 'tool_result') {
        assistantBlocks.push({ type: 'tool_result', toolUseId: ev.toolUseId, output: ev.output });
        const trimmed = ev.output.length > 2000 ? ev.output.slice(0, 2000) + '…' : ev.output;
        broadcastFn({ type: 'session_stream', sessionId, event: { type: 'tool_result', toolUseId: ev.toolUseId, output: trimmed } });
      } else if (ev.type === 'tool_result_image') {
        assistantBlocks.push({ type: 'image', src: ev.dataUrl });
      } else if (ev.type === 'done') {
        stopReason = ev.stopReason ?? 'end_turn';
        break;
      } else if (ev.type === 'error') {
        const t = `\n⚠️ ${ev.message}`;
        assistantText += t;
        yield { type: 'text_delta', text: t };
        break;
      }
    }
    if (stopReason === 'max_turns_reached') {
      const notice = '\n\n---\n⚠️ _Reached the maximum number of steps for this turn. Reply "continue" to pick up where I left off._';
      assistantText += notice;
      yield { type: 'text_delta', text: notice };
    }
  } finally {
    if (partialInterval) clearInterval(partialInterval);
    if (opts.partial) unregisterLivePartial(sessionId);
  }

  if (assistantText) assistantBlocks.push({ type: 'text', text: assistantText });
  for (const b of assistantBlocks) if (mdText(b)) (b as any).text = await resolveUserMentions(b.text);
  if (assistantBlocks.length) {
    if (opts.partial) clearPartial(sessionId);
    appendMessage(sessionId, { id: crypto.randomUUID(), role: 'assistant', blocks: assistantBlocks });
    broadcastFn({ type: 'session_messages_changed', sessionId });
  }
}

// ── onMessage: one agent turn as an AsyncIterable<AgentEvent> ──────────────────────
export async function* runAgentTurn(msg: IngressMessage): AsyncGenerator<AgentEvent> {
  const channel = msg.channel;
  const isDM = msg.isDM;
  const threadTs = msg.threadTs;
  const useUserToken = msg.useUserToken;

  const botId = await getBotUserId();
  const agentUserId = await getAgentUserId();
  let text = (msg.text || '').replace(new RegExp(`<@${botId}>\\s*`, 'g'), '').trim();
  if (agentUserId) text = text.replace(new RegExp(`<@${agentUserId}>\\s*`, 'g'), '').trim();

  // Files are already hydrated by the ingress; this app downloads + saves them into the session dir.
  const files = msg.files;
  const downloadableFiles = files.filter(isDownloadable);
  const skippedFiles = files.filter((f: any) => !isDownloadable(f));
  if (skippedFiles.length) {
    const labels = skippedFiles.map((f: any) => f.mimetype
      ? `[Attached file: ${f.name} (${f.mimetype}, ${Math.round(f.size / 1024)}KB) — too large to download]`
      : `[Attached file: could not be retrieved from Slack]`);
    text = text ? `${text}\n${labels.join('\n')}` : labels.join('\n');
  }
  if (!text && !downloadableFiles.length) return;

  const downloadedFiles = downloadableFiles.length
    ? (await Promise.all(downloadableFiles.map(async (f: any) => {
        const allowHtml = f.mimetype === 'text/html' || /\.html?$/i.test(f.name);
        try { return { buffer: await downloadSlackFileBuffer(f.url_private, useUserToken, allowHtml), name: f.name, mimeType: f.mimetype }; }
        catch (err: any) { console.warn(`[slack-bot] File download failed: ${err.message}`); return null; }
      }))).filter((f): f is { buffer: Buffer; name: string; mimeType: string } => !!f)
    : [];
  if (!text && !downloadedFiles.length) return;
  if (!text) text = 'Describe this attachment.';

  const userMessageTs = msg.ts;
  const isAgentChannel = channel === AGENT_CHANNEL;
  const isMention = msg.isMention;
  const resolvedText = await resolveUserMentions(text);

  // Attribute the session to the real human (enables nightly reconcile user-scope writes).
  let contact: contacts.Contact | null = null;
  if (msg.user) {
    const profile = await getUserProfile(msg.user).catch(err => { console.error('[slack-bot] getUserProfile failed:', err.message); return { name: null, email: null }; });
    contact = contacts.upsert({ slackId: msg.user, email: profile.email || undefined, name: profile.name || undefined });
  }
  const sessionUser = contact?.emails.length ? { uid: contact.id, email: contact.emails[0], name: contact.name } : undefined;

  let isNew: boolean;
  let sessionId: string;
  ({ sessionId, isNew } = getOrCreateSession(channel, threadTs, resolvedText, false, isDM ? 'user' : 'system', sessionUser));
  msg.sessionId = sessionId;

  if (isNew && isDM && contact?.emails.length) setVisibleTo(sessionId, contact.emails);

  if (isNew) {
    const ctxType = isDM ? 'dm' as const : isMention ? 'mention' as const : 'channel' as const;
    const [channelName, channelCtx] = await Promise.all([
      isDM ? null : getChannelName(channel).catch(err => { console.error('[slack-bot] getChannelName failed:', err.message); return null; }),
      isDM ? null : getChannelContext(channel).catch(err => { console.error('[slack-bot] getChannelContext failed:', err.message); return null; }),
    ]);
    const userName = contact?.name || null;
    const resolvedChannel = isDM ? undefined : (channelName || undefined);
    setSlackContext(sessionId, { type: ctxType, ...(resolvedChannel ? { channelName: resolvedChannel } : {}), ...(userName ? { userName } : {}) });
    if (channelCtx) {
      const label = isMention && !isAgentChannel
        ? `@mentioned in${channelName ? ` #${channelName}` : ' channel'}`
        : `#${channelName || 'channel'} context`;
      appendMessage(sessionId, {
        id: crypto.randomUUID(), role: 'user',
        blocks: [{ type: 'context', label, text: `${channelCtx}\n\n[Use mcp-slack-use tools (get_slack_history_by_channel, post_slack_message) for further context or replies. Always read channel history before posting.]` }],
      });
    }
  }

  // Sync the live Slack thread into context on every reply — sibling bot messages from other
  // sessions in the same human-visible thread are invisible to this session's JSONL. Dedup by ts.
  if (msg.rawThreadTs) {
    const threadMsgs = await getThreadMessages(channel, msg.rawThreadTs, useUserToken).catch(err => {
      console.error(`[slack] Failed to fetch thread messages for ${channel}:${msg.rawThreadTs}:`, err?.message || err);
      return [];
    });
    if (threadMsgs.length > 0) {
      const seen = new Set(getSession(sessionId)?.seenSlackTs ?? []);
      const seedOnly = !isNew && seen.size === 0;
      const processedTs: string[] = [];
      for (const m of threadMsgs) {
        if (m.ts) processedTs.push(m.ts);
        if (m.ts === msg.ts || (m.ts && seen.has(m.ts)) || seedOnly) continue;
        const isBot = m.bot_id || m.user === botId || (agentUserId && m.user === agentUserId);
        const role = isBot ? 'assistant' : 'user';
        let msgText = (m.text || '').replace(new RegExp(`<@${botId}>\\s*`, 'g'), '').trim();
        if (agentUserId) msgText = msgText.replace(new RegExp(`<@${agentUserId}>\\s*`, 'g'), '').trim();
        if (!msgText) continue;
        const resolved = await resolveUserMentions(msgText);
        const speakerName = !isBot && m.user ? await getUserName(m.user).catch(() => null) : null;
        const prefixed = speakerName ? `[${speakerName}]: ${resolved}` : resolved;
        appendMessage(sessionId, { id: crypto.randomUUID(), role, blocks: [{ type: 'text', text: prefixed }], channel: 'slack' });
      }
      recordSeenSlackTs(sessionId, [...processedTs, msg.ts]);
    } else if (isNew) {
      const rootText = await getMessage(channel, msg.rawThreadTs, useUserToken).catch(err => {
        console.error(`[slack] Failed to fetch root message for ${channel}:${msg.rawThreadTs}:`, err?.message || err);
        return null;
      });
      if (rootText) {
        let cleanRoot = rootText.replace(new RegExp(`<@${botId}>\\s*`, 'g'), '').trim();
        if (agentUserId) cleanRoot = cleanRoot.replace(new RegExp(`<@${agentUserId}>\\s*`, 'g'), '').trim();
        const resolved = await resolveUserMentions(cleanRoot);
        if (resolved) appendMessage(sessionId, { id: crypto.randomUUID(), role: 'user', blocks: [{ type: 'context', label: 'Thread root message', text: resolved }], channel: 'slack' });
      }
    }
  }

  if (isNew && msg.rawThreadTs) {
    const origin = getProactiveOrigin(channel, msg.rawThreadTs);
    if (origin) {
      const convoPath = dataPath(`conversations/${origin.sessionId}.jsonl`);
      const snippet = injectFile(convoPath, { label: 'origin-conversation', maxChars: 1500, transform: 'conversation' });
      const t = [
        `IMPORTANT: This Slack thread was started by YOU (the agent) during session "${origin.sessionTitle}" (${origin.sessionId}).`,
        `The user is replying to a proactive message you sent. The conversation below is YOUR prior session — treat all facts, data, and statements in it as context you already know.`,
        `If the user asks about something mentioned in that session, answer from this context. For full detail, Read the file path in the snippet tag.`,
        snippet || '(origin conversation not found)',
      ].join('\n');
      appendMessage(sessionId, { id: crypto.randomUUID(), role: 'user', blocks: [{ type: 'context', label: 'Origin', text: t }] });
    }
  }

  const replyCtx = `Slack channel: ${channel}, thread_ts: ${threadTs}`;
  appendMessage(sessionId, {
    id: crypto.randomUUID(), role: 'user',
    blocks: [{ type: 'context', label: 'Slack reply coordinates', text: `${replyCtx}\nYour text responses are AUTOMATICALLY streamed to this Slack conversation — do NOT use post_slack_message to reply. Only use post_slack_files (with these coordinates) to share files/images, or post_slack_message to post in a DIFFERENT channel.` }],
    channel: 'slack',
  });

  // Save downloaded files to data/uploads/{sid}/ (same as the web UI).
  const attachments: AttachmentMeta[] = [];
  if (downloadedFiles.length) {
    const uploadsDir = dataPath(`uploads/${sessionId}`);
    mkdirSync(uploadsDir, { recursive: true });
    for (const f of downloadedFiles) {
      const id = crypto.randomUUID().slice(0, 8);
      const safeName = path.basename(f.name);
      const filename = `${id}-${safeName}`;
      const dest = path.join(uploadsDir, filename);
      writeFileSync(dest, f.buffer);
      attachments.push({ url: `/uploads/${sessionId}/${filename}`, name: safeName, mimeType: f.mimeType, path: dest });
    }
  }

  const userBlocks: ConvBlock[] = [
    ...attachments.map(a => a.mimeType.startsWith('image/')
      ? { type: 'image' as const, src: a.url }
      : { type: 'file' as const, src: a.url, name: a.name, mimeType: a.mimeType }),
    { type: 'text' as const, text: resolvedText },
  ];
  const senderName = contact?.name || contact?.emails[0]?.split('@')[0] || undefined;
  appendMessage(sessionId, { id: crypto.randomUUID(), role: 'user', blocks: userBlocks, channel: 'slack', senderName });
  setLastMessageTs(channel, threadTs, userMessageTs);
  if (useUserToken) setUseUserToken(channel, threadTs, true);

  const mcpServers = getMcpConfig(SLACK_UID);
  const sessionChannelName = getSession(sessionId)?.slackContext?.channelName;
  const triggerContext: Record<string, string> = { source: 'slack' };
  if (isDM) triggerContext.dm = 'true';
  if (sessionChannelName) triggerContext.channel = `#${sessionChannelName}`;
  if (msg.rawThreadTs) triggerContext.thread = msg.rawThreadTs;
  if (contact?.emails[0]) triggerContext.user = contact.emails[0];

  const abortController = new AbortController();
  if (!acquireSessionLock(sessionId, 'slack', abortController)) {
    console.warn(`[slack-bot] Session ${sessionId.slice(0, 8)} already locked, queuing in Slack thread`);
    await postMessage(channel, '⏳ _Session is busy — please wait for the current task to finish._', threadTs, useUserToken);
    msg.sessionId = undefined; // nothing to bookkeep — no reply produced
    return;
  }
  setRunStatus(sessionId, 'running', 'slack');
  broadcastFn({ type: 'session_messages_changed', sessionId });
  broadcastFn({ type: 'session_busy', sessionId, busy: true });

  try {
    yield* pumpStream(
      streamChat({
        prompt: resolvedText,
        attachments: attachments.length ? attachments : undefined,
        sessionId,
        uid: SLACK_UID,
        userEmail: contact?.emails[0],
        userName: contact?.name,
        mcpServers,
        abortController,
        context: triggerContext,
        onPermissionRequest: async () => ({ allow: true }),
        onUserQuestion: makeSlackQuestionHandler({ channel, threadTs, useUserToken }),
      }),
      sessionId,
      { partial: true, artifacts: true },
    );
  } finally {
    if (releaseSessionLock(sessionId, abortController)) {
      setRunStatus(sessionId, 'idle');
      broadcastFn({ type: 'session_busy', sessionId, busy: false });
    }
  }
}

// ── onReplied: post-reply bookkeeping once the streamed reply ts is known ───────
export function onReplied(msg: IngressMessage, replyTs: string | null): void {
  if (!replyTs || !msg.sessionId) return;
  registerThreadAlias(msg.channel, replyTs, msg.sessionId);
  recordSeenSlackTs(msg.sessionId, [replyTs]);
  invalidateChannelContext(msg.channel);
  console.log(`[slack-bot] Reply posted via ${msg.useUserToken ? 'user' : 'bot'} token: ${msg.channel} ts=${replyTs}`);
}

// ── Crash-recovery resume ───────────────────────────────────────────────────────
export async function retrySlackSession(session: SessionMeta, prompt: string): Promise<void> {
  const slackInfo = findSlackSessionBySessionId(session.sessionId);
  if (!slackInfo) {
    console.warn(`[slack-bot] recovery: no slack mapping for ${session.sessionId.slice(0, 8)}`);
    setRunStatus(session.sessionId, 'idle');
    return;
  }
  const { channel, threadTs, lastMessageTs, useUserToken } = slackInfo;
  console.log(`[slack-bot] recovery: retrying ${session.sessionId.slice(0, 8)} in ${channel} (${useUserToken ? 'user' : 'bot'} token)`);

  const recoveryAc = new AbortController();
  if (!acquireSessionLock(session.sessionId, 'slack', recoveryAc)) {
    console.warn(`[slack-bot] recovery: session ${session.sessionId.slice(0, 8)} already locked, skipping`);
    return;
  }
  setRunStatus(session.sessionId, 'running', 'slack');

  const recoveryContext: Record<string, string> = { source: 'slack' };
  if (session.slackContext?.channelName) recoveryContext.channel = `#${session.slackContext.channelName}`;
  if (session.slackContext?.type === 'dm') recoveryContext.dm = 'true';
  if (threadTs) recoveryContext.thread = threadTs;

  try {
    const replyTs = await pipeAgentReply(
      { channel, threadTs, useUserToken, transform: undefined, finalTransform: resolveUserMentions },
      pumpStream(
        streamChat({
          prompt,
          sessionId: session.sessionId,
          uid: SLACK_UID,
          userEmail: isSlackBotPlaceholderEmail(session.userEmail) ? undefined : session.userEmail,
          userName: session.slackContext?.userName,
          mcpServers: getMcpConfig(SLACK_UID),
          abortController: recoveryAc,
          context: recoveryContext,
          onPermissionRequest: async () => ({ allow: true }),
          onUserQuestion: makeSlackQuestionHandler({ channel, threadTs, useUserToken }),
        }),
        session.sessionId,
        { partial: false, artifacts: false },
      ),
    );
    if (replyTs) { console.log(`[slack-bot] recovery reply posted: ${channel} ts=${replyTs}`); invalidateChannelContext(channel); }
  } catch (err: any) {
    console.error(`[slack-bot] recovery error for ${session.sessionId.slice(0, 8)}:`, err.message);
  } finally {
    if (releaseSessionLock(session.sessionId, recoveryAc)) {
      setRunStatus(session.sessionId, 'idle');
      broadcastFn({ type: 'session_busy', sessionId: session.sessionId, busy: false });
    }
    if (lastMessageTs) await removeReaction(channel, lastMessageTs, 'hourglass_flowing_sand', useUserToken).catch(() => {});
  }
}
