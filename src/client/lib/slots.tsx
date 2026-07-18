import { createContext, useContext, type ReactNode } from 'react';

/**
 * Typed extension SLOTS: the seam between the core client and any add-on bundle.
 *
 * The core ships an empty slot set ({}), so no core component statically imports an add-on module —
 * the built core bundle therefore contains zero add-on code. An add-on build fills these slots at its
 * composition root.
 *
 * Slot arg types are intentionally minimal + local: never import an add-on type here, or the seam
 * leaks back into the core. Loose shapes keep the contract stable while add-ons supply the real widgets.
 */
export interface ClientSlots {
  /** MessageInput: extra controls rendered beside the input. Arg = an opaque per-pane handle. */
  inputAdornments?: (ctx: unknown) => ReactNode;
  /** ConfigPanel: extra settings sub-sections. Arg = { getToken, sessionId }. */
  settingsSections?: (ctx: { getToken: () => Promise<string | null>; sessionId?: string }) => ReactNode;
  /** ChatView: extra renderers appended to a tool block. Arg = { block (the tool_use), result (the
   *  paired tool_result output, if any), screens }. An add-on can reconstruct a resource handle from
   *  the result. Core interprets none of it. */
  toolRenderers?: (ctx: { block: unknown; result?: unknown; screens?: Map<string, string[]> }) => ReactNode;
  /** ChatView: renderer for a NON-CORE (extension) message block — any block whose `type` the core
   *  doesn't recognize is handed here verbatim. Core renders such blocks as nothing on its own. */
  extensionBlocks?: (ctx: { block: unknown; onImageClick?: (src: string) => void }) => ReactNode;
  /** ConversationPane: a headless per-conversation controller, mounted with the pane and unmounted
   *  with it (its own effects are the conversation lifecycle hook). It may register an opaque input
   *  handle + per-send options, drive the composer, inject messages, and set status items — the seam
   *  an add-on uses to bind per-conversation resources. Core ships none, so nothing extra runs. */
  conversationController?: (ctx: ConversationControllerCtx) => ReactNode;
  /** ChatView + ConversationPane: inline status chips for background items. Arg = the item list. */
  statusChips?: (items: unknown[]) => ReactNode;
  /** ChatView (question card): subscribe external interactions → selection. Returns a cleanup. */
  onCardInteraction?: (api: {
    id: string;
    questions: { question: string }[];
    onAnswers: (answers: Record<string, string | string[]>) => void;
  }) => (() => void) | void;
  /** Sidebar: extra footer content. */
  sidebarExtras?: () => ReactNode;
  /** LoginPage: extra pre-login content. */
  loginExtras?: () => ReactNode;
  /** App header: extra action buttons. */
  headerActions?: () => ReactNode;
}

/**
 * Context handed to a {@link ClientSlots.conversationController}. Every field is generic — the core
 * never names what an add-on does with them. The add-on's controller renders as
 * a headless component, so its React effects run for the pane's lifetime.
 */
export interface ConversationControllerCtx {
  sessionId: string | undefined;
  busy: boolean;
  /** the shared agent socket (for add-on events that aren't in the core event union). */
  socket: unknown;
  getToken: () => Promise<string | null>;
  /** register an opaque per-pane handle forwarded to {@link ClientSlots.inputAdornments}. */
  setInputCtx: (handle: unknown) => void;
  /** register a provider of opaque send options merged into every send from this pane (read at send
   *  time). The core passes the bag straight to the server without interpreting it. */
  setSendOptions: (get: (() => Record<string, unknown> | undefined) | undefined) => void;
  /** set the composer text without stealing focus (e.g. live external transcription). */
  setInputText: (text: string) => void;
  /** send from this pane programmatically. `options` is the opaque server bag; `meta.echo === false`
   *  suppresses the user bubble (an agent-first / synthetic opener). */
  send: (text: string, options?: Record<string, unknown>, meta?: { echo?: boolean }) => void;
  /** append an assistant message (core or extension blocks) to this pane's transcript. */
  appendAssistant: (blocks: Array<{ type: string; [key: string]: unknown }>) => void;
  /** replace this pane's live status items (rendered via {@link ClientSlots.statusChips}). */
  setStatusItems: (items: unknown[]) => void;
}

const SlotsContext = createContext<ClientSlots>({});

export const SlotsProvider = SlotsContext.Provider;

export function useSlots(): ClientSlots {
  return useContext(SlotsContext);
}
