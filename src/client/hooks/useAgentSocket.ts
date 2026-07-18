import { useEffect, useRef, useState } from 'react';
import { AgentSocket, type ServerEvent } from '@/lib/ws';

export type ConnectionStatus =
  | 'disconnected'
  | 'reconnected'
  | 'update_available'
  | 'server_restarting'
  | null;

/**
 * Owns the single shared {@link AgentSocket} connection for the whole app, plus connection-level
 * state (status, auth error, server-build update detection). Every socket event is forwarded to
 * `onEvent` for app-global routing (schedules, unread, sidebar, busy set). Per-conversation event
 * handling lives in `useConversation`, which subscribes to the same socket independently.
 */
export function useAgentSocket(
  token: string | null,
  getToken: () => Promise<string | null>,
  onEvent?: (event: ServerEvent) => void,
): { socket: AgentSocket | null; connectionStatus: ConnectionStatus; authError: string | null } {
  const [socket, setSocket] = useState<AgentSocket | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const serverBuildIdRef = useRef<string | undefined>(undefined);
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!token) return;
    let reconnectTimer: ReturnType<typeof setTimeout>;
    const s = new AgentSocket();
    setSocket(s);
    // Provider returns a fresh token on every (re)connect so expired Firebase tokens auto-refresh.
    s.connect(() => getTokenRef.current());

    const off = s.on((event: ServerEvent) => {
      switch (event.type) {
        case 'auth_ok':
          if (event.buildId) {
            if (serverBuildIdRef.current && serverBuildIdRef.current !== event.buildId) {
              setConnectionStatus('update_available');
            } else {
              serverBuildIdRef.current = event.buildId;
            }
          }
          break;
        case 'auth_error':
          if (event.message?.toLowerCase().includes('whitelist')) setAuthError(event.message);
          break;
        case 'server_restarting':
          setConnectionStatus('server_restarting');
          break;
        case 'disconnected':
          setConnectionStatus((prev) => (prev === 'server_restarting' ? prev : 'disconnected'));
          break;
        case 'reconnected':
          setConnectionStatus((prev) => (prev === 'update_available' ? prev : 'reconnected'));
          reconnectTimer = setTimeout(
            () => setConnectionStatus((prev) => (prev === 'update_available' ? prev : null)),
            2000,
          );
          break;
      }
      onEventRef.current?.(event);
    });

    return () => {
      off();
      clearTimeout(reconnectTimer);
      s.disconnect();
      setSocket(null);
    };
  }, [token]);

  return { socket, connectionStatus, authError };
}
