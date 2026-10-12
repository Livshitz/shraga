import { describe, test, expect, afterAll } from 'bun:test';
import { fromInternal } from '../security/principal.ts';

/**
 * `scheduleModel`: unattended scheduled turns default to it instead of `model`, through the REAL
 * `streamChat` → engine seam. A probe engine records the model it would run (`directives.model ||
 * config.model`, the resolution every engine uses), so the assertions are about what reaches an engine.
 *
 * DATA_DIR comes from the shared preload (bunfig.toml → setup.ts).
 */
delete process.env.DATA_SYNC_ENABLE;
delete process.env.DATA_SYNC_REPO;

const { initEngines } = await import('../engine/index.ts');
const { registerEngine } = await import('../engine/registry.ts');
const { streamChat, getAgentConfig, saveAgentConfig } = await import('../claude.ts');

await initEngines();

let ranModel: string | undefined;
registerEngine({
  name: 'schedule-model-probe',
  async *stream(opts: { directives: { model?: string }; config: { model?: string } }) {
    ranModel = opts.directives.model || opts.config.model;
  },
  getModels: () => [],
} as unknown as Parameters<typeof registerEngine>[0]);

const before = getAgentConfig();
afterAll(() => saveAgentConfig(before));

async function modelFor(prompt: string, scheduled: boolean): Promise<string | undefined> {
  ranModel = undefined;
  for await (const _ of streamChat({
    prompt,
    sessionId: `schedmodel-${Math.random().toString(36).slice(2)}`,
    uid: 'u-sched',
    principal: fromInternal({ uid: 'u-sched', lane: 'scheduler' }),
    scheduled,
  })) { /* drain */ }
  return ranModel;
}

describe('scheduleModel', () => {
  test('a scheduled turn uses scheduleModel; an interactive one keeps model', async () => {
    saveAgentConfig({ ...before, engine: 'schedule-model-probe', model: 'claude-opus-5-5', scheduleModel: 'claude-sonnet-5' });
    expect(await modelFor('do the routine', true)).toBe('claude-sonnet-5');
    expect(await modelFor('hi', false)).toBe('claude-opus-5-5');
  });

  test('an explicit [model:…] directive in the scheduled prompt still wins', async () => {
    saveAgentConfig({ ...before, engine: 'schedule-model-probe', model: 'claude-opus-5-5', scheduleModel: 'claude-sonnet-5' });
    expect(await modelFor('[haiku] do the routine', true)).toBe('claude-haiku-4-5-20251001');
  });

  test('unset scheduleModel = unchanged behaviour (falls back to model)', async () => {
    saveAgentConfig({ ...before, engine: 'schedule-model-probe', model: 'claude-opus-5-5', scheduleModel: undefined });
    expect(await modelFor('do the routine', true)).toBe('claude-opus-5-5');
  });
});
