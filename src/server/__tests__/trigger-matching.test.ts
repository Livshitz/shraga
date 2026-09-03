import { describe, test, expect, beforeAll } from 'bun:test';

/**
 * Skill triggers are authored as natural phrases, but a real brief inserts words into them.
 * `lower.includes(t)` missed "make a NEW video ad variant" against the trigger "make a video ad" —
 * and a missed trigger does not just drop the skill text, it drops the skill's `turns` budget too,
 * so the pipeline ran at the global 50 instead of its declared 250.
 *
 * The fix must cut BOTH ways: tolerate inserted words, and NOT start matching things it didn't.
 * The "must not match" table below is the half that matters — it is pinned against the REAL
 * trigger lists of the skills that were already over-matching a video-ad request.
 */
const { triggerMatches, saveSkill } = await import('../skills.ts');
const { streamChat } = await import('../claude.ts');
const { registerEngine } = await import('../engine/registry.ts');

// The real video-ad-pipeline frontmatter (.claude/skills/video-ad-pipeline/SKILL.md), verbatim.
const VIDEO_AD_TRIGGERS = [
  'make a video ad', 'create a video ad', 'produce a creative', 'generate a video',
  'new video creative', 'animate this', 'video ad pipeline', 'wan 2.2', 'i2v',
  'image to video', 'keyframe to video', 'modal h100',
];
const hitsVideoAd = (s: string) => VIDEO_AD_TRIGGERS.some(t => triggerMatches(s, t));

describe('triggerMatches — tolerant of natural phrasing', () => {
  test.each([
    'make a video ad',
    'make a new video ad variant for Circles',            // the brief that MISSED in the live run
    'can you produce a creative for us',
    'Please create a short video ad for the Circles app',
    'generate a 15 second video for IG',
    'make me a new video ad',
    'I need a new video creative',
    'animate this keyframe',
    'run the video ad pipeline',
    'use wan 2.2 for the beats',                          // decimal kept whole
    'make some video ads',                                 // plural + filler substitution
  ])('matches: %s', (s) => expect(hitsVideoAd(s)).toBe(true));

  test.each([
    'what did the facebook ads cost per click last week',
    'the video call kept dropping for a member',
    'ship a new build to TestFlight',
    'make a note about the ad account balance',
    'add a video player to the settings screen',
  ])('does NOT match: %s', (s) => expect(hitsVideoAd(s)).toBe(false));
});

describe('triggerMatches — the loosening is bounded', () => {
  test('gaps are only for 3+ token triggers; short ones stay contiguous', () => {
    expect(triggerMatches('the ad campaign set up', 'ad set')).toBe(false);   // 2 tokens, no gap
    expect(triggerMatches('check the ad set budget', 'ad set')).toBe(true);
    expect(triggerMatches('image straight to a video', 'image to video')).toBe(true);  // 1 gap
  });

  test('a phrase cannot smear across a whole message (total gap budget)', () => {
    expect(triggerMatches('make a really nicely produced long video advert', 'make a video ad')).toBe(false);
    expect(triggerMatches('make something. later, a video. then an ad.', 'make a video ad')).toBe(false);
  });

  test('whole-word matching NARROWS what `includes` used to hit', () => {
    expect(triggerMatches('cost performance was fine', 'cost per')).toBe(false);
    expect(triggerMatches('adding a feature', 'ad')).toBe(false);
    expect(triggerMatches('pinstripe shirts', 'stripe')).toBe(false);
    expect(triggerMatches('the stripe invoice', 'stripe')).toBe(true);
  });

  test('context tokens ([channel:#support]) still match', () => {
    expect(triggerMatches('[channel:#support] hi', 'channel:#support')).toBe(true);
    expect(triggerMatches('[channel:#dev] hi', 'channel:#support')).toBe(false);
  });

  test('neighbouring skills do not start matching a video-ad brief', () => {
    const brief = 'make a new video ad variant for Circles';
    for (const t of ['facebook ads', 'fb ads', 'meta ads', 'ad spend', 'ad account', 'ad set',
                     'roas', 'cost per', 'creative performance',                 // mcp-facebook-ads
                     'agent runs ads', 'let the agent run ads',                  // agent-run-paid-acquisition
                     'join the call', 'google meet', 'create a meeting']) {      // meeting
      expect([t, triggerMatches(brief, t)]).toEqual([t, false]);
    }
  });
});

// ── the consumer surface: the directives the engine is actually handed ────────────────────────
let seen: any;
registerEngine({
  name: 'trigger-probe', getModels: () => [],
  async *stream(opts: any) { seen = opts.directives; yield { type: 'done', sessionId: opts.sessionId, stopReason: 'end_turn' }; },
} as any);

async function directivesFor(prompt: string) {
  seen = undefined;
  for await (const _ of streamChat({ prompt: `[engine:trigger-probe] ${prompt}`, uid: 'u1', userEmail: 'e@x.com' })) { /* drain */ }
  return seen;
}

describe('a natural brief resolves the pipeline turn budget', () => {
  beforeAll(() => {
    saveSkill('video-ad-pipeline', `---\nname: video-ad-pipeline\ndescription: produce creative\nturns: 250\ntriggers:\n${VIDEO_AD_TRIGGERS.map(t => `  - "${t}"`).join('\n')}\n---\n\nbody\n`);
  });

  test('"make a new video ad variant for Circles" → turns: 250', async () => {
    expect((await directivesFor('make a new video ad variant for Circles')).turns).toBe(250);
  });
  test('"can you produce a creative for us" → turns: 250', async () => {
    expect((await directivesFor('can you produce a creative for us')).turns).toBe(250);
  });
  test('an unrelated brief leaves the budget alone', async () => {
    expect((await directivesFor('what is our MRR this month')).turns).toBeUndefined();
  });
});
