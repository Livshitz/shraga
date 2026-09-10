/**
 * Reading and rewriting the leading `[engine:…,model:…]` runtime directive of a prompt.
 *
 * The directive IS the selection — there is no separate stored field to shadow it — so the
 * schedule editor's runtime picker is just a view onto this text. Both halves reuse the server's
 * own parser (`src/server/directives.ts`), never a second one: a divergent client opinion would
 * either strip a token the server still reads or keep one it doesn't.
 */
import { parseDirectives, splitDirectiveGroups, resolveModelAlias } from '../../server/directives.ts';

export interface RuntimeSelection {
  engine?: string;
  model?: string;
}

export interface ReadSelection extends RuntimeSelection {
  /** Was the engine WRITTEN as `engine:…`, or merely implied by an engine-owned model token?
   *  An implied engine must not be treated as a choice — narrowing a model picker to it would trap
   *  a model-only directive inside one engine's list, with no way to pick another engine's model. */
  engineExplicit: boolean;
}

/** What the server will actually run this prompt on, as written. Includes a directive the user
 *  typed by hand, and an engine implied by a bare engine-owned model token (`[composer-2.5]`). */
export function readRuntimeDirective(text: string): ReadSelection {
  const { directives } = parseDirectives(text);
  const engineExplicit = splitDirectiveGroups(text, { strict: true }).groups.some((g) =>
    g.split(',').some((t) => /^\s*engine\s*:/i.test(t)));
  return { engine: directives.engine, model: directives.model, engineExplicit };
}

const RUNTIME_KEY_RE = /^(engine|model)\s*:/i;

/**
 * Replaces the runtime selection in place, preserving every other directive (turns, thinking,
 * effort) and the prompt body verbatim.
 *
 * Strict group scanning: unlike the server parser — which by contract consumes its first bracket
 * group even when it is nonsense — this only touches groups that actually READ as directives, so a
 * prompt whose body legitimately opens with `[WARN] …` is left alone and gets the pin prepended.
 */
export function writeRuntimeDirective(text: string, sel: RuntimeSelection): string {
  const { groups, body } = splitDirectiveGroups(text, { strict: true });
  const kept: string[] = [];
  // Mirrors the parser's positional rule: only the FIRST positional token can be a model.
  let seenPositional = false;
  for (const group of groups) {
    for (const raw of group.split(',').map((t) => t.trim()).filter(Boolean)) {
      if (RUNTIME_KEY_RE.test(raw)) continue; // the pin being replaced
      if (raw.includes(':')) { kept.push(raw); continue; }
      const isBareModel = !seenPositional && !!resolveModelAlias(raw);
      seenPositional = true;
      if (!isBareModel) kept.push(raw); // `120` (turns), `think` — not ours to touch
    }
  }
  // An engine the chosen model already implies is not written: `[model:cursor/composer-2.5]` and
  // `[engine:ext-agent,model:cursor/composer-2.5]` mean the same thing to the parser, and emitting the
  // longer one would stamp a pin the user never chose onto every schedule that carries a model-only
  // directive (11 of the 15 live ones) the moment the picker is touched.
  const impliedEngine = sel.model ? resolveModelAlias(sel.model)?.engine : undefined;
  const engine = sel.engine && sel.engine !== impliedEngine ? sel.engine : undefined;
  const pins = [engine && `engine:${engine}`, sel.model && `model:${sel.model}`].filter(Boolean) as string[];
  const tokens = [...pins, ...kept];
  return tokens.length ? `[${tokens.join(',')}] ${body}` : body;
}
