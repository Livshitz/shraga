import { describe, test, expect, beforeEach } from 'bun:test';
import { tmpdir } from 'node:os';

/**
 * Pins the WIRING, not just the seam module.
 *
 * turn-context.test.ts proves the seam's own contract — but it would stay green if someone deleted the
 * `collectTurnContext(...)` call from `streamChat`, leaving the seam as dead code and add-ons silently
 * mute. This drives the real consumer surface instead: a fake engine captures the prompt `streamChat`
 * actually hands it, and asserts a contributor's block arrived in front of it.
 *
 * Hermetic:
 *  - DATA_DIR comes from the shared test preload (bunfig.toml → setup.ts), which mints ONE temp dir
 *    before any test module imports paths.ts. Minting another one here would re-introduce exactly the
 *    race that preload exists to kill (it broke prompt-file.test.ts when this file did that).
 *  - data-sync is disarmed: a dev shell can carry DATA_SYNC_REPO + DATA_SYNC_ENABLE=1, which makes
 *    `isEnabled()` true. `init()` is never called here (so `ready` stays false and `trackWrite` is a
 *    no-op), but a test must not depend on that to avoid pushing to a shared repo.
 */
delete process.env.DATA_SYNC_ENABLE;
delete process.env.DATA_SYNC_REPO;

const { DATA_DIR } = await import('../paths.ts');
const { registerEngine } = await import('../engine/index.ts');
const { registerTurnContext, clearTurnContext } = await import('../turn-context.ts');
const { streamChat } = await import('../claude.ts');

let seenPrompt: string | null = null;
registerEngine({
  name: 'wiring-probe-engine',
  async *stream(opts: { prompt: string }) { seenPrompt = opts.prompt; },
  getModels: () => [],
} as unknown as Parameters<typeof registerEngine>[0]);

async function runTurn(prompt: string, turnHints?: Record<string, unknown>): Promise<string> {
  seenPrompt = null;
  for await (const _ of streamChat({
    prompt: `[engine:wiring-probe-engine] ${prompt}`,
    sessionId: `wiring-${Math.random().toString(36).slice(2)}`,
    uid: 'u-wiring',
    userEmail: 'wiring@example.test',
    turnHints,
  })) { /* drain */ }
  if (seenPrompt === null) throw new Error('probe engine never ran — streamChat did not reach the engine');
  return seenPrompt;
}

describe('turn-context wiring (streamChat → seam → engine prompt)', () => {
  // The turn-context registry is a process-global shared with other test files; bun's cross-file
  // order isn't stable across platforms. Reset before each test so the empty-registry assertions
  // hold regardless of what another file registered first.
  beforeEach(() => clearTurnContext());

  // Safety net: this test drives streamChat, which upserts a session + writes to DATA_DIR. If the
  // preload ever stopped winning the import race, that would land in the REPO's ./data — fail loudly.
  test('DATA_DIR is the preload temp dir — never the repo data dir', () => {
    expect(DATA_DIR.startsWith(tmpdir())).toBe(true);
    expect(DATA_DIR).not.toContain('Livshitz/shraga/data');
  });

  test('with NO contributor, the engine prompt is the plain prompt (core injects nothing)', async () => {
    const got = await runTurn('plain hello');
    expect(got).toBe('plain hello');
  });

  test('a contributor block is prepended to the prompt the engine receives', async () => {
    registerTurnContext('wiring-probe', ({ hints }) =>
      hints?.mark ? `[probe] mark=${String(hints.mark)}` : undefined,
    );
    const got = await runTurn('do the thing', { mark: 'XYZ' });
    expect(got).toBe('[probe] mark=XYZ\n\ndo the thing');
  });

  // The opaque bag must reach the contributor untouched — this is what lets an add-on (not the core)
  // own the meaning of a hint like a focused terminal.
  test('turnHints reach the contributor verbatim; no hints ⇒ no injection', async () => {
    let seenHints: unknown = 'never-called';
    registerTurnContext('wiring-hints', ({ hints }) => { seenHints = hints; return undefined; });
    const nested = { focusedPty: { sessionId: 'abc', title: 't' } };
    await runTurn('x', nested);
    expect(seenHints).toEqual(nested);

    const got = await runTurn('bare prompt');
    expect(got).toBe('bare prompt');
  });
});
