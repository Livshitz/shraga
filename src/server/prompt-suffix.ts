// System-prompt-suffix seam — a generic drop-in for optional add-ons to append text to the agent's
// system prompt, decided per-turn off the opaque hints bag.
//
// Every turn, each engine appends whatever the registered contributors return. A contributor reads its
// OWN keys off the opaque `turnHints` bag (the core interprets none) and returns a suffix — or '' to
// contribute nothing. The core owns only this seam: it names no add-on concept (voice, etc.). With no
// contributor registered (CE's own state) the suffix is '' and the assembled prompt is byte-identical
// to before. An add-on (e.g. shraga-ee's voice feature) registers a contributor that returns its own
// bundled suffix when its marker (e.g. `turnHints.voice`) is present.
//
// Sibling of `turn-context.ts` and shaped like it: typed, optional, registered before startup, a no-op
// when nothing registers.

/** Return a system-prompt suffix for this turn (trimmed by the seam), or '' to contribute nothing.
 *  Reads its own keys off the opaque per-turn hints bag. */
export type PromptSuffixContributor = (turnHints?: Record<string, unknown>) => string;

const contributors: PromptSuffixContributor[] = [];

/** Register a prompt-suffix contributor. Called by an optional add-on before startup. */
export function registerPromptSuffix(fn: PromptSuffixContributor): void {
  contributors.push(fn);
}

/** The combined suffix for this turn, or '' when nothing contributes. A throwing contributor is
 *  contained (logged, skipped) so a broken add-on can't take down a turn. */
export function getPromptSuffix(turnHints?: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const fn of contributors) {
    try {
      const s = fn(turnHints)?.trim();
      if (s) parts.push(s);
    } catch (err) {
      console.error('[prompt-suffix] contributor failed:', (err as Error)?.message ?? err);
    }
  }
  return parts.join('\n\n');
}
