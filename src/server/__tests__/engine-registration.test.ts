import { describe, test, expect } from 'bun:test';

/**
 * Pins the engine-registration seam that lets CE ship with ONLY the Claude Code engine while an
 * optional add-on (SHRAGA_OVERLAY) contributes more engines through the same `registerEngine` export.
 *
 * The trap this guards: CE's initEngines() could regress to naming/constructing an add-on engine
 * itself (re-coupling CE to an add-on runtime), or resolveAndGetEngine() could go back to silently
 * REROUTING an unregistered engine to claude-code — which switched provider and billing under the
 * caller while the UI still reported the requested one. This test names no add-on engine either; it
 * uses a neutral placeholder for "some engine only an overlay would register".
 *
 * DATA_DIR comes from the shared preload (bunfig.toml → setup.ts).
 */
const { initEngines, resolveAndGetEngine, getAvailableEngines, EngineUnavailableError } = await import('../engine/index.ts');
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

  test('a directive for an unregistered engine FAILS LOUDLY — never reroutes to claude-code', () => {
    expect(hasEngine(OVERLAY_ENGINE)).toBe(false);
    expect(() => resolveAndGetEngine({ engine: OVERLAY_ENGINE })).toThrow(EngineUnavailableError);
    // The message has to be actionable: the missing engine, what IS registered, and the env gate.
    let msg = '';
    try { resolveAndGetEngine({ engine: OVERLAY_ENGINE }); } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain(OVERLAY_ENGINE);
    expect(msg).toContain('claude-code');
    expect(msg).toContain('AGENT_ENGINES');
  });

  test('a bare CE boot (no engine requested anywhere) still resolves — not bricked', () => {
    expect(resolveAndGetEngine().name).toBe('claude-code');
    expect(resolveAndGetEngine({}, {}).name).toBe('claude-code');
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
    // claude-code still resolvable; an unknown engine still fails rather than borrowing its billing.
    expect(resolveAndGetEngine({ engine: 'claude-code' }).name).toBe('claude-code');
    expect(() => resolveAndGetEngine({ engine: 'nope-not-registered' })).toThrow(EngineUnavailableError);
  });
});
