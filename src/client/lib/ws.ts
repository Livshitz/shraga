export type AskQuestion = {
  question: string;
  header: string;
  multiSelect?: boolean;
  options: { label: string; description: string; preview?: string }[];
};
export type QuestionAnswers = Record<string, string | string[]>;

export type ServerEvent =
  | { type: 'auth_ok'; uid: string; email: string; buildId?: string }
  | { type: 'auth_error'; message: string }
  | { type: 'thinking_delta'; text: string; sessionId?: string }
  | { type: 'text_delta'; text: string; sessionId?: string }
  | { type: 'tool_use'; tool: string; toolUseId: string; input: unknown; sessionId?: string }
  | { type: 'tool_use_input'; toolUseId: string; input: unknown; sessionId?: string }
  | { type: 'tool_result'; toolUseId: string; output: string; sessionId?: string }
  | { type: 'tool_result_image'; toolUseId: string; dataUrl: string; sessionId?: string }
  | { type: 'permission_request'; id: string; tool: string; input: Record<string, unknown>; sessionId?: string }
  | { type: 'question_request'; id: string; questions: AskQuestion[]; sessionId?: string }
  | { type: 'session_id'; sessionId: string }
  | { type: 'forked'; sourceSessionId: string; sessionId: string }
  | { type: 'done'; sessionId: string; stopReason?: 'end_turn' | 'max_turns_reached' | (string & {}) }
  | { type: 'model_resolved'; sessionId: string; model: string }
  | { type: 'error'; message: string; sessionId?: string }
  | { type: 'workspace_change'; action: 'created' | 'modified' | 'deleted'; path: string }
  | { type: 'disconnected' }
  | { type: 'reconnected' }
  | { type: 'schedule:updated'; schedule: unknown }
  | { type: 'schedule:deleted'; id: string }
  | { type: 'schedule:fired'; scheduleId: string }
  | { type: 'schedule:run_started'; scheduleId: string; sessionId: string; at: number }
  | { type: 'schedule:run_finished'; scheduleId: string; sessionId: string; summary: unknown }
  | { type: 'session_messages_changed'; sessionId: string }
  | { type: 'session_title_updated'; sessionId: string; title: string }
  | { type: 'directives'; directives: { model?: string; turns?: number; thinking?: string; engine?: string } }
  | { type: 'session_busy'; sessionId: string; busy: boolean }
  | { type: 'session_stream'; sessionId: string; event: { type: 'thinking_delta'; text: string } | { type: 'text_delta'; text: string } | { type: 'tool_use'; tool: string; toolUseId: string; input: unknown } | { type: 'tool_use_input'; toolUseId: string; input: unknown } | { type: 'tool_result'; toolUseId: string; output: string } }
  | { type: 'artifact'; id: string; sessionId: string; title: string; dimensions: [number, number]; version: number }
  | { type: 'server_restarting' }
  | { type: 'unread'; sessionId: string; count: number; preview: string; source: 'response' | 'proactive' | 'schedule'; title?: string }
  | { type: 'unread_sync'; sessions: Record<string, { count: number; preview: string; since: number; lastAt: number; source: string; title?: string }> }
  | { type: 'unread_cleared'; sessionId: string }
  | { type: 'pty_list_changed'; sessionId: string }
  | { type: 'workspace_layout_changed' }
  | { type: 'stats'; sample: { t: number; cpu: number; mem: number; load: number } };

type Listener = (event: ServerEvent) => void;

export class AgentSocket {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private tokenProvider: () => Promise<string | null> = async () => null;
  private intentionalClose = false;
  private reconnecting = false;
  private authRetries = 0;
  private pendingMessage: object | null = null;
  private connectAttempts = 0;

  /**
   * @param tokenProvider returns a *fresh* token on every call. Called on each
   * (re)connect so an expired Firebase ID token is auto-refreshed instead of a
   * stale one being resent forever.
   */
  connect(tokenProvider: () => Promise<string | null>) {
    this.tokenProvider = tokenProvider;
    this.intentionalClose = false;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/ws`;
    console.log('[ws] connecting…');
    this.ws = new WebSocket(url);

    this.ws.onopen = async () => {
      this.connectAttempts = 0;
      let token: string | null = null;
      try {
        token = await this.tokenProvider();
      } catch (err) {
        console.warn('[ws] token fetch failed', err);
      }
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      console.log('[ws] open, sending auth');
      this.ws.send(JSON.stringify({ type: 'auth', token }));
      if (this.reconnecting) {
        this.reconnecting = false;
        this.listeners.forEach((l) => l({ type: 'reconnected' }));
      }
    };

    this.ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as ServerEvent;
        if (data.type !== 'text_delta') console.log('[ws] ←', data.type);
        if (data.type === 'auth_ok') {
          this.authRetries = 0;
          this.flushPending();
        }
        if (data.type === 'auth_error') {
          // Permanent failures (no fresh token can fix them) must STOP retrying — else the client
          // hammers a reconnect every few seconds forever, flooding the server log. Two cases:
          //  - whitelist rejection (this account isn't allowed), and
          //  - token audience mismatch (the client is signed into a DIFFERENT Firebase project than the
          //    server expects — refreshing the token re-mints the same wrong `aud`, never converging).
          // Everything else (expired token, server restarting during deploy) is transient → keep retrying.
          const msg = data.message?.toLowerCase() ?? '';
          const isPermanent = msg.includes('whitelist') || msg.includes('audience mismatch') || msg.includes('sign out and sign in');
          if (isPermanent) {
            this.intentionalClose = true;
          } else {
            this.authRetries++;
            console.log(`[ws] auth failed (attempt ${this.authRetries}), will retry with fresh token`);
          }
        }
        this.listeners.forEach((l) => l(data));
      } catch (err) {
        console.warn('[ws] bad frame', err);
      }
    };

    this.ws.onclose = (e) => {
      console.log(`[ws] closed code=${e.code} intentional=${this.intentionalClose}`);
      if (!this.intentionalClose) {
        this.reconnecting = true;
        this.connectAttempts++;
        this.listeners.forEach((l) => l({ type: 'disconnected' }));
        const base = this.authRetries > 0 ? Math.min(2000 * this.authRetries, 10000) : Math.min(1000 * 2 ** this.connectAttempts, 30000);
        const jitter = Math.random() * 1000;
        const delay = base + jitter;
        console.log(`[ws] reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${this.connectAttempts})`);
        setTimeout(() => this.connect(this.tokenProvider), delay);
      }
    };

    this.ws.onerror = (e) => console.warn('[ws] error', e);
  }

  private flushPending() {
    if (this.pendingMessage) {
      const msg = this.pendingMessage;
      this.pendingMessage = null;
      console.log('[ws] flushing pending message after reconnect');
      if (!this.send(msg)) {
        this.pendingMessage = msg;
      }
    }
  }

  disconnect() {
    this.intentionalClose = true;
    this.ws?.close();
    this.ws = null;
  }

  send(msg: object): boolean {
    if (this.ws?.readyState === WebSocket.OPEN) {
      console.log('[ws] →', (msg as any).type);
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    console.warn('[ws] send failed, readyState=', this.ws?.readyState);
    return false;
  }

  sendOrQueue(msg: object): boolean {
    if (this.send(msg)) return true;
    this.pendingMessage = msg;
    console.log('[ws] message queued for reconnect');
    return false;
  }

  cancel(sessionId?: string) {
    this.send({ type: 'cancel', sessionId });
  }

  steer(text: string, sessionId?: string) {
    this.send({ type: 'steer', text, sessionId });
  }

  respondPermission(id: string, allow: boolean, allowAll?: boolean) {
    this.send({ type: 'permission_response', id, allow, allowAll });
  }

  respondQuestion(id: string, answers: QuestionAnswers) {
    this.send({ type: 'question_response', id, answers });
  }

  sendPresence(sessionId: string | undefined, focused: boolean) {
    this.send({ type: 'presence', sessionId: sessionId ?? null, focused });
  }

  /** Page-Visibility presence for push suppression: server skips notifying the screen in view. */
  sendClientPresence(sessionId: string | undefined, visible: boolean) {
    this.send({ type: 'client_presence', sessionId: sessionId ?? null, visible });
  }

  markRead(sessionId: string) {
    this.send({ type: 'mark_read', sessionId });
  }

  on(listener: Listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
