import { randomUUID } from '@/lib/utils';
import type { ChatMessage, MessageBlock } from '@/hooks/useConversation';

/** Authenticated fetch with bearer token + timeout. Throws on !ok. */
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
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
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
