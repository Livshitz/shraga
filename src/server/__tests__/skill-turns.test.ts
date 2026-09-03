import { describe, test, expect, beforeAll } from 'bun:test';
import type { AgentEngine } from '../engine/types.ts';
import type { Directives } from '../directives.ts';

/**
 * Per-skill turn budget: `turns:` in a skill's frontmatter raises THAT skill's step ceiling without
 * touching the global `config.maxTurns` (default 15), which is what made a long pipeline silently
 * truncate mid-run.
 *
 * Precedence pinned here: inline `[turns:N]` > session-stored directive > skill frontmatter >
 * global config. The last hop is the engine's (`directives.turns ?? config.maxTurns`), so what
 * streamChat must produce is: the skill's number when nothing was explicitly chosen, and NOTHING
 * (a gap the engine fills) when neither an inline directive nor a skill declares one.
 *
 * DATA_DIR comes from the shared preload (bunfig.toml -> setup.ts).
 */
const { saveSkill, resolveSkillTurns, MAX_SKILL_TURNS, parseSkillFrontmatter } = await import('../skills.ts');
const { streamChat } = await import('../claude.ts');
const { setSessionDirectives, upsertSession } = await import('../sessions.ts');
const { registerEngine } = await import('../engine/registry.ts');

// Records the directives the engine is actually handed — the real consumer of `turns`.
let seen: Directives | undefined;
const probe: AgentEngine = {
  name: 'turns-probe',
  getModels: () => [],
  async *stream(opts: any) {
    seen = opts.directives;
    yield { type: 'done', sessionId: opts.sessionId, stopReason: 'end_turn' } as any;
  },
} as any;

async function run(prompt: string, sessionId?: string): Promise<Directives> {
  seen = undefined;
  for await (const _ of streamChat({ prompt: `[engine:turns-probe] ${prompt}`, uid: 'u1', userEmail: 'e@x.com', sessionId })) { /* drain */ }
  return seen!;
}

describe('per-skill turn budget', () => {
  beforeAll(() => {
    registerEngine(probe);
    saveSkill('long-job', '---\nname: long-job\ndescription: a long one\nturns: 250\n---\n\nDo the long thing.\n');
    saveSkill('short-job', '---\nname: short-job\ndescription: no budget declared\n---\n\nDo the short thing.\n');
    saveSkill('greedy-job', '---\nname: greedy-job\ndescription: typo\nturns: 30000\n---\n\nOops.\n');
  });

  test('frontmatter parses `turns` (and the `max-turns` spelling agents.ts uses)', () => {
    expect(parseSkillFrontmatter('---\nturns: 250\n---\nbody').meta.turns).toBe(250);
    expect(parseSkillFrontmatter('---\nmax-turns: 40\n---\nbody').meta.turns).toBe(40);
    expect(parseSkillFrontmatter('---\nturns: lots\n---\nbody').meta.turns).toBeUndefined();
    // The known trap: a leading comment blanks the whole meta, so `turns` must not be relied on
    // from a file whose first bytes are not `---`.
    expect(parseSkillFrontmatter('<!-- hi -->\n---\nturns: 250\n---\nbody').meta.turns).toBeUndefined();
  });

  test('resolveSkillTurns takes the max across invoked skills and clamps to the cap', () => {
    expect(resolveSkillTurns(['short-job'])).toBeUndefined();
    expect(resolveSkillTurns([undefined, 'nope'])).toBeUndefined();
    expect(resolveSkillTurns(['short-job', 'long-job'])).toBe(250);
    expect(resolveSkillTurns(['greedy-job'])).toBe(MAX_SKILL_TURNS);
  });

  test('a slash-invoked skill supplies its budget with no inline directive', async () => {
    expect((await run('/long-job')).turns).toBe(250);
  });

  test('a TRIGGERED skill supplies it too (the pipeline is invoked by phrase, not only by slash)', async () => {
    saveSkill('triggered-long', '---\nname: triggered-long\ndescription: x\nturns: 120\ntriggers:\n  - "make a video ad"\n---\n\nbody\n');
    expect((await run('please make a video ad for us')).turns).toBe(120);
  });

  test('a skill with no `turns` leaves the gap for config.maxTurns — it must NOT invent a number', async () => {
    expect((await run('/short-job')).turns).toBeUndefined();
    expect((await run('just a plain prompt')).turns).toBeUndefined();
  });

  test('an inline [turns:N] still WINS over the skill frontmatter', async () => {
    expect((await run('[turns:5] /long-job')).turns).toBe(5);
    expect((await run('[turns:400] /long-job')).turns).toBe(400); // a human is not capped
  });

  test('a session-pinned directive wins over the skill frontmatter', async () => {
    upsertSession('sess-pinned', 'x', { uid: 'u1', email: 'e@x.com' });
    setSessionDirectives('sess-pinned', { turns: 7 });
    expect((await run('/long-job', 'sess-pinned')).turns).toBe(7);
  });

  test('the skill budget is per-turn, not sticky on the session', async () => {
    upsertSession('sess-fresh', 'x', { uid: 'u1', email: 'e@x.com' });
    expect((await run('/long-job', 'sess-fresh')).turns).toBe(250);
    // Next turn in the SAME session without the skill must fall back to the global again.
    expect((await run('/short-job', 'sess-fresh')).turns).toBeUndefined();
  });
});
