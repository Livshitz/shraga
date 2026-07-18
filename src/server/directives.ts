export interface Directives {
  model?: string;
  turns?: number;
  thinking?: 'adaptive' | 'enabled' | 'disabled';
  effort?: 'low' | 'medium' | 'high' | 'max';
  engine?: string;
}

export interface ParsedPrompt {
  prompt: string;
  directives: Directives;
}

/** Model used when neither directives nor config specify one. Always passed
 * explicitly to the SDK — the CLI's own default silently drifts (it picked
 * Opus 4.7), which burns rate limits and budget. */
export const DEFAULT_MODEL = 'claude-sonnet-5';

// Canonical model aliases + label. Vendored, pure, dependency-free (src/server/model-aliases.ts).
// Re-exported here so the rest of shraga keeps importing model helpers from one place.
export { MODEL_ALIASES, modelShortLabel } from './model-aliases.ts';
import { MODEL_ALIASES } from './model-aliases.ts';

const DIRECTIVE_RE = /^\s*\[([^\]]*)\]\s*([\s\S]*)/;

export function parseDirectives(text: string): ParsedPrompt {
  const match = text.match(DIRECTIVE_RE);
  if (!match) return { prompt: text, directives: {} };

  const raw = match[1].trim();
  const prompt = match[2].trim();
  if (!raw) return { prompt, directives: {} };

  const directives: Directives = {};
  let positionalIndex = 0;

  for (const token of raw.split(',')) {
    const t = token.trim();
    if (!t) continue;

    const colonIdx = t.indexOf(':');
    if (colonIdx !== -1) {
      const key = t.slice(0, colonIdx).trim().toLowerCase();
      const val = t.slice(colonIdx + 1).trim().toLowerCase();
      applyDirective(directives, key, val);
    } else {
      const val = t.toLowerCase();
      if (positionalIndex === 0 && MODEL_ALIASES[val]) {
        directives.model = MODEL_ALIASES[val];
      } else if (positionalIndex <= 1 && /^\d+$/.test(val)) {
        directives.turns = parseInt(val, 10);
      } else if (['think', 'adaptive'].includes(val)) {
        directives.thinking = 'adaptive';
      } else if (['nothink', 'nothinking'].includes(val)) {
        directives.thinking = 'disabled';
      } else if (positionalIndex === 0) {
        console.warn(`[directives] Unknown model alias: "${t}"`);
      }
      positionalIndex++;
    }
  }

  return { prompt, directives };
}

function applyDirective(d: Directives, key: string, val: string) {
  switch (key) {
    case 'model':
      if (MODEL_ALIASES[val]) d.model = MODEL_ALIASES[val];
      else console.warn(`[directives] Unknown model alias: "${val}"`);
      break;
    case 'turns':
      if (/^\d+$/.test(val)) d.turns = parseInt(val, 10);
      else console.warn(`[directives] Invalid turns value: "${val}"`);
      break;
    case 'thinking':
    case 'think':
      if (['adaptive', 'enabled', 'disabled'].includes(val)) d.thinking = val as Directives['thinking'];
      else console.warn(`[directives] Invalid thinking value: "${val}"`);
      break;
    case 'effort':
      if (['low', 'medium', 'high', 'max'].includes(val)) d.effort = val as Directives['effort'];
      else console.warn(`[directives] Invalid effort value: "${val}"`);
      break;
    case 'engine':
      d.engine = val;
      break;
    default:
      console.warn(`[directives] Unknown directive key: "${key}"`);
  }
}
