import type { AgentEngine } from './types.ts';

const engines = new Map<string, AgentEngine>();

export function registerEngine(engine: AgentEngine): void {
  engines.set(engine.name, engine);
}

export function getEngine(name: string): AgentEngine {
  const engine = engines.get(name);
  if (!engine) throw new Error(`Unknown engine: ${name}. Available: ${[...engines.keys()].join(', ')}`);
  return engine;
}

export function getAvailableEngines(): string[] {
  return [...engines.keys()];
}

export function hasEngine(name: string): boolean {
  return engines.has(name);
}
