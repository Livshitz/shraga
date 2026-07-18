import type { McpProgressReporter } from 'edge.libx.js/build/main.js';
import type { WsEvent } from './claude.ts';

const THROTTLE_MS = 1000;

/**
 * Map agent stream events to MCP progress via `report` (from captureMcpProgress()).
 * Throttles to ~1/s; terminal events (done/error) always flush. `report` is a no-op
 * when the client didn't request progress, so this is always safe to wire up.
 */
export function makeProgressEmitter(report: McpProgressReporter): (ev: WsEvent) => void {
  let lastSentAt = 0;
  return (ev) => {
    const message = eventToMessage(ev);
    if (!message) return;
    const terminal = ev.type === 'done' || ev.type === 'error';
    const now = Date.now();
    if (!terminal && now - lastSentAt < THROTTLE_MS) return;
    lastSentAt = now;
    report(message);
  };
}

function eventToMessage(ev: WsEvent): string {
  switch (ev.type) {
    case 'thinking_delta':
      return prefixed('💭', ev.text);
    case 'text_delta':
      return prefixed('💬', ev.text);
    case 'tool_use':
      return `🔧 ${ev.tool}`;
    case 'done':
      return '✓ done';
    case 'error':
      return prefixed('⚠️', ev.message) || '⚠️ error';
    default:
      return '';
  }
}

/** First non-empty line of `v`, clipped to 80 chars, with an icon — or '' if blank. */
function prefixed(icon: string, v: unknown): string {
  const line = (String(v ?? '').trim().split('\n').find((l) => l.trim()) ?? '').slice(0, 80);
  return line ? `${icon} ${line}` : '';
}
