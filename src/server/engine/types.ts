import type { McpConfig } from '../mcp.ts';
import type { WsEvent, AttachmentMeta, PermissionHandler, QuestionHandler } from '../claude.ts';
import type { ConvMessage } from '../sessions.ts';
import type { Directives } from '../directives.ts';
import type { AgentSettings } from '../shraga-config.ts';

export interface EngineStreamOpts {
  /** The user's effective prompt (after directive stripping, slash command expansion, skill/workspace mentions) */
  prompt: string;
  /** Raw conversation history from JSONL (engine formats as needed) */
  conversation: ConvMessage[];
  /** Contextual blocks to prepend (user block, skills, workspace tree, etc.) */
  contextBlock: string;

  attachments?: AttachmentMeta[];
  images?: string[];
  sessionId: string;
  uid: string;
  userEmail?: string;
  userName?: string;
  mcpServers?: McpConfig;
  abortController?: AbortController;
  onPermissionRequest?: PermissionHandler;
  onDestructiveApproval?: PermissionHandler;
  onUserQuestion?: QuestionHandler;
  /** Opaque per-send hints bag, forwarded verbatim from the client. The core interprets no key of it;
   *  an add-on engine reads its own keys (e.g. a duplex engine's `voice` marker). */
  turnHints?: Record<string, unknown>;
  /** True when the conversation was truncated (user replayed/edited a message) — engines with cached state should reset. */
  conversationReset?: boolean;
  context?: Record<string, string>;

  directives: Directives;
  config: AgentSettings;
}

export interface AgentEngine {
  readonly name: string;
  stream(opts: EngineStreamOpts): AsyncGenerator<WsEvent>;
  /** Return model options for the UI picker (only called when engine is available) */
  getModels(): EngineModel[];
  init?(): Promise<void>;
  shutdown?(): Promise<void>;
}

export interface EngineModel {
  value: string;
  label: string;
  provider?: string;
}
