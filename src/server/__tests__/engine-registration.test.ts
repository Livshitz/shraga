import { describe, test, expect } from 'bun:test';

/**
 * Pins the engine-registration seam that lets CE ship with ONLY the Claude Code engine while an
 * optional add-on (SHRAGA_OVERLAY) contributes more engines through the same `registerEngine` export.
 *
 * The trap this guards: CE's initEngines() could regress to naming/constructing an add-on engine
 * itself (re-coupling CE to an add-on runtime), or resolveAndGetEngine() could stop falling back to
 * claude-code when a requested engine isn't registered (killing every turn on a bare-CE boot). Both
 * are exactly what an add-on-free CE must never do — so this test names no add-on engine either; it
 * uses a neutral placeholder for "some engine only an overlay would register".
 *
 * DATA_DIR comes from the shared preload (bunfig.toml → setup.ts).
 */
const { initEngines, resolveAndGetEngine, getAvailableEngines } = await import('../engine/index.ts');
const { registerEngine, hasEngine } = await import('../engine/registry.ts');
import type { AgentEngine } from '../engine/types.ts';

// A stand-in for any engine that only an overlay contributes — deliberately not a real add-on name.
const OVERLAY_ENGINE = 'overlay-only-engine';

describe('engine-registration seam (CE registers claude-code only; overlay adds the rest)', () => {
  test('bare CE registers claude-code and none of the overlay engines', async () => {
    await initEngines();
    expect(hasEngine('claude-code')).toBe(true);
    // Mutation guard: an overlay-only engine must NOT be present from bare CE init. If initEngines()
    // regressed to constructing add-on engines itself, an overlay engine would appear here.
    expect(hasEngine(OVERLAY_ENGINE)).toBe(false);
    // Presence/absence, not exact-array: the registry is a process-shared singleton and another test
    // file registers its own probe engine into it. The seam's invariant is that CE contributes
    // claude-code and NOT any overlay engine — which is exactly what these assert.
    expect(getAvailableEngines()).toContain('claude-code');
    expect(getAvailableEngines()).not.toContain(OVERLAY_ENGINE);
  });

  test('a directive for an unregistered engine falls back to claude-code (graceful degrade)', () => {
    // Before any overlay registers it, requesting an overlay engine must NOT throw — it degrades.
    expect(hasEngine(OVERLAY_ENGINE)).toBe(false);
    expect(resolveAndGetEngine({ engine: OVERLAY_ENGINE }).name).toBe('claude-code');
  });

  test('a simulated overlay registration adds the engine and resolveAndGetEngine picks it', () => {
    const fake: AgentEngine = {
      name: OVERLAY_ENGINE,
      getModels: () => [],
      // eslint-disable-next-line require-yield
      async *stream() { /* no-op fake */ },
    };
    registerEngine(fake); // the exact call an overlay makes at import time
    expect(hasEngine(OVERLAY_ENGINE)).toBe(true);
    expect(resolveAndGetEngine({ engine: OVERLAY_ENGINE }).name).toBe(OVERLAY_ENGINE);
    // claude-code still resolvable + still the fallback for an unknown engine.
    expect(resolveAndGetEngine({ engine: 'nope-not-registered' }).name).toBe('claude-code');
  });
});
