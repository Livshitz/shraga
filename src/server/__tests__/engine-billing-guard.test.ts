import { describe, test, expect } from 'bun:test';

/**
 * The provider/billing invariant, driven through the REAL consumer surface (`streamChat`), not through
 * the resolver in isolation:
 *
 *   a run must never execute on a provider other than the one it asked for.
 *
 * The incident this pins: a scheduled run requested `ext-agent` + `cursor/composer-2.5`, that engine was
 * not registered on that boot, and the resolver silently handed the turn to `claude-code` — which then
 * posted the Cursor model id to the Anthropic SDK. Three vendor-billed attempts later it failed on an
 * Anthropic org limit, while the UI still showed the Cursor chips. Both halves must fail loudly.
 *
 * DATA_DIR comes from the shared preload (bunfig.toml → setup.ts).
 */
delete process.env.DATA_SYNC_ENABLE;
delete process.env.DATA_SYNC_REPO;

const { initEngines } = await import('../engine/index.ts');
const { registerEngine, hasEngine } = await import('../engine/registry.ts');
const { streamChat, getAgentConfig, saveAgentConfig } = await import('../claude.ts');
import type { WsEvent } from '../claude.ts';

await initEngines();

/** A stand-in for the always-registered engine, so we can prove a REROUTE would have been observable:
 *  if the turn ever reaches claude-code, this records it. Registered under claude-code's own name is
 *  not possible without displacing it — so instead we detect a reroute by the absence of an error. */
let sawEngineRun = false;
registerEngine({
  name: 'billing-probe-engine',
  async *stream() { sawEngineRun = true; },
  getModels: () => [],
} as unknown as Parameters<typeof registerEngine>[0]);

async function runTurn(prompt: string): Promise<WsEvent[]> {
  sawEngineRun = false;
  const events: WsEvent[] = [];
  for await (const ev of streamChat({
    prompt,
    sessionId: `billing-${Math.random().toString(36).slice(2)}`,
    uid: 'u-billing',
    userEmail: 'billing@example.test',
  })) events.push(ev);
  return events;
}

describe('provider/billing guard (streamChat → engine)', () => {
  test('an unregistered engine ends the turn with an actionable error — it does NOT run on claude-code', async () => {
    expect(hasEngine('ext-agent')).toBe(false);
    const events = await runTurn('[engine:ext-agent] say hi');
    const err = events.find((e) => e.type === 'error') as Extract<WsEvent, { type: 'error' }> | undefined;
    expect(err).toBeDefined();
    expect(err!.message).toContain('ext-agent');
    // Actionable: what IS registered, and the env gate that would register the missing one.
    expect(err!.message).toContain('claude-code');
    expect(err!.message).toContain('AGENT_ENGINES');
    expect(err!.message).toContain('CURSOR_API_KEY');
    // And the turn produced NO model output — nothing was billed anywhere.
    expect(events.filter((e) => e.type === 'text_delta')).toHaveLength(0);
  });

  test('a registered engine still runs normally — a bare CE install is not bricked', async () => {
    const events = await runTurn('[engine:billing-probe-engine] say hi');
    expect(sawEngineRun).toBe(true);
    expect(events.find((e) => e.type === 'error')).toBeUndefined();
  });

  test('claude-code refuses a foreign model instead of posting it to the Anthropic SDK', async () => {
    // The exact live pin from the incident: a Cursor model, engine-less, landing on claude-code.
    const events = await runTurn('[model:cursor/composer-2.5] say hi');
    const err = events.find((e) => e.type === 'error') as Extract<WsEvent, { type: 'error' }> | undefined;
    expect(err).toBeDefined();
    expect(err!.message).toContain('cursor/composer-2.5');
    expect(err!.message).toContain('claude-code');
    expect(events.filter((e) => e.type === 'text_delta')).toHaveLength(0);
  });

  test('...including a BARE foreign id, which only agent-config.json can carry', async () => {
    // `[model:composer-2.5]` is REJECTED by parseDirectives (unknown alias) and never becomes a model,
    // so the live route for a bare foreign id is the global agent-config, which goes straight to the
    // engine unparsed. A prefix-only check would have let this reach the Anthropic SDK.
    const before = getAgentConfig();
    saveAgentConfig({ ...before, engine: 'claude-code', model: 'composer-2.5' });
    try {
      const events = await runTurn('say hi');
      const err = events.find((e) => e.type === 'error') as Extract<WsEvent, { type: 'error' }> | undefined;
      expect(err).toBeDefined();
      expect(err!.message).toContain('composer-2.5');
      expect(events.filter((e) => e.type === 'text_delta')).toHaveLength(0);
    } finally {
      saveAgentConfig(before);
    }
  });
});
