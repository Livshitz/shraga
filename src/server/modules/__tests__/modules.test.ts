import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { dataPath } from '../../paths.ts';
import * as scheduler from '../../scheduler/index.ts';
import { ensureBuiltinSchedules } from '../../scheduler/builtins.ts';
import { loadSchedules } from '../../scheduler/storage.ts';
import { getDefaultSkills, setDefaultSkills, parseSkillFrontmatter } from '../../skills.ts';
import type { Schedule } from '../../scheduler/types.ts';
import {
  renderTemplate, renderDeep, installModule, reconcileInstalledModules,
  enableModule, disableModule, uninstallModule, loadState, getInstalled,
} from '../service.ts';

// DATA_DIR comes from the shared preload (bunfig.toml → setup.ts).
const FIXTURES = path.join(path.dirname(dataPath('..')), `mod-fixtures-${process.pid}`);

/** Write a module fixture folder and return its path. */
function makeModule(name: string, opts: {
  version?: string;
  configSchema?: Record<string, { type: 'string' | 'number' | 'boolean'; default?: unknown }>;
  skill?: string;              // template body for <name>.md.tmpl
  scheduleName?: string;       // one cron schedule def "tick"
  seed?: { path: string; content: string };
  defaultSkills?: string[];
  offspring?: { schedules?: string };
} = {}): string {
  const dir = path.join(FIXTURES, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const manifest: Record<string, unknown> = {
    name,
    version: opts.version ?? '1.0.0',
    description: `test module ${name}`,
    configSchema: opts.configSchema ?? { owner: { type: 'string', default: 'elya' } },
  };
  if (opts.skill !== undefined) {
    writeFileSync(path.join(dir, `${name}.md.tmpl`), opts.skill);
    manifest.skills = [`${name}.md.tmpl`];
  }
  if (opts.scheduleName) {
    manifest.schedules = [{
      def: 'tick',
      name: opts.scheduleName,
      trigger: { kind: 'cron', expr: '0 12 * * *', tz: 'UTC' },
      task: { kind: 'prompt', prompt: 'hello {{owner}}' },
    }];
  }
  if (opts.seed) {
    manifest.seeds = [opts.seed.path];
    const seedFile = path.join(dir, 'seeds', opts.seed.path);
    mkdirSync(path.dirname(seedFile), { recursive: true });
    writeFileSync(seedFile, opts.seed.content);
  }
  if (opts.defaultSkills) manifest.defaultSkills = opts.defaultSkills;
  if (opts.offspring) manifest.offspring = opts.offspring;
  writeFileSync(path.join(dir, 'module.json'), JSON.stringify(manifest, null, 2));
  return dir;
}

beforeAll(() => {
  scheduler.start(() => {});
});

afterAll(() => {
  for (const rec of loadState().installed) {
    try { uninstallModule(rec.name); } catch { /* already gone */ }
  }
  rmSync(FIXTURES, { recursive: true, force: true });
});

describe('template render', () => {
  test('replaces {{key}}, leaves unknown keys literal', () => {
    expect(renderTemplate('hi {{a}} and {{missing}}', { a: 'x' })).toBe('hi x and {{missing}}');
  });
  test('deep-walks objects and arrays, non-strings untouched', () => {
    const out = renderDeep({ n: 3, arr: ['{{a}}', { b: '{{a}}!' }] }, { a: 'z' });
    expect(out).toEqual({ n: 3, arr: ['z', { b: 'z!' }] });
  });
});

describe('install + reconcile', () => {
  test('install renders skill with managed-by and config, creates module schedule', () => {
    makeModule('m-basic', { skill: 'Work for {{owner}}.', scheduleName: 'm-basic tick' });
    installModule({ path: path.join(FIXTURES, 'm-basic') });
    const skill = readFileSync(dataPath('skills', 'm-basic.md'), 'utf-8');
    expect(skill).toContain('managed-by: m-basic@1.0.0');
    expect(skill).toContain('Work for elya.');
    const s = scheduler.getSchedule('mod-m-basic-tick');
    expect(s).toBeDefined();
    expect(s!.createdBy.uid).toBe('module:m-basic');
    expect(s!.scope).toBe('system');
    expect(s!.managedBy).toBe('m-basic');
    expect((s!.task as { prompt: string }).prompt).toBe('hello elya');
  });

  test('reconcile is idempotent and preserves schedule runtime state', () => {
    const s = scheduler.getSchedule('mod-m-basic-tick')!;
    s.runCount = 7;
    s.lastRun = { at: 123, sessionId: 'sess', status: 'ok' };
    const before = readFileSync(dataPath('skills', 'm-basic.md'), 'utf-8');
    reconcileInstalledModules();
    reconcileInstalledModules();
    expect(readFileSync(dataPath('skills', 'm-basic.md'), 'utf-8')).toBe(before);
    const after = scheduler.getSchedule('mod-m-basic-tick')!;
    expect(after.runCount).toBe(7);
    expect(after.lastRun?.sessionId).toBe('sess');
    expect(after.enabled).toBe(true);
  });

  test('seeds are created once and never overwritten by reconcile', () => {
    makeModule('m-seed', { seed: { path: 'workspace/m-seed-agenda.md', content: 'agenda of {{owner}}' } });
    installModule({ path: path.join(FIXTURES, 'm-seed') });
    const seedFile = dataPath('workspace/m-seed-agenda.md');
    expect(readFileSync(seedFile, 'utf-8')).toBe('agenda of elya');
    writeFileSync(seedFile, 'USER EDITED');
    reconcileInstalledModules();
    expect(readFileSync(seedFile, 'utf-8')).toBe('USER EDITED');
  });

  test('module schedule survives the builtins system-uid purge', () => {
    // The trap: ensureBuiltinSchedules deletes system-scope schedules with the SYSTEM uid
    // not in the builtins list. Module schedules use uid module:<name> so they must survive.
    const schedules = ensureBuiltinSchedules(loadSchedules());
    expect(schedules.find((s) => s.id === 'mod-m-basic-tick')).toBeDefined();
  });
});

describe('adoption', () => {
  test('adopts an unmanaged same-name schedule (keeps id + runtime state) and backs up the skill', () => {
    // Pre-existing user artifacts
    writeFileSync(dataPath('skills', 'm-adopt.md'), '# my hand-written skill\n');
    const pre: Schedule = {
      id: 'user-made-id', name: 'adopt-me-tick', enabled: false,
      trigger: { kind: 'cron', expr: '5 5 * * *', tz: 'UTC' },
      task: { kind: 'prompt', prompt: 'old prompt' },
      scope: 'user', createdBy: { uid: 'u1', email: 'u1@x.com' },
      createdAt: 1, updatedAt: 1, runCount: 42,
    };
    expect(scheduler.upsertSchedule(pre).ok).toBe(true);

    makeModule('m-adopt', { skill: 'rendered for {{owner}}', scheduleName: 'adopt-me-tick' });
    const rec = installModule({ path: path.join(FIXTURES, 'm-adopt') });

    expect(rec.adoptedScheduleIds).toEqual({ tick: 'user-made-id' });
    expect(scheduler.getSchedule('mod-m-adopt-tick')).toBeUndefined();
    const adopted = scheduler.getSchedule('user-made-id')!;
    expect(adopted.managedBy).toBe('m-adopt');
    expect(adopted.runCount).toBe(42);
    expect(adopted.enabled).toBe(false); // preserved
    expect((adopted.task as { prompt: string }).prompt).toBe('hello elya'); // trigger/task updated

    // Skill overwritten with rendered content; original backed up
    expect(readFileSync(dataPath('skills', 'm-adopt.md'), 'utf-8')).toContain('rendered for elya');
    const bak = readFileSync(dataPath('modules', 'm-adopt', 'adopted', 'm-adopt.md.orig'), 'utf-8');
    expect(bak).toBe('# my hand-written skill\n');
  });
});

describe('disable / enable', () => {
  test('disable snapshots per-schedule enabled, removes skills; enable restores exactly', () => {
    makeModule('m-toggle', { skill: 'body', scheduleName: 'm-toggle tick' });
    installModule({ path: path.join(FIXTURES, 'm-toggle') });
    // User turned the managed schedule OFF before the module is disabled
    scheduler.toggleSchedule('mod-m-toggle-tick', false);

    disableModule('m-toggle');
    expect(existsSync(dataPath('skills', 'm-toggle.md'))).toBe(false);
    expect(scheduler.getSchedule('mod-m-toggle-tick')!.enabled).toBe(false);
    expect(getInstalled('m-toggle')!.scheduleEnabledSnapshot).toEqual({ 'mod-m-toggle-tick': false });

    enableModule('m-toggle');
    expect(existsSync(dataPath('skills', 'm-toggle.md'))).toBe(true);
    expect(scheduler.getSchedule('mod-m-toggle-tick')!.enabled).toBe(false); // restored to user's OFF, not forced on
    expect(getInstalled('m-toggle')!.scheduleEnabledSnapshot).toBeUndefined();
  });

  test('disable also disables (never deletes) offspring schedules by name glob', () => {
    makeModule('m-off', { skill: 'body', offspring: { schedules: 'self-wake-*' } });
    installModule({ path: path.join(FIXTURES, 'm-off') });
    const wake: Schedule = {
      id: 'wake-1', name: 'self-wake-tomorrow', enabled: true,
      trigger: { kind: 'once', at: Date.now() + 86_400_000 },
      task: { kind: 'prompt', prompt: 'continue' },
      scope: 'user', createdBy: { uid: 'agent', email: 'a@x.com' },
      createdAt: Date.now(), updatedAt: Date.now(), runCount: 0,
    };
    expect(scheduler.upsertSchedule(wake).ok).toBe(true);

    disableModule('m-off');
    const s = scheduler.getSchedule('wake-1');
    expect(s).toBeDefined();               // never deleted
    expect(s!.enabled).toBe(false);        // but disabled
    enableModule('m-off');
    expect(scheduler.getSchedule('wake-1')!.enabled).toBe(true); // snapshot restored
    scheduler.deleteSchedule('wake-1');
  });

  test('dormancy stamp: added on disable, idempotent, removed on enable; seeds survive uninstall', () => {
    makeModule('m-dorm', { seed: { path: 'workspace/m-dorm-notes.md', content: 'notes' } });
    installModule({ path: path.join(FIXTURES, 'm-dorm') });
    const seedFile = dataPath('workspace/m-dorm-notes.md');

    disableModule('m-dorm');
    const stamped = readFileSync(seedFile, 'utf-8');
    expect(stamped.startsWith('> [m-dorm disabled ')).toBe(true);
    expect(stamped).toContain('retained as state');

    // Idempotent: a second stamp pass must not double-stamp
    enableModule('m-dorm');
    disableModule('m-dorm');
    disableModule('m-dorm');
    const twice = readFileSync(seedFile, 'utf-8');
    expect(twice.match(/> \[m-dorm disabled /g)!.length).toBe(1);

    enableModule('m-dorm');
    expect(readFileSync(seedFile, 'utf-8')).toBe('notes');

    disableModule('m-dorm');
    uninstallModule('m-dorm');
    expect(existsSync(seedFile)).toBe(true); // seeds are memory, not status
    expect(readFileSync(seedFile, 'utf-8')).toContain('> [m-dorm disabled');
    expect(getInstalled('m-dorm')).toBeUndefined();
    expect(existsSync(dataPath('modules', 'm-dorm'))).toBe(false);
    rmSync(seedFile);
  });
});

describe('uninstall + skills-defaults', () => {
  test('uninstall removes rendered skill and managed schedule, leaves seeds', () => {
    makeModule('m-gone', { skill: 'body', scheduleName: 'm-gone tick', seed: { path: 'workspace/m-gone-seed.md', content: 'keep me' } });
    installModule({ path: path.join(FIXTURES, 'm-gone') });
    uninstallModule('m-gone');
    expect(existsSync(dataPath('skills', 'm-gone.md'))).toBe(false);
    expect(scheduler.getSchedule('mod-m-gone-tick')).toBeUndefined();
    expect(readFileSync(dataPath('workspace/m-gone-seed.md'), 'utf-8')).toContain('keep me');
    rmSync(dataPath('workspace/m-gone-seed.md'));
  });

  test('a user removal from skills-defaults is not re-added by reconcile', () => {
    makeModule('m-defs', { skill: 'body', defaultSkills: ['m-defs'] });
    installModule({ path: path.join(FIXTURES, 'm-defs') });
    expect(getDefaultSkills()).toContain('m-defs');
    // User removes it
    setDefaultSkills(getDefaultSkills().filter((e) => (typeof e === 'string' ? e : e.name) !== 'm-defs'));
    reconcileInstalledModules();
    expect(getDefaultSkills()).not.toContain('m-defs');
    uninstallModule('m-defs');
  });

  test('module-managed skill exposes managedBy via frontmatter parse', () => {
    makeModule('m-meta', { skill: 'body' });
    installModule({ path: path.join(FIXTURES, 'm-meta') });
    const { meta } = parseSkillFrontmatter(readFileSync(dataPath('skills', 'm-meta.md'), 'utf-8'));
    expect(meta.managedBy).toBe('m-meta@1.0.0');
    uninstallModule('m-meta');
  });
});
