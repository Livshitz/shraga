import type { ModelResolver } from '../directives.ts';

/** Engine → the model ids it advertises. Exactly what `GET /api/engines` serves, so the client
 *  can build the SAME resolver the server parses with. */
export interface EngineModels {
  name: string;
  models: { value: string }[];
}

/**
 * Lets `[<model>]` name ANY registered engine's model (e.g. `[composer-2.5]`) and imply its engine.
 *
 * `[composer-2.5]` must reach the engine's real id (`cursor/composer-2.5`), so an exact match is
 * tried first, then the bare suffix after the provider prefix — and ONLY when it is unambiguous
 * across engines, so a name two engines share is never silently routed to whichever came first.
 *
 * Pure and dependency-free: the server passes a live view of its registry (so engines an add-on
 * registers later are covered), the client passes what `/api/engines` returned.
 */
export function makeModelResolver(engines: () => EngineModels[]): ModelResolver {
  return (token) => {
    const t = token.toLowerCase();
    const hits: { model: string; engine: string }[] = [];
    for (const { name, models } of engines()) {
      for (const m of models) {
        if (!m.value) continue;
        const v = m.value.toLowerCase();
        if (v === t) return { model: m.value, engine: name };
        if (v.slice(v.lastIndexOf('/') + 1) === t) hits.push({ model: m.value, engine: name });
      }
    }
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) console.warn(`[directives] Ambiguous model "${token}" (${hits.map((h) => `${h.engine}:${h.model}`).join(', ')}) — use the full id`);
    return null;
  };
}
