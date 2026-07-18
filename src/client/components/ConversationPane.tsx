import { useCallback, useEffect, useRef, useState } from 'react';
import type { ServerEvent } from '@/lib/ws';
import { useConversation, type Attachment, type ChatMessage, type MessageBlock } from '@/hooks/useConversation';
import { useArtifacts } from '@/hooks/useArtifacts';
import { apiFetch, historyToMessages } from '@/lib/sessionApi';
import { useWorkspace } from '@/lib/workspaceContext';
import { useSlots, type ConversationControllerCtx } from '@/lib/slots';
import { randomUUID } from '@/lib/utils';
import { ChatView } from '@/components/ChatView';
import { MessageInput, type MessageInputHandle } from '@/components/MessageInput';
import { ArtifactPanel } from '@/components/ArtifactPanel';
import { ConversationHeader } from '@/components/ConversationHeader';

interface SessionDirectives {
  model?: string;
  turns?: number;
  thinking?: string;
  engine?: string;
}

/**
 * A single live conversation. Owns its own message stream, artifacts, and session metadata — all
 * scoped to `sessionId` — over the shared socket from {@link useWorkspace}. The core wires chat only;
 * optional add-on extensions live behind {@link ClientSlots}, filled by an add-on build.
 */
export function ConversationPane({ nodeId, sessionId }: { nodeId: string; sessionId?: string }) {
  const ws = useWorkspace();
  const slots = useSlots();
  const inputRef = useRef<MessageInputHandle>(null);

  // Add-on seams (all inert in the core): an opaque per-pane input handle forwarded to inputAdornments,
  // a provider of opaque per-send options merged into every send, and add-on status items for statusChips.
  const [inputCtx, setInputCtx] = useState<unknown>();
  const [statusItems, setStatusItems] = useState<unknown[]>([]);
  const sendOptionsRef = useRef<(() => Record<string, unknown> | undefined) | undefined>(undefined);

  // `sessionId` is the tab's identity at mount; a fresh chat adopts its real id mid-stream (below).
  const [currentSessionId, setCurrentSessionId] = useState<string | undefined>(sessionId);
  const currentSessionIdRef = useRef(currentSessionId);
  currentSessionIdRef.current = currentSessionId;
  const initialSessionId = useRef(sessionId).current;

  const [sessionDirectives, setSessionDirectives] = useState<SessionDirectives | undefined>();
  const [sessionScheduleId, setSessionScheduleId] = useState<string | undefined>();
  const [sessionLastModel, setSessionLastModel] = useState<string | undefined>();
  const [multiParticipant, setMultiParticipant] = useState(false);

  const artifacts = useArtifacts(currentSessionId, ws.getToken, ws.token);
  const busyRef = useRef(false);

  const handleNewSession = useCallback(
    (id: string) => {
      ws.bumpSidebar();
      if (id === currentSessionIdRef.current) return; // turn `done` on the same session — no re-assign churn.
      setCurrentSessionId(id);
      ws.assignSession(nodeId, id);
    },
    [ws, nodeId],
  );

  // Per-pane raw events (filtered to this session): artifacts, model pill, tab title.
  const handlePaneEvent = useCallback(
    (event: ServerEvent) => {
      if (event.type === 'artifact') {
        if (event.sessionId === currentSessionIdRef.current) artifacts.handleArtifactEvent(event);
      } else if (event.type === 'directives') {
        // Optimistic-then-confirm pill: drop stale ground-truth so the pill shows the just-requested
        // model. Untagged event — gate on this pane being mid-turn so idle panes don't flicker.
        if (busyRef.current) setSessionLastModel(undefined);
      } else if (event.type === 'model_resolved' && event.sessionId === currentSessionIdRef.current) {
        setSessionLastModel(event.model);
      }
    },
    [ws, nodeId, artifacts],
  );

  const conv = useConversation(ws.socket, {
    getToken: ws.getToken,
    initialSessionId: sessionId,
    onNewSession: handleNewSession,
    onDirectivesChanged: setSessionDirectives,
    onParticipantsChanged: setMultiParticipant,
    onEvent: handlePaneEvent,
  });
  busyRef.current = conv.busy;

  // Load history once at mount (only if this tab opened onto an existing session). A fresh chat
  // starts empty and accumulates from the stream — never reload it, or in-flight tokens are lost.
  useEffect(() => {
    if (!initialSessionId) return;
    let aborted = false;
    (async () => {
      try {
        const res = await apiFetch(`/api/sessions/${initialSessionId}/messages`, ws.getToken);
        const data = await res.json();
        if (aborted) return;
        conv.setMessages(historyToMessages(data));
        setMultiParticipant(Array.isArray(data.participants) && data.participants.length > 1);
        if (data.busy) conv.setBusy(true);
      } catch (err) {
        if (!aborted) console.error('[pane] history load failed:', err);
      }
    })();
    return () => {
      aborted = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSessionId]);

  // Load session directives/meta whenever the bound session changes (safe — touches no messages).
  useEffect(() => {
    if (!currentSessionId) {
      setSessionDirectives(undefined);
      setSessionScheduleId(undefined);
      setSessionLastModel(undefined);
      return;
    }
    apiFetch(`/api/sessions/${currentSessionId}/meta`, ws.getToken)
      .then((r) => r.json())
      .then((meta: any) => {
        setSessionDirectives(meta.directives);
        setSessionScheduleId(meta.scheduleId);
        setSessionLastModel(meta.lastModel);
        if (meta.runStatus === 'running') conv.setBusy(true);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSessionId, ws.getToken]);

  const handleSend = useCallback(
    (text: string, truncateAt?: number, attachments?: Attachment[]) => {
      // Merge any add-on-provided opaque send options (read at send time); undefined in the core.
      conv.sendMessage(text, currentSessionIdRef.current, attachments, truncateAt, sendOptionsRef.current?.());
    },
    [conv],
  );

  // Headless per-conversation controller seam (add-on lifecycle + input/send/inject hooks). Rebuilt
  // each render; an add-on binds via refs/effects. The core ships no controller, so nothing runs.
  const controllerCtx: ConversationControllerCtx = {
    sessionId: currentSessionId,
    busy: conv.busy,
    socket: ws.socket,
    getToken: ws.getToken,
    setInputCtx,
    setSendOptions: (get) => { sendOptionsRef.current = get; },
    setInputText: (t) => inputRef.current?.setText(t),
    send: (text, options, meta) =>
      conv.sendMessage(text, currentSessionIdRef.current, undefined, undefined, options, meta?.echo !== false),
    appendAssistant: (blocks) =>
      conv.setMessages((prev: ChatMessage[]) =>
        prev.concat({ id: randomUUID(), role: 'assistant', blocks: blocks as unknown as MessageBlock[] })),
    setStatusItems,
  };

  const handleUpload = useCallback(
    async (file: File) => {
      const t = await ws.getToken();
      if (!t) return null;
      try {
        const res = await fetch('/api/upload', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${t}`,
            'x-filename': encodeURIComponent(file.name),
            'Content-Type': file.type || 'application/octet-stream',
            'x-session-id': currentSessionIdRef.current || '',
          },
          body: file,
        });
        return (await res.json()) as Attachment;
      } catch (err) {
        console.error('[upload] Failed:', err);
        return null;
      }
    },
    [ws],
  );

  const handleFork = useCallback(
    async (truncateAtIndex?: number) => {
      const sid = currentSessionIdRef.current;
      if (!sid) return;
      const t = await ws.getToken();
      if (!t) return;
      try {
        const res = await fetch(`/api/sessions/${sid}/fork`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(truncateAtIndex != null ? { truncateAtIndex } : {}),
        });
        if (!res.ok) {
          console.error('[fork] server error:', (await res.json().catch(() => ({}))).error || res.status);
          return;
        }
        const { sessionId: newId } = await res.json();
        ws.bumpSidebar();
        ws.openSession(newId);
      } catch (err) {
        console.error('[fork] failed:', err);
      }
    },
    [ws],
  );

  const truncateAndSend = useCallback(
    (msgId: string, text: string, attachments?: Attachment[]) => {
      if (conv.busy) return;
      const idx = conv.messages.findIndex((m) => m.id === msgId);
      if (idx >= 0) conv.setMessages(conv.messages.slice(0, idx));
      handleSend(text, idx >= 0 ? idx : undefined, attachments);
    },
    [conv, handleSend],
  );

  return (
    <div className="flex flex-col h-full min-h-0">
      {slots.conversationController?.(controllerCtx)}
      <ConversationHeader
        sessionId={currentSessionId}
        agentConfig={ws.agentConfig}
        sessionDirectives={sessionDirectives}
        sessionLastModel={sessionLastModel}
        sessionScheduleId={sessionScheduleId}
        artifactCount={artifacts.artifacts.length}
        getToken={ws.getToken}
        onConfigSaved={ws.setAgentConfig}
        onDirectivesSaved={setSessionDirectives}
        onFork={() => handleFork()}
        onToggleArtifacts={artifacts.togglePanel}
        onScheduleClick={ws.openSchedules}
      />
      <div className="flex-1 flex min-h-0">
        <div className="flex-1 flex flex-col min-w-0">
          <ChatView
            messages={conv.messages}
            busy={conv.busy}
            multiParticipant={multiParticipant}
            connectionStatus={ws.connectionStatus ?? undefined}
            onPermissionRespond={conv.respondPermission}
            onQuestionRespond={conv.respondQuestion}
            onReplay={truncateAndSend}
            onEdit={truncateAndSend}
            onFork={(messageIndex) => handleFork(messageIndex)}
            statusItems={statusItems}
          />
          <MessageInput
            ref={inputRef}
            onSend={(text, attachments) => handleSend(text, undefined, attachments)}
            onSteer={conv.steer}
            onQueue={conv.addToQueue}
            onRemoveQueued={conv.removeFromQueue}
            queue={conv.queue}
            onUpload={handleUpload}
            onCancel={conv.cancel}
            disabled={false}
            busy={conv.busy}
            skills={ws.skills}
            workspaceFiles={ws.workspaceFiles}
            sessionId={currentSessionId}
            inputCtx={inputCtx}
          />
        </div>
        {artifacts.panelOpen && artifacts.artifacts.length > 0 && currentSessionId && (
          <ArtifactPanel
            artifacts={artifacts.artifacts}
            selectedId={artifacts.selectedId}
            sessionId={currentSessionId}
            getToken={ws.getToken}
            onSelect={artifacts.selectArtifact}
            onClose={artifacts.closePanel}
          />
        )}
      </div>
    </div>
  );
}
