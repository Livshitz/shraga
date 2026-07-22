import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { AgentSocket, type ServerEvent, type AskQuestion, type QuestionAnswers } from '@/lib/ws';
import { randomUUID } from '@/lib/utils';
import { apiFetch, historyToMessages } from '@/lib/sessionApi';

export interface Attachment {
  url: string;
  name: string;
  mimeType: string;
  path: string;
}

export type MessageBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'error'; text: string }
  | { type: 'image'; src: string }
  | { type: 'file'; src: string; name: string; mimeType: string }
  | { type: 'context'; label: string; text: string }
  | { type: 'tool_use'; tool: string; toolUseId: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; output: string }
  | { type: 'permission_request'; id: string; tool: string; input: Record<string, unknown> }
  | { type: 'question_request'; id: string; questions: AskQuestion[] }
  | { type: 'compact_marker'; summary: string; compactedCount: number };

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  blocks: MessageBlock[];
  ts?: number;
  senderName?: string;
}

export interface ConversationState {
  messages: ChatMessage[];
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  busy: boolean;
  setBusy: (b: boolean) => void;
  sendMessage: (
    text: string,
    sessionId?: string,
    attachments?: Attachment[],
    truncateAt?: number,
    /** Opaque bag passed straight through to the server; the core never interprets it. */
    sendOptions?: Record<string, unknown>,
    /** Display-only: `false` suppresses the user bubble (a synthetic/agent-first opener). */
    echo?: boolean,
  ) => void;
  steer: (text: string) => void;
  queue: string[];
  addToQueue: (text: string) => void;
  removeFromQueue: (index: number) => void;
  respondPermission: (id: string, allow: boolean, allowAll?: boolean) => void;
  respondQuestion: (id: string, answers: QuestionAnswers) => void;
  cancel: () => void;
  reset: () => void;
  setSessionId: (id: string | undefined) => void;
}

/** Append a block to the last assistant message, or create a new one. */
export function appendToAssistant(prev: ChatMessage[], block: MessageBlock): ChatMessage[] {
  const last = prev[prev.length - 1];
  if (last?.role === 'assistant') {
    if (block.type === 'text' || block.type === 'thinking') {
      const blocks = [...last.blocks];
      const lastBlock = blocks[blocks.length - 1];
      if (lastBlock?.type === block.type) {
        blocks[blocks.length - 1] = { ...lastBlock, text: (lastBlock as { text: string }).text + block.text };
        return [...prev.slice(0, -1), { ...last, blocks }];
      }
      return [...prev.slice(0, -1), { ...last, blocks: [...blocks, block] }];
    }
    return [...prev.slice(0, -1), { ...last, blocks: [...last.blocks, block] }];
  }
  return [...prev, { id: randomUUID(), role: 'assistant', blocks: [block] }];
}

/** `kind: 'error'` renders as a failure block — matching what the server persists for a failed run. */
export function appendErrorToAssistant(prev: ChatMessage[], text: string, kind: 'text' | 'error' = 'text'): ChatMessage[] {
  const last = prev[prev.length - 1];
  const block: MessageBlock = { type: kind, text };
  if (last?.role === 'assistant') {
    return [...prev.slice(0, -1), { ...last, blocks: [...last.blocks, block] }];
  }
  return [...prev, { id: randomUUID(), role: 'assistant', blocks: [block] }];
}

/** Update an existing tool_use block's input (for streamed tool calls where input arrives later). */
export function updateToolUseInput(prev: ChatMessage[], toolUseId: string, input: unknown): ChatMessage[] {
  for (let i = prev.length - 1; i >= 0; i--) {
    const msg = prev[i];
    if (msg.role !== 'assistant') continue;
    const idx = msg.blocks.findIndex((b) => b.type === 'tool_use' && b.toolUseId === toolUseId);
    if (idx === -1) continue;
    const blocks = [...msg.blocks];
    blocks[idx] = { ...blocks[idx], input } as MessageBlock;
    return [...prev.slice(0, i), { ...msg, blocks }, ...prev.slice(i + 1)];
  }
  return prev;
}

export interface ConversationOptions {
  getToken: () => Promise<string | null>;
  /** Session this conversation is bound to (undefined = a fresh "new chat" until its first reply). */
  initialSessionId?: string;
  /** Fired when the server assigns/changes this conversation's session id (new chat, fork, turn done). */
  onNewSession?: (id: string) => void;
  /** Per-turn directives event (model/turns/thinking/engine). */
  onDirectivesChanged?: (directives: { model?: string; turns?: number; thinking?: string; engine?: string }) => void;
  /** Participant count changed after a server-side refetch (multi-user sessions). */
  onParticipantsChanged?: (multi: boolean) => void;
  /** Raw passthrough of every socket event (pane filters by its own session: artifacts, model_resolved, title). */
  onEvent?: (event: ServerEvent) => void;
}

/**
 * Per-conversation state + event handling over a SHARED {@link AgentSocket}.
 * Multiple instances coexist (one per open tab/pane); each filters socket events to
 * its own `sessionId`, so several conversations stream live concurrently. Socket lifecycle,
 * connection status, and cross-session/global events live in `useAgentSocket`.
 */
export function useConversation(socket: AgentSocket | null, opts: ConversationOptions): ConversationState {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [queue, setQueue] = useState<string[]>([]);

  const sessionIdRef = useRef<string | undefined>(opts.initialSessionId);
  // True between this pane's send and the turn's done/error — scopes untagged events (session_id,
  // directives) to the pane that actually started the turn over the shared socket.
  const expectingTurnRef = useRef(false);
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const getTokenRef = useRef(opts.getToken);
  getTokenRef.current = opts.getToken;
  const onNewSessionRef = useRef(opts.onNewSession);
  onNewSessionRef.current = opts.onNewSession;
  const onDirectivesChangedRef = useRef(opts.onDirectivesChanged);
  onDirectivesChangedRef.current = opts.onDirectivesChanged;
  const onParticipantsChangedRef = useRef(opts.onParticipantsChanged);
  onParticipantsChangedRef.current = opts.onParticipantsChanged;
  const onEventRef = useRef(opts.onEvent);
  onEventRef.current = opts.onEvent;
  const socketRef = useRef(socket);
  socketRef.current = socket;

  /**
   * True only when an incoming event is explicitly tagged for THIS conversation. Untagged content is
   * never "mine" — over one shared socket that would make every pane duplicate it. (Untagged
   * session_id/directives are routed separately via expectingTurnRef, not this check.)
   */
  const isMine = useCallback((sid: string | undefined) => sid != null && sid === sessionIdRef.current, []);

  /** Refetch authoritative history for this session (background catch-up / new server-side messages). */
  const refetch = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      const res = await apiFetch(`/api/sessions/${sid}/messages`, getTokenRef.current);
      const data = await res.json();
      setMessages(historyToMessages(data));
      setBusy(!!data.busy);
      onParticipantsChangedRef.current?.(Array.isArray(data.participants) && data.participants.length > 1);
    } catch {
      /* transient — leave current view in place */
    }
  }, []);

  useEffect(() => {
    if (!socket) return;
    const off = socket.on((event: ServerEvent) => {
      onEventRef.current?.(event);

      // Add-on socket events (not in the typed ServerEvent union) are handled by an add-on's
      // conversationController, which subscribes to the same socket — the core ignores them here.

      // `compact_marker` isn't in the typed ServerEvent union — guard before the switch.
      const raw = event as unknown as { type: string; sessionId?: string; summary?: string; compactedCount?: number };
      if (raw.type === 'compact_marker') {
        if (!isMine(raw.sessionId)) return;
        return setMessages((prev) => [
          ...prev,
          {
            id: randomUUID(),
            role: 'assistant' as const,
            blocks: [{ type: 'compact_marker' as const, summary: raw.summary ?? '', compactedCount: raw.compactedCount ?? 0 }],
          },
        ]);
      }

      switch (event.type) {
        case 'thinking_delta':
          if (!isMine(event.sessionId)) return;
          return setMessages((prev) => appendToAssistant(prev, { type: 'thinking', text: event.text }));
        case 'text_delta':
          if (!isMine(event.sessionId)) return;
          return setMessages((prev) => appendToAssistant(prev, { type: 'text', text: event.text }));
        case 'tool_use':
          if (!isMine(event.sessionId)) return;
          return setMessages((prev) =>
            appendToAssistant(prev, { type: 'tool_use', tool: event.tool, toolUseId: event.toolUseId, input: event.input }),
          );
        case 'tool_use_input':
          if (!isMine(event.sessionId)) return;
          return setMessages((prev) => updateToolUseInput(prev, event.toolUseId, event.input));
        case 'tool_result':
          if (!isMine(event.sessionId)) return;
          return setMessages((prev) =>
            appendToAssistant(prev, { type: 'tool_result', toolUseId: event.toolUseId, output: event.output }),
          );
        case 'tool_result_image':
          if (!isMine(event.sessionId)) return;
          return setMessages((prev) => appendToAssistant(prev, { type: 'image', src: event.dataUrl }));
        case 'permission_request':
          if (!isMine(event.sessionId)) return;
          return setMessages((prev) =>
            appendToAssistant(prev, { type: 'permission_request', id: event.id, tool: event.tool, input: event.input }),
          );
        case 'question_request':
          if (!isMine(event.sessionId)) return;
          return setMessages((prev) =>
            appendToAssistant(prev, { type: 'question_request', id: event.id, questions: event.questions }),
          );
        case 'directives':
          // Untagged — applies to whichever pane just started a turn (one shared socket fans this to
          // every pane). Gate on expectingTurn so an idle pane doesn't adopt another's directives.
          if (!expectingTurnRef.current) return;
          return onDirectivesChangedRef.current?.(event.directives);
        case 'session_id':
          // Untagged. Only the pane awaiting a fresh session (just sent with no id) may adopt it —
          // otherwise every open pane would hijack this id off the shared socket.
          if (!expectingTurnRef.current || sessionIdRef.current) return;
          sessionIdRef.current = event.sessionId;
          return onNewSessionRef.current?.(event.sessionId);
        case 'forked':
          // Server forked a busy session on send — only the pane that owned the source adopts it.
          if (event.sourceSessionId !== sessionIdRef.current) return;
          sessionIdRef.current = event.sessionId;
          return onNewSessionRef.current?.(event.sessionId);
        case 'session_busy':
          if (event.sessionId === sessionIdRef.current) setBusy(event.busy);
          return;
        case 'session_stream':
          // Live deltas for a turn initiated by ANOTHER socket/device viewing the same session.
          if (event.sessionId !== sessionIdRef.current) return;
          return applyStream(setMessages, event.event);
        case 'session_messages_changed':
          if (event.sessionId === sessionIdRef.current) void refetch();
          return;
        case 'done': {
          if (event.sessionId !== sessionIdRef.current) return;
          if (event.stopReason === 'max_turns_reached') {
            setMessages((prev) =>
              appendToAssistant(prev, {
                type: 'text',
                text: '\n\n---\n⚠️ Reached the maximum number of steps for this turn. Send "continue" to pick up where I left off.',
              }),
            );
          }
          onNewSessionRef.current?.(event.sessionId);
          const q = queueRef.current;
          if (q.length > 0) {
            const combined = q.join('\n\n');
            setQueue([]);
            setMessages((prev) => prev.concat({ id: randomUUID(), role: 'user', blocks: [{ type: 'text', text: combined }] }));
            socketRef.current?.send({ type: 'message', text: combined, sessionId: event.sessionId });
            return; // queue flush keeps the turn alive — stay "expecting".
          }
          expectingTurnRef.current = false;
          return setBusy(false);
        }
        case 'error':
          if (!isMine(event.sessionId)) return;
          expectingTurnRef.current = false;
          setBusy(false);
          setQueue([]);
          return setMessages((prev) => appendErrorToAssistant(prev, event.message, 'error'));
        case 'disconnected':
          // Any in-flight turn is interrupted on socket loss.
          return setBusy(false);
        case 'reconnected':
          // Catch up on anything streamed while the socket was down.
          if (sessionIdRef.current) void refetch();
          return;
        default:
          return;
      }
    });
    return () => {
      off();
    };
  }, [socket, isMine, refetch]);

  const sendMessage = useCallback(
    (text: string, sessionId?: string, attachments?: Attachment[], truncateAt?: number, sendOptions?: Record<string, unknown>, echo = true) => {
      if (busy || !socketRef.current) return;
      if (sessionId) sessionIdRef.current = sessionId;
      expectingTurnRef.current = true; // claim this turn's untagged session_id/directives.
      setBusy(true);
      const attBlocks: MessageBlock[] = (attachments ?? []).map((a) =>
        a.mimeType.startsWith('image/')
          ? { type: 'image' as const, src: a.url }
          : { type: 'file' as const, src: a.url, name: a.name, mimeType: a.mimeType },
      );
      if (echo) {
        setMessages((prev) => prev.concat({ id: randomUUID(), role: 'user', blocks: [...attBlocks, { type: 'text', text }] }));
      }
      // `sendOptions` is an opaque add-on bag (never interpreted here) spread onto the wire message.
      const sent = socketRef.current.sendOrQueue({ type: 'message', text, sessionId, attachments, truncateAt, ...sendOptions });
      if (!sent) {
        setMessages((prev) => appendErrorToAssistant(prev, '⚠️ Reconnecting — your message will be sent automatically.'));
      }
    },
    [busy],
  );

  const steer = useCallback(
    (text: string) => {
      if (!busy || !socketRef.current) return;
      setMessages((prev) => prev.concat({ id: randomUUID(), role: 'user', blocks: [{ type: 'text', text: `↩ ${text}` }] }));
      socketRef.current.steer(text, sessionIdRef.current);
    },
    [busy],
  );

  const addToQueue = useCallback((text: string) => setQueue((q) => [...q, text]), []);
  const removeFromQueue = useCallback((index: number) => setQueue((q) => q.filter((_, i) => i !== index)), []);

  const respondPermission = useCallback((id: string, allow: boolean, allowAll?: boolean) => {
    socketRef.current?.respondPermission(id, allow, allowAll);
    setMessages((prev) => removeRequestBlock(prev, 'permission_request', id));
  }, []);

  const respondQuestion = useCallback((id: string, answers: QuestionAnswers) => {
    socketRef.current?.respondQuestion(id, answers);
    setMessages((prev) => removeRequestBlock(prev, 'question_request', id));
  }, []);

  const cancel = useCallback(() => {
    socketRef.current?.cancel(sessionIdRef.current);
    expectingTurnRef.current = false;
    setBusy(false);
    setQueue([]);
  }, []);

  const reset = useCallback(() => {
    setMessages([]);
    setBusy(false);
    setQueue([]);
    sessionIdRef.current = undefined;
    expectingTurnRef.current = false;
  }, []);

  const setSessionId = useCallback((id: string | undefined) => {
    sessionIdRef.current = id;
  }, []);

  return {
    messages,
    setMessages,
    busy,
    setBusy,
    sendMessage,
    steer,
    queue,
    addToQueue,
    removeFromQueue,
    respondPermission,
    respondQuestion,
    cancel,
    reset,
    setSessionId,
  };
}

type StreamEvent = Extract<ServerEvent, { type: 'session_stream' }>['event'];

/** Apply a `session_stream`-wrapped delta (same shapes as top-level deltas). */
function applyStream(setMessages: Dispatch<SetStateAction<ChatMessage[]>>, event: StreamEvent) {
  switch (event.type) {
    case 'thinking_delta':
      return setMessages((prev) => appendToAssistant(prev, { type: 'thinking', text: event.text }));
    case 'text_delta':
      return setMessages((prev) => appendToAssistant(prev, { type: 'text', text: event.text }));
    case 'tool_use':
      return setMessages((prev) =>
        appendToAssistant(prev, { type: 'tool_use', tool: event.tool, toolUseId: event.toolUseId, input: event.input }),
      );
    case 'tool_use_input':
      return setMessages((prev) => updateToolUseInput(prev, event.toolUseId, event.input));
    case 'tool_result':
      return setMessages((prev) =>
        appendToAssistant(prev, { type: 'tool_result', toolUseId: event.toolUseId, output: event.output }),
      );
  }
}

/** Remove a pending permission/question request block once answered. */
function removeRequestBlock(
  prev: ChatMessage[],
  blockType: 'permission_request' | 'question_request',
  id: string,
): ChatMessage[] {
  const updated = [...prev];
  for (let i = updated.length - 1; i >= 0; i--) {
    const msg = updated[i];
    if (msg.role !== 'assistant') continue;
    const blockIdx = msg.blocks.findIndex((b) => b.type === blockType && (b as { id: string }).id === id);
    if (blockIdx !== -1) {
      updated[i] = { ...msg, blocks: msg.blocks.filter((_, j) => j !== blockIdx) };
      break;
    }
  }
  return updated;
}
