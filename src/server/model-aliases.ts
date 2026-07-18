/**
 * Model aliasing + mid-conversation switch resolution — pure, dependency-free.
 *
 * The shared mechanism every model consumer in Shraga uses to resolve `[opus]`-style aliases,
 * gate by an allow-list, and announce a switch identically. Policy (which models a caller may
 * use) and session state (the prior model) stay with the consumer; this module is the mechanism.
 */

/** Canonical short aliases → concrete Anthropic model ids. */
export const MODEL_ALIASES: Record<string, string> = {
  fable: 'claude-fable-5',
  'fable-5': 'claude-fable-5',
  opus: 'claude-opus-4-8',
  'opus-4-8': 'claude-opus-4-8',
  'opus-4-7': 'claude-opus-4-7',
  'opus-4-6': 'claude-opus-4-6',
  sonnet: 'claude-sonnet-5',
  'sonnet-5': 'claude-sonnet-5',
  'sonnet-4-6': 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5-20251001',
};

/** Resolve an alias to a concrete id. A provider prefix ("anthropic/") is preserved; unknown ids pass through. */
export function resolveModelAlias(input: string): string {
  const slash = input.indexOf('/');
  const prefix = slash === -1 ? '' : input.slice(0, slash + 1);
  const rest = slash === -1 ? input : input.slice(slash + 1);
  return prefix + (MODEL_ALIASES[rest.toLowerCase()] ?? rest);
}

/** Short, human-friendly name for a resolved model id (e.g. "anthropic/claude-opus-4-8" → "opus"). */
export function modelShortLabel(model?: string): string {
  if (!model) return 'default';
  const id = model.split('/').pop()!;
  return id.replace(/^claude-/, '').replace(/-\d.*$/, '');
}

export interface ResolveModelSwitchOpts {
  /** Model requested for this turn (e.g. from an inline directive). Undefined = keep `current`. */
  requested?: string;
  /** The turn's default/current model when nothing is requested. */
  current: string;
  /** The session's prior resolved model — drives change detection + the notice. */
  prior?: string;
  /** If set, `requested` must match one of these (by short label) or it's denied and `current` is kept. */
  allowed?: string[];
  /** Announcement formatter. Default: `_[switching from x to y]_\n\n`. */
  format?: (from: string, to: string) => string;
}

export interface ModelSwitch {
  /** The model to run this turn. */
  model: string;
  /** True when `requested` was rejected by `allowed` and `model` fell back to `current`. */
  denied: boolean;
  /** Inline notice to surface when the model actually changed vs `prior`, else undefined. */
  notice?: string;
}

/**
 * Resolve which model a turn runs, given an optional request, an allow-list, and the prior model.
 * Comparisons are by short label so provider-prefixed and dated ids unify
 * ("anthropic/claude-opus-4-8" ≡ "claude-opus-4-8" ≡ "opus").
 */
export function resolveModelSwitch(opts: ResolveModelSwitchOpts): ModelSwitch {
  const { requested, current, prior, allowed } = opts;
  if (!requested) return { model: current, denied: false };
  if (allowed && !allowed.some((a) => modelShortLabel(a) === modelShortLabel(requested))) {
    return { model: current, denied: true };
  }
  const fmt = opts.format ?? ((from: string, to: string) => `_[switching from ${from} to ${to}]_\n\n`);
  const changed = prior !== undefined && modelShortLabel(prior) !== modelShortLabel(requested);
  return {
    model: requested,
    denied: false,
    notice: changed ? fmt(modelShortLabel(prior!), modelShortLabel(requested)) : undefined,
  };
}
