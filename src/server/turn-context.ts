// Turn-context seam — per-turn prompt contributions from optional add-ons.
//
// The core builds a turn's prompt and knows nothing about what an add-on might want to say about the
// user's current situation. A contributor returns a short block that is prepended to THIS turn's
// prompt only — never the cacheable contextBlock, never the persisted transcript.
//
// Sibling of the `features.ts` seam and shaped like it: typed, optional, registered before startup,
// a no-op when nothing is registered (the core registers NOTHING here). The core concatenates
// whatever comes back and interprets none of it.

/** What the core knows about the turn. `hints` is the opaque client-supplied per-send bag (the
 *  client's `setSendOptions` slot) — the core never interprets it; a contributor reads its own keys. */
export interface TurnContextInput {
  sessionId?: string;
  uid?: string;
  hints?: Record<string, unknown>;
}

/** Return a prompt block for this turn, or undefined/'' to contribute nothing. */
export type TurnContextContributor = (input: TurnContextInput) => string | undefined;

const contributors = new Map<string, TurnContextContributor>();

/** Register a per-turn prompt contributor. Called by an add-on before startup. Idempotent by name. */
export function registerTurnContext(name: string, contribute: TurnContextContributor): void {
  if (contributors.has(name)) return;
  contributors.set(name, contribute);
}

/** Clear all registered contributors. For tests: the registry is a process-global, so a test that
 *  asserts the empty-registry (no-contributor) behavior must reset it first or it inherits whatever
 *  another test file registered — bun's cross-file order is not stable across platforms. */
export function clearTurnContext(): void {
  contributors.clear();
}

/**
 * Collect every contributor's block for this turn, joined by a blank line. Empty when none is
 * registered — which is the core's own state, so the core's prompt is byte-identical to before.
 * A throwing contributor is contained (logged, others still contribute): a broken add-on must not
 * take down a turn.
 */
export function collectTurnContext(input: TurnContextInput): string {
  const blocks: string[] = [];
  for (const [name, contribute] of contributors) {
    try {
      const block = contribute(input)?.trim();
      if (block) blocks.push(block);
    } catch (err) {
      console.error(`[turn-context] ${name} failed:`, (err as Error)?.message ?? err);
    }
  }
  return blocks.join('\n\n');
}

/**
 * Sanitize a client-supplied hint value before a contributor interpolates it into the model prompt.
 * Strips control chars/newlines and caps length, so a crafted value can't forge a second block or
 * inject instructions. Generic (knows no add-on shape) and lives here because EVERY contributor
 * interpolates untrusted `hints` — keeping it on the seam makes the requirement discoverable.
 */
export function sanitizeHintField(value: string, max: number): string {
  return Array.from(value)
    .filter((c) => { const n = c.charCodeAt(0); return n >= 32 && n !== 127; })
    .join('')
    .slice(0, max)
    .trim();
}
