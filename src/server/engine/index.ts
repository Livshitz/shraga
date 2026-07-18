export type { AgentEngine, EngineStreamOpts, EngineModel } from './types.ts';
export { registerEngine, getEngine, getAvailableEngines, hasEngine } from './registry.ts';
export { ClaudeCodeEngine } from './claude-code.ts';

import { registerEngine, getEngine, getAvailableEngines, hasEngine } from './registry.ts';
import { ClaudeCodeEngine } from './claude-code.ts';

let _initialized = false;

export async function initEngines(): Promise<void> {
  if (_initialized) return;
  _initialized = true;

  // Core always registers the Claude Code engine (the CE default — @anthropic-ai/claude-agent-sdk).
  // Optional engines are registered by an add-on through the same `registerEngine` seam when the
  // SHRAGA_OVERLAY loads (it's imported before the server serves any turn). Bare CE runs Claude Code
  // only; a directive requesting an unregistered engine falls back to claude-code (resolveAndGetEngine).
  registerEngine(new ClaudeCodeEngine());

  console.log(`[engine] Available engines: ${getAvailableEngines().join(', ')}`);
}

/** Resolve which engine to use: directive > agent-config.json > default */
export function resolveEngine(directives?: { engine?: string }, agentConfig?: { engine?: string }): string {
  if (directives?.engine) return directives.engine;
  if (agentConfig?.engine) return agentConfig.engine;
  return 'claude-code';
}

export function resolveAndGetEngine(directives?: { engine?: string }, agentConfig?: { engine?: string }) {
  const name = resolveEngine(directives, agentConfig);
  // An optional engine may be unregistered on a given boot (add-on not loaded, missing API key or
  // failed init). Don't let that throw and kill every run — including scheduled jobs like the daily
  // digest, which resolve the engine from the global agent-config. Fall back to the always-present
  // claude-code engine with a warning instead.
  if (!hasEngine(name)) {
    console.warn(`[engine] "${name}" not registered (available: ${getAvailableEngines().join(', ') || 'none'}) — falling back to claude-code`);
    return getEngine('claude-code');
  }
  return getEngine(name);
}
