/**
 * The single event→(transcript blocks, client events) reducer for an agent turn.
 *
 * Every lane that runs a turn has to do the same two things with the engine's event stream: build
 * the assistant message's `ConvBlock[]`, and push the live deltas to whoever is watching the session
 * on the web. Each surface (websocket, Slack, webhook-driven, background-job/wake, the REST chat
 * endpoint) grew its own copy, and most were lossy in a different way — a Slack turn rendered tool
 * pills with empty inputs; a job-triggered turn streamed nothing at all and dropped an add-on
 * engine's subagent events on the floor. This is that logic, once.
 *
 * Two output channels, deliberately distinct:
 *  - `onDelta` gets the core display events, to be wrapped as `{ type: 'session_stream', event }`.
 *  - `onPassthrough` gets everything the CORE DOESN'T OWN (an add-on engine's `duplex_*` subagent
 *    pills — see the note on the WsEvent union in claude.ts), forwarded VERBATIM and top-level,
 *    which is the shape those clients already listen for. Unknown = forward, never drop: dropping is
 *    what made a dispatched worker invisible.
 */
import type { ConvBlock } from './sessions.ts';

/** Events a lane handles itself (transport, control flow) — never a display delta, never forwarded. */
export const TURN_CONTROL_EVENTS = new Set([
  'done', 'error', 'permission_request', 'question_request',
  'model_resolved', 'stats', 'session_id', 'session_busy', 'forked',
]);

/** The inner payload of a `session_stream` event — the core's display deltas. */
export type StreamDelta =
  | { type: 'thinking_delta'; text: string }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use'; tool: string; toolUseId: string; input: unknown }
  | { type: 'tool_use_input'; toolUseId: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; output: string }
  | { type: 'tool_result_image'; toolUseId: string; dataUrl: string };

export interface TurnStreamHooks {
  onDelta?: (ev: StreamDelta) => void;
  onPassthrough?: (ev: object) => void;
  /** Cap on a tool_result's streamed output. The transcript keeps the full text either way. */
  maxResultChars?: number;
}

export interface TurnAccumulator {
  /** The assistant blocks so far — safe to read mid-turn (a live "partial" snapshot). */
  readonly blocks: ConvBlock[];
  /** Feed one engine event. Returns true for a terminal event (`done`/`error`), so lanes can break. */
  push(ev: { type: string } & Record<string, any>): boolean;
  /** Append arbitrary blocks (a lane's own notices, e.g. the max-turns hint). */
  add(block: ConvBlock): void;
  /** Flush trailing thinking/text and return the finished block list. */
  finish(): ConvBlock[];
  /** Blocks as they stand, including a trailing in-progress thinking/text — for live partials. */
  snapshot(): ConvBlock[];
  /** Set once a `done` event arrives. */
  stopReason: string;
}

export function createTurnAccumulator(hooks: TurnStreamHooks = {}): TurnAccumulator {
  const blocks: ConvBlock[] = [];
  const max = hooks.maxResultChars ?? Infinity;
  let text = '';
  let thinking = '';

  const flushThinking = () => { if (thinking) { blocks.push({ type: 'thinking', text: thinking }); thinking = ''; } };
  const flushText = () => { if (text) { blocks.push({ type: 'text', text }); text = ''; } };
  const delta = (ev: StreamDelta) => hooks.onDelta?.(ev);

  const acc: TurnAccumulator = {
    blocks,
    stopReason: '',
    add(block) { flushThinking(); flushText(); blocks.push(block); },
    push(ev) {
      switch (ev.type) {
        case 'thinking_delta':
          thinking += ev.text;
          delta({ type: 'thinking_delta', text: ev.text });
          return false;
        case 'text_delta':
          flushThinking();
          text += ev.text;
          delta({ type: 'text_delta', text: ev.text });
          return false;
        case 'tool_use':
          flushThinking(); flushText();
          blocks.push({ type: 'tool_use', tool: ev.tool, toolUseId: ev.toolUseId, input: ev.input });
          delta({ type: 'tool_use', tool: ev.tool, toolUseId: ev.toolUseId, input: ev.input });
          return false;
        case 'tool_use_input': {
          // The claude-code engine opens a tool_use with an EMPTY input and fills it here. A lane
          // that drops this renders pills labelled with nothing.
          const open = blocks.find((b) => b.type === 'tool_use' && b.toolUseId === ev.toolUseId) as { input?: unknown } | undefined;
          if (open) open.input = ev.input;
          delta({ type: 'tool_use_input', toolUseId: ev.toolUseId, input: ev.input });
          return false;
        }
        case 'tool_result':
          blocks.push({ type: 'tool_result', toolUseId: ev.toolUseId, output: ev.output });
          delta({ type: 'tool_result', toolUseId: ev.toolUseId, output: ev.output.length > max ? ev.output.slice(0, max) + '…' : ev.output });
          return false;
        case 'tool_result_image':
          blocks.push({ type: 'image', src: ev.dataUrl });
          delta({ type: 'tool_result_image', toolUseId: ev.toolUseId, dataUrl: ev.dataUrl });
          return false;
        case 'done':
          acc.stopReason = ev.stopReason ?? 'end_turn';
          return true;
        case 'error':
          flushThinking(); flushText();
          blocks.push({ type: 'error', text: ev.message });
          acc.stopReason = 'error';
          return true;
        default:
          // Not core-owned. An add-on engine's event (subagent pills, worker cards) — forward it
          // verbatim rather than discarding it, and leave the transcript to whoever owns it.
          if (!TURN_CONTROL_EVENTS.has(ev.type)) hooks.onPassthrough?.(ev);
          return false;
      }
    },
    finish() { flushThinking(); flushText(); return blocks; },
    snapshot() {
      return [
        ...blocks,
        ...(thinking ? [{ type: 'thinking' as const, text: thinking }] : []),
        ...(text ? [{ type: 'text' as const, text }] : []),
      ];
    },
  };
  return acc;
}
