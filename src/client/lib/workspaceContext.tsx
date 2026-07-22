import { createContext, useContext } from 'react';
import type { AgentSocket } from '@/lib/ws';
import type { ConnectionStatus } from '@/hooks/useAgentSocket';

export interface AgentConfig {
  engine?: string;
  model?: string;
  permissionMode?: string;
  maxTurns?: number;
  allowedTools?: string[];
  systemPrompt?: string;
  thinking?: 'adaptive' | 'enabled' | 'disabled';
  effort?: 'low' | 'medium' | 'high' | 'max';
  /** Derived server state (read-only, not persisted): claude-code credentials in use — see /api/config. */
  claudeAuthSource?: 'subscription' | 'api-key';
}

/**
 * Shell-stable values shared with every {@link ConversationPane}, plus the minimal session
 * actions a pane needs (adopt a new session id, rename its tab, open another session). This build
 * ships a single pane, but the context stays the prop-drill escape hatch. Add-on-only wiring (extra
 * panes, per-conversation resources, feature flags) lives behind {@link ClientSlots}, not here.
 */
export interface WorkspaceContextValue {
  socket: AgentSocket | null;
  connectionStatus: ConnectionStatus;
  getToken: () => Promise<string | null>;
  token: string | null;
  agentConfig: AgentConfig;
  setAgentConfig: (c: AgentConfig) => void;
  /** The currently focused conversation — a pane uses it to know when it has become active. */
  activeSessionId: string | undefined;
  skills: string[];
  workspaceFiles: string[];
  openSchedules: () => void;
  /** Clear unread state for a session (called when a pane becomes the active/focused one). */
  markRead: (sessionId: string) => void;
  /** Nudge the sidebar/session list to refresh (new session, title change, turn finished). */
  bumpSidebar: () => void;
  /** A pane adopted/changed its session id (fresh chat → real id, or fork). */
  assignSession: (nodeId: string, sessionId: string) => void;
  /** Update a tab's display title. */
  renameTab: (nodeId: string, title: string) => void;
  /** Open a session in a (preview) tab — used by fork, toasts, sidebar, schedules. */
  openSession: (sessionId: string, title?: string) => void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export const WorkspaceProvider = WorkspaceContext.Provider;

export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error('useWorkspace must be used within a WorkspaceProvider');
  return ctx;
}
