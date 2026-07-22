import { randomUUID } from '@/lib/utils';
import type { ChatMessage, MessageBlock } from '@/hooks/useConversation';

/** An !ok response from `apiFetch`, carrying the HTTP `status` so callers can branch on it.
 *
 *  WHY a class and not a bare Error: apiFetch THROWS on !ok — it never RETURNS a non-ok response — so
 *  the natural-looking `const res = await apiFetch(…); if (res.status === 404) …` is DEAD CODE that
 *  never runs. Callers must branch in the `catch`, and a stringified `Error('404 Not Found')` leaves
 *  them parsing the message to do it. This shipped as a real bug: a dead-PTY cwd poller kept 404ing
 *  every 3s forever because its "stop on 404" test sat on the return value. */
export class ApiError extends Error {
  constructor(public readonly status: number, statusText: string) {
    super(`${status} ${statusText}`);
    this.name = 'ApiError';
  }
}

/** Authenticated fetch with bearer token + timeout. Throws `ApiError` (with `.status`) on !ok. */
export async function apiFetch(
  path: string,
  getToken: () => Promise<string | null>,
  init?: RequestInit & { timeoutMs?: number },
) {
  const token = await getToken();
  if (!token) throw new Error('No auth token');
  const timeout = init?.timeoutMs ?? 15_000;
  const controller = new AbortController();
  if (init?.signal) init.signal.addEventListener('abort', () => controller.abort());
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(path, {
      ...init,
      signal: controller.signal,
      headers: { Authorization: `Bearer ${token}`, ...init?.headers },
    });
    if (!res.ok) throw new ApiError(res.status, res.statusText);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/** Normalize a /api/sessions/:id/messages payload into ChatMessage[]. */
export function historyToMessages(data: { format: string; messages: any[] }): ChatMessage[] {
  // Our own clean format
  if (data.format === 'conv') {
    return (data.messages as ChatMessage[]).filter((m) => m.blocks?.length > 0);
  }

  // Fallback: Claude's JSONL format
  const result: ChatMessage[] = [];
  for (const m of data.messages) {
    const payload = m.message as any;
    if (!payload?.content) continue;
    const blocks: MessageBlock[] = [];
    for (const block of payload.content) {
      if (block.type === 'text' && block.text) blocks.push({ type: 'text', text: block.text });
      else if (block.type === 'tool_use')
        blocks.push({ type: 'tool_use', tool: block.name, toolUseId: block.id, input: block.input });
      else if (block.type === 'tool_result') {
        const output = Array.isArray(block.content)
          ? block.content.map((c: any) => c.text ?? '').join('')
          : String(block.content ?? '');
        blocks.push({ type: 'tool_result', toolUseId: String(block.tool_use_id), output });
      }
    }
    if (blocks.length > 0) {
      result.push({ id: m.uuid || randomUUID(), role: m.type === 'user' ? 'user' : 'assistant', blocks });
    }
  }
  return result;
}
