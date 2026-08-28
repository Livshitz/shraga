export type { AgentEngine, EngineStreamOpts, EngineModel } from './types.ts';
export { registerEngine, getEngine, getAvailableEngines, hasEngine } from './registry.ts';
export { ClaudeCodeEngine } from './claude-code.ts';

import { registerEngine, getEngine, getAvailableEngines, hasEngine } from './registry.ts';
import { ClaudeCodeEngine } from './claude-code.ts';
import { setModelResolver } from '../directives.ts';

let _initialized = false;

export async function initEngines(): Promise<void> {
  if (_initialized) return;
  _initialized = true;

  // Core always registers the Claude Code engine (the CE default — @anthropic-ai/claude-agent-sdk).
  // Optional engines are registered by an add-on through the same `registerEngine` seam when the
  // SHRAGA_OVERLAY loads (it's imported before the server serves any turn). Bare CE runs Claude Code
  // only; a directive requesting an unregistered engine falls back to claude-code (resolveAndGetEngine).
  registerEngine(new ClaudeCodeEngine());

  // Let `[<model>]` name ANY registered engine's model (e.g. `[composer-2.5]`) and imply its engine.
  // Resolved lazily on each parse so engines an add-on registers later are covered too.
  // `[composer-2.5]` must reach the engine's real id (`cursor/composer-2.5`), so an exact match is
  // tried first, then the bare suffix after the provider prefix — and ONLY when it is unambiguous
  // across engines, so a name two engines share is never silently routed to whichever came first.
  setModelResolver((token) => {
    const t = token.toLowerCase();
    const hits: { model: string; engine: string }[] = [];
    for (const name of getAvailableEngines()) {
      for (const m of getEngine(name).getModels()) {
        if (!m.value) continue;
        const v = m.value.toLowerCase();
        if (v === t) return { model: m.value, engine: name };
        if (v.slice(v.lastIndexOf('/') + 1) === t) hits.push({ model: m.value, engine: name });
      }
    }
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) console.warn(`[directives] Ambiguous model "${token}" (${hits.map((h) => `${h.engine}:${h.model}`).join(', ')}) — use the full id`);
    return null;
  });

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
