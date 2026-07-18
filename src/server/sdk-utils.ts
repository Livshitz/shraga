import { query } from '@anthropic-ai/claude-agent-sdk';

/**
 * Run a simple SDK query that returns text only (no tools).
 * Handles the CLAUDECODE nested-session guard automatically.
 */
export async function runTextQuery(opts: {
  prompt: string;
  model?: string;
  maxTurns?: number;
  systemPrompt?: string;
}): Promise<string> {
  const saved = process.env.CLAUDECODE;
  delete process.env.CLAUDECODE;

  try {
    let result = '';
    const model = opts.model || 'haiku';
    for await (const ev of query({
      prompt: opts.prompt,
      options: {
        model,
        maxTurns: opts.maxTurns || 1,
        systemPrompt: opts.systemPrompt,
      },
    })) {
      const m = ev as any;
      if (m.type === 'assistant' && m.message?.content) {
        for (const block of m.message.content) {
          if (typeof block === 'object' && 'text' in block) result += block.text;
        }
      } else if (m.type === 'result' && m.usage) {
        // These one-shot summarizer/title calls have unique inputs (no shared
        // prefix) so they're inherently uncacheable — logged for token-volume
        // visibility so the org-wide cache picture isn't blind to this fleet.
        const u = m.usage;
        const inTok = (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.input_tokens ?? 0);
        console.log(`[sdk] textQuery: in=${inTok} out=${u.output_tokens ?? 0} cacheRead=${u.cache_read_input_tokens ?? 0} model=${model}`);
      }
    }
    return result;
  } finally {
    if (saved !== undefined) process.env.CLAUDECODE = saved;
  }
}
