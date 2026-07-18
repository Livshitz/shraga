import { describe, test, expect, beforeAll } from 'bun:test';

// DATA_DIR is minted by the test preload (bunfig.toml -> src/server/__tests__/setup.ts) before any
// module imports paths.ts, and torn down on process exit. Setting it here instead raced with the
// other test files that also import paths.ts.
const sessions = await import('../sessions.ts');

describe('addTriggeredSkills (sticky triggered skills)', () => {
  beforeAll(() => {
    sessions.upsertSession('s1', 'hello', { uid: 'u1', email: 'e@x.com' });
  });

  test('persists matched names on the session', () => {
    sessions.addTriggeredSkills('s1', ['repo-conventions']);
    expect(sessions.getSession('s1')?.triggeredSkills).toEqual(['repo-conventions']);
  });

  test('unions without duplicates across turns', () => {
    sessions.addTriggeredSkills('s1', ['repo-conventions', 'mcp-slack']);
    expect(sessions.getSession('s1')?.triggeredSkills).toEqual(['repo-conventions', 'mcp-slack']);
  });

  test('no-op for empty names and unknown sessions', () => {
    sessions.addTriggeredSkills('s1', []);
    sessions.addTriggeredSkills('missing-session', ['x']);
    expect(sessions.getSession('s1')?.triggeredSkills).toEqual(['repo-conventions', 'mcp-slack']);
    expect(sessions.getSession('missing-session')).toBeUndefined();
  });
});
