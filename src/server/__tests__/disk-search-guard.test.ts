import { test, expect } from 'bun:test';
import os from 'node:os';
import { wholeDiskSearch } from '../disk-search-guard.ts';
import { buildHooks } from '../hooks.ts';

test('whole-disk searches are caught (the commands agents actually ran)', () => {
  for (const c of [
    'find / -name "fal_i2v.py" 2>/dev/null',
    "ls x | head; echo ---; find / -maxdepth 6 -path '*video-ad-pipeline/scripts/fal_i2v.py' 2>/dev/null",
    'cd ~/vap-runs 2>/dev/null; find / -maxdepth 6 -ipath "*out/fal*"',
    'find ~ -iname "*.mp4"', `find ${os.homedir()} -name x`, 'find $HOME/ -name x', 'sudo find -L / -name x',
    'mdfind shlomo', 'grep -rn foo /', 'rg TODO ~', 'x=$(find / -name y)',
  ]) expect([c, wholeDiskSearch(c)]).not.toEqual([c, null]);
});

test('scoped searches are allowed', () => {
  for (const c of [
    'find . -name x', 'find ~/Projects/Livshitz/shraga/data-feedox/skills -name "*.py"', 'find out/fal -newer a',
    'mdfind -onlyin ~/Projects x', 'grep -n foo /etc/hosts', 'grep -rn foo src', 'ls /', 'cat ~/.zshrc', 'rg TODO .',
  ]) expect([c, wholeDiskSearch(c)]).toEqual([c, null]);
});

test('the hook denies Bash and Grep/Glob rooted at /, with a pointer to the data dir', async () => {
  const run = async (tool_name: string, tool_input: Record<string, unknown>) => {
    for (const m of buildHooks({ offload: undefined }).PreToolUse!) {
      if (!new RegExp(`^(?:${m.matcher})$`).test(tool_name)) continue;
      for (const h of m.hooks) {
        const r: any = await h({ hook_event_name: 'PreToolUse', tool_name, tool_input } as any, undefined, { signal: new AbortController().signal });
        if (r?.hookSpecificOutput?.permissionDecision === 'deny') return r.hookSpecificOutput.permissionDecisionReason as string;
      }
    }
    return null;
  };
  expect(await run('Bash', { command: 'find / -name fal_i2v.py' })).toContain('skills/');
  expect(await run('Grep', { pattern: 'x', path: '/' })).toContain('whole disk');
  expect(await run('Glob', { pattern: '**/*.py', path: os.homedir() })).toContain('whole disk');
  expect(await run('Bash', { command: 'find . -name x' })).toBeNull();
  expect(await run('Grep', { pattern: 'x', path: 'src' })).toBeNull();
});

test('the skill index names the absolute skills dir (no relative data/skills/ for the agent to hunt for)', async () => {
  const { buildSkillIndexBlock } = await import('../skills.ts');
  const { DATA_DIR } = await import('../paths.ts');
  const block = buildSkillIndexBlock();
  if (block) {
    expect(block).toContain(`${DATA_DIR}/skills/`);
    expect(block).not.toContain('available in data/skills/');
  }
});
