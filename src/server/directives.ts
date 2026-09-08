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
  /** An EXPLICIT model selection that no alias and no registered engine could resolve. Reported
   *  instead of applied: dropping it (the old behaviour) ran the turn on `config.model` — a
   *  DIFFERENT model than the caller asked for, with nothing but a `console.warn` to show for it.
   *  The caller turns this into a turn error; see `streamChat`. */
  unresolvedModel?: string;
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

const DIRECTIVE_KEYS = ['model', 'turns', 'thinking', 'think', 'effort', 'engine'];

/** MODEL_ALIASES only covers the bare Anthropic shorthands. A `provider/model` id
 *  (`cursor/composer-2.5`, `openai/gpt-5.6`) is already concrete — gating it on the alias table
 *  silently dropped it and ran the instance default instead. As a bare positional it is honoured
 *  only when a REGISTERED engine actually advertises it (see the resolver below) — an arbitrary
 *  `[src/foo.ts]` stays prompt text, which is what a second bracket group must not swallow. */
const isQualifiedModel = (v: string) => /^[a-z0-9._-]+\/[a-z0-9./_-]+$/.test(v);

/** Resolves a model token the alias table doesn't know against the REGISTERED engines' own model
 *  lists, and reports which engine owns it. Without this, `[composer-2.5]` (an agentx model) was
 *  warned about and dropped, so the turn silently ran on the previous engine/model. Injected by
 *  `initEngines()` — directives.ts stays pure and dependency-free for CE and for tests. */
export type ModelResolver = (token: string) => { model: string; engine?: string } | null;
let modelResolver: ModelResolver | null = null;
export function setModelResolver(fn: ModelResolver | null): void { modelResolver = fn; }

/** Alias table first (canonical shorthands win), then the engine registry. Exported because the
 *  client's directive editor needs the SAME verdict on "is this bare token a model?" as the parser —
 *  a second opinion there would strip a token the server still reads, or keep one it doesn't. */
export function resolveModelAlias(token: string): { model: string; engine?: string } | null {
  const v = token.trim().toLowerCase();
  if (MODEL_ALIASES[v]) return { model: MODEL_ALIASES[v] };
  return modelResolver?.(v) ?? null;
}

function resolveModelToken(d: Directives, val: string): boolean {
  const hit = resolveModelAlias(val);
  if (!hit) return false;
  d.model = hit.model;
  // An engine-owned model implies its engine — but never override an explicit `[engine:x]`.
  if (hit.engine && !d.engine) d.engine = hit.engine;
  return true;
}

/** Does a bracket group look like directives (vs. prompt text that happens to start with `[`)?
 * Every token must be a known key:value or a known positional, else we leave the group alone. */
export function isDirectiveGroup(raw: string): boolean {
  const tokens = raw.split(',').map((t) => t.trim()).filter(Boolean);
  if (!tokens.length) return false;
  return tokens.every((t) => {
    const colonIdx = t.indexOf(':');
    if (colonIdx !== -1) return DIRECTIVE_KEYS.includes(t.slice(0, colonIdx).trim().toLowerCase());
    const v = t.toLowerCase();
    return !!MODEL_ALIASES[v] || !!modelResolver?.(v) || /^\d+$/.test(v) || ['think', 'adaptive', 'nothink', 'nothinking'].includes(v);
  });
}

/** Splits the leading `[..]` directive groups off a prompt — the single answer to "where do the
 *  directives end". Consumes EVERY consecutive leading group, not just the first: a prompt may
 *  legitimately open with `[engine:x,model:y] [turns:120] …`, and a single-group scan silently
 *  dropped the second (a schedule pinned to opus quietly ran on the config default for three days).
 *
 *  `strict` requires every group — the first included — to actually look like directives. The parser
 *  stays lenient there (long-standing contract: `[unknown] hi` strips the group and warns), but an
 *  EDITOR rewriting the directive in place must never swallow a prompt whose body legitimately opens
 *  with bracketed prose. */
export function splitDirectiveGroups(text: string, opts?: { strict?: boolean }): { groups: string[]; body: string } {
  let rest = text;
  const groups: string[] = [];
  for (;;) {
    const m = rest.match(DIRECTIVE_RE);
    if (!m) break;
    const g = m[1].trim();
    if ((groups.length || opts?.strict) && g && !isDirectiveGroup(g)) break;
    groups.push(g);
    rest = m[2];
  }
  return { groups, body: rest };
}

export function parseDirectives(text: string): ParsedPrompt {
  const { groups, body: rest } = splitDirectiveGroups(text);
  if (!groups.length) return { prompt: text, directives: {} };

  const raw = groups.filter(Boolean).join(',');
  const prompt = rest.trim();
  if (!raw) return { prompt, directives: {} };

  const directives: Directives = {};
  let positionalIndex = 0;
  let unresolvedModel: string | undefined;

  const tokens = raw.split(',');
  // Is this group PROVABLY a directive group (some token is a known `key:value`)? A bare positional
  // that resolves to nothing is otherwise indistinguishable from prose — `[some bracketed text] hi`
  // is a legitimate prompt and must never fail a turn. With a keyed sibling present the group is
  // unambiguously directives, so an unresolvable leading model token there IS a dropped selection.
  const provenDirectiveGroup = tokens.some((t) => {
    const i = t.indexOf(':');
    return i !== -1 && DIRECTIVE_KEYS.includes(t.slice(0, i).trim().toLowerCase());
  });

  for (const token of tokens) {
    const t = token.trim();
    if (!t) continue;

    const colonIdx = t.indexOf(':');
    if (colonIdx !== -1) {
      const key = t.slice(0, colonIdx).trim().toLowerCase();
      const val = t.slice(colonIdx + 1).trim().toLowerCase();
      unresolvedModel = applyDirective(directives, key, val) ?? unresolvedModel;
    } else {
      const val = t.toLowerCase();
      if (positionalIndex === 0 && resolveModelToken(directives, val)) {
        // handled
      } else if (positionalIndex <= 1 && /^\d+$/.test(val)) {
        directives.turns = parseInt(val, 10);
      } else if (['think', 'adaptive'].includes(val)) {
        directives.thinking = 'adaptive';
      } else if (['nothink', 'nothinking'].includes(val)) {
        directives.thinking = 'disabled';
      } else if (positionalIndex === 0) {
        if (provenDirectiveGroup && !isQualifiedModel(val)) unresolvedModel ??= t;
        console.warn(isQualifiedModel(val)
          ? `[directives] Provider-qualified model needs key form: "[model:${t}]"`
          : `[directives] Unknown model alias: "${t}"`);
      }
      positionalIndex++;
    }
  }

  return { prompt, directives, unresolvedModel };
}

/** Returns the token of an EXPLICIT model selection it could not resolve, else undefined. */
function applyDirective(d: Directives, key: string, val: string): string | undefined {
  switch (key) {
    case 'model':
      if (resolveModelToken(d, val)) break;
      // A `provider/model` id is already concrete — hand it to the engine, which owns the verdict.
      if (isQualifiedModel(val)) { d.model = val; break; }
      // Nothing knows this token. `[model:x]` is unambiguously a selection (never prose), so the
      // turn must not quietly continue on the instance default model.
      return val;
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
  return undefined;
}
