import { loadAgents } from './agents.ts';
import { runTextQuery } from './sdk-utils.ts';

export async function summarizeText(text: string, instruction: string): Promise<string> {
  const agent = loadAgents()['summarizer'];
  return runTextQuery({
    prompt: `${instruction}\n\n${text}`,
    model: agent?.model || 'haiku',
    systemPrompt: agent?.prompt || 'You are a concise summarizer. Output only the summary, nothing else.',
  });
}
