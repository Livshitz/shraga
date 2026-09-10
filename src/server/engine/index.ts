export type { AgentEngine, EngineStreamOpts, EngineModel } from './types.ts';
export { registerEngine, getEngine, getAvailableEngines, hasEngine } from './registry.ts';
export { ClaudeCodeEngine } from './claude-code.ts';

import { registerEngine, getEngine, getAvailableEngines, hasEngine } from './registry.ts';
import { ClaudeCodeEngine } from './claude-code.ts';
import { setModelResolver } from '../directives.ts';
import { makeModelResolver } from './model-resolver.ts';

let _initialized = false;

export async function initEngines(): Promise<void> {
  if (_initialized) return;
  _initialized = true;

  // Core always registers the Claude Code engine (the CE default — @anthropic-ai/claude-agent-sdk).
  // Optional engines are registered by an add-on through the same `registerEngine` seam when the
  // SHRAGA_OVERLAY loads (it's imported before the server serves any turn). Bare CE runs Claude Code
  // only; a directive requesting an unregistered engine FAILS the turn (resolveAndGetEngine) rather
  // than rerouting to another vendor's billing.
  registerEngine(new ClaudeCodeEngine());

  // Let `[<model>]` name ANY registered engine's model (e.g. `[composer-2.5]`) and imply its engine.
  // Resolved lazily on each parse so engines an add-on registers later are covered too. The rule
  // itself is shared with the client's directive editor — see makeModelResolver.
  setModelResolver(makeModelResolver(() => getAvailableEngines().map((name) => ({ name, models: getEngine(name).getModels() }))));

  console.log(`[engine] Available engines: ${getAvailableEngines().join(', ')}`);
}

/** Resolve which engine to use: directive > agent-config.json > default */
export function resolveEngine(directives?: { engine?: string }, agentConfig?: { engine?: string }): string {
  if (directives?.engine) return directives.engine;
  if (agentConfig?.engine) return agentConfig.engine;
  return 'claude-code';
}

/** Requested engine isn't registered on this boot. Carries an actionable message; callers surface it
 *  as a turn error (see streamClaude) — never as a reroute to a different vendor's engine/billing. */
export class EngineUnavailableError extends Error {
  constructor(public readonly engine: string, available: string[]) {
    super(
      `Engine "${engine}" is not available on this server. Registered engines: ${available.join(', ') || 'none'}. ` +
        `Optional engines register only when enabled at boot (AGENT_ENGINES must list the engine; the native ` +
        `cursor engine also needs CURSOR_API_KEY) — check the server env and startup log, then retry. ` +
        `The run was stopped rather than silently re-routed to another provider's billing.`,
    );
    this.name = 'EngineUnavailableError';
  }
}

/** An explicitly selected model that neither the alias table nor any REGISTERED engine could
 *  resolve. Same contract as EngineUnavailableError: the run stops instead of silently continuing
 *  on the instance default, which is a different model than the caller chose. */
export class ModelUnavailableError extends Error {
  constructor(public readonly model: string) {
    super(
      `Model "${model}" could not be resolved on this server. It is not a known alias, not a ` +
        `provider-qualified id (\`provider/model\`), and no registered engine advertises it. ` +
        `Registered engines: ${getAvailableEngines().join(', ') || 'none'} — an engine registers only when enabled ` +
        `at boot (AGENT_ENGINES must list it; the native cursor engine also needs CURSOR_API_KEY), ` +
        `so a model owned by an absent engine cannot resolve. Check the server env and startup log. ` +
        `The run was stopped rather than silently re-routed to the instance's default model.`,
    );
    this.name = 'ModelUnavailableError';
  }
}

export function resolveAndGetEngine(directives?: { engine?: string }, agentConfig?: { engine?: string }) {
  const name = resolveEngine(directives, agentConfig);
  // An optional engine may be unregistered on a given boot (add-on not loaded, missing API key or
  // failed init). Rerouting to claude-code here silently switched PROVIDER AND BILLING under the
  // caller — an add-on engine's run billed Anthropic while the UI still showed the cursor chips. Fail
  // loudly instead; the degradation is surfaced to whoever asked (user, schedule) as a turn error.
  if (!hasEngine(name)) throw new EngineUnavailableError(name, getAvailableEngines());
  return getEngine(name);
}
