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
    const bak = readFileSync(dataPath('modules', '.backups', 'm-adopt', 'm-adopt.md.orig'), 'utf-8');
    expect(bak).toBe('# my hand-written skill\n');
  });

  test('builtin routine adopts the circles pre-state: task.model haiku preserved via knob, scope→system, runtime kept', () => {
    // Circles pre-state: unmanaged user-scope tick with a hand-set cheap model
    const pre: Schedule = {
      id: 'circles-tick-id', name: 'routine-tick', enabled: true,
      trigger: { kind: 'cron', expr: '0 9-16 * * 0-4', tz: 'Asia/Jerusalem' },
      task: { kind: 'prompt', prompt: 'old hand-written tick prompt', model: 'haiku' },
      scope: 'user', createdBy: { uid: 'elya', email: 'elya@x.com' },
      createdAt: 1, updatedAt: 1, runCount: 99,
    };
    expect(scheduler.upsertSchedule(pre).ok).toBe(true);

    installModule({ name: 'routine' });
    expect(scheduler.getSchedule('mod-routine-tick')).toBeUndefined(); // adopted, not duplicated
    const adopted = scheduler.getSchedule('circles-tick-id')!;
    expect(adopted.managedBy).toBe('routine');
    expect(adopted.scope).toBe('system');                              // intended (F2)
    expect((adopted.task as { model?: string }).model).toBe('haiku');  // model round-trips via tickModel knob
    expect(adopted.runCount).toBe(99);
    expect(adopted.enabled).toBe(true);
    expect(adopted.trigger).toEqual({ kind: 'cron', expr: '0 8-17 * * 0-4', tz: 'Asia/Jerusalem' }); // def wins trigger

    uninstallModule('routine');
    scheduler.deleteSchedule('circles-tick-id');
    rmSync(dataPath('workspace/agenda.md'), { force: true });
    rmSync(dataPath('modules', '.backups', 'routine'), { recursive: true, force: true });
  });

  test('a model knob rendered to "" is omitted from the schedule task', () => {
    makeModule('m-model', {
      configSchema: { mdl: { type: 'string', default: '' } },
      scheduleName: 'm-model tick',
    });
    // inject model template into the fixture manifest
    const mf = path.join(FIXTURES, 'm-model', 'module.json');
    const m = JSON.parse(readFileSync(mf, 'utf-8'));
    m.schedules[0].task.model = '{{mdl}}';
    m.configSchema.owner = { type: 'string', default: 'elya' };
    writeFileSync(mf, JSON.stringify(m));

    installModule({ path: path.join(FIXTURES, 'm-model') });
    const s = scheduler.getSchedule('mod-m-model-tick')!;
    expect('model' in s.task).toBe(false);
    uninstallModule('m-model');
  });

  test('adoption backup survives reinstall (v2 upgrade) AND uninstall', () => {
    writeFileSync(dataPath('skills', 'm-keep.md'), '# precious user original\n');
    makeModule('m-keep', { skill: 'rendered v1' });
    installModule({ path: path.join(FIXTURES, 'm-keep') });
    const bakFile = dataPath('modules', '.backups', 'm-keep', 'm-keep.md.orig');
    expect(readFileSync(bakFile, 'utf-8')).toBe('# precious user original\n');

    // Reinstall as v2 — copyDir wipes+recreates the module folder; backup must survive
    makeModule('m-keep', { skill: 'rendered v2', version: '2.0.0' });
    installModule({ path: path.join(FIXTURES, 'm-keep') });
    expect(getInstalled('m-keep')!.version).toBe('2.0.0');
    expect(readFileSync(bakFile, 'utf-8')).toBe('# precious user original\n');

    // Uninstall removes the module folder; the backup is user data — it must survive
    uninstallModule('m-keep');
    expect(existsSync(dataPath('modules', 'm-keep'))).toBe(false);
    expect(readFileSync(bakFile, 'utf-8')).toBe('# precious user original\n');
    rmSync(dataPath('modules', '.backups', 'm-keep'), { recursive: true, force: true });
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

  test('GET /api/modules carries readme + skillCount/scheduleCount', async () => {
    makeModule('m-api', { skill: 'body', scheduleName: 'm-api tick' });
    writeFileSync(path.join(FIXTURES, 'm-api', 'README.md'), '# m-api docs\n');
    installModule({ path: path.join(FIXTURES, 'm-api') });

    const { registerModuleRoutes } = await import('../routes.ts');
    const handlers: Record<string, Function> = {};
    const fakeApp = {
      get: (p: string, _a: unknown, h: Function) => { handlers[p] = h; },
      post: () => {}, put: () => {}, delete: () => {},
    };
    registerModuleRoutes(fakeApp as never, (() => {}) as never);
    let body: any;
    handlers['/api/modules']({}, { json: (b: unknown) => { body = b; } });

    const entry = body.installed.find((m: any) => m.name === 'm-api');
    expect(entry.readme).toBe('# m-api docs\n');
    expect(entry.skillCount).toBe(1);
    expect(entry.scheduleCount).toBe(1);
    uninstallModule('m-api');
  });

  test('GET /api/modules installed entries carry TOP-LEVEL configSchema + description (UI contract)', async () => {
    makeModule('m-shape', { configSchema: { color: { type: 'string', default: 'red' } } });
    installModule({ path: path.join(FIXTURES, 'm-shape') });

    const { registerModuleRoutes } = await import('../routes.ts');
    const handlers: Record<string, Function> = {};
    const fakeApp = {
      get: (p: string, _a: unknown, h: Function) => { handlers[p] = h; },
      post: () => {}, put: () => {}, delete: () => {},
    };
    registerModuleRoutes(fakeApp as never, (() => {}) as never);
    let body: any;
    handlers['/api/modules']({}, { json: (b: unknown) => { body = b; } });

    const entry = body.installed.find((m: any) => m.name === 'm-shape');
    expect(entry.description).toBe('test module m-shape');
    expect(entry.configSchema).toEqual({ color: { type: 'string', default: 'red' } });
    uninstallModule('m-shape');
  });

  test('PUT /api/modules/:name/config accepts the {config} wrapper; 400 without it', async () => {
    makeModule('m-cfg', { configSchema: { owner: { type: 'string', default: 'elya' } } });
    installModule({ path: path.join(FIXTURES, 'm-cfg') });

    const { registerModuleRoutes } = await import('../routes.ts');
    let putHandler: Function | undefined;
    const fakeApp = {
      get: () => {}, post: () => {}, delete: () => {},
      put: (p: string, _a: unknown, h: Function) => { if (p === '/api/modules/:name/config') putHandler = h; },
    };
    registerModuleRoutes(fakeApp as never, (() => {}) as never);
    const call = (reqBody: unknown) => {
      let status = 200; let body: any;
      putHandler!(
        { params: { name: 'm-cfg' }, body: reqBody, user: { isOwner: true } },
        { json: (b: unknown) => { body = b; }, status: (s: number) => ({ json: (b: unknown) => { status = s; body = b; } }) },
      );
      return { status, body };
    };

    // UI-shaped wrapper → 200, config applied
    const ok = call({ config: { owner: 'zoe' } });
    expect(ok.status).toBe(200);
    expect(ok.body.config.owner).toBe('zoe');
    expect(getInstalled('m-cfg')!.config.owner).toBe('zoe');

    // missing / non-object config → 400
    expect(call({}).status).toBe(400);
    expect(call({ owner: 'raw' }).status).toBe(400);
    expect(call({ config: 'nope' }).status).toBe(400);
    expect(call({ config: ['a'] }).status).toBe(400);
    uninstallModule('m-cfg');
  });

  test('install with a RELATIVE path resolves against DATA_DIR', () => {
    const rel = path.join('workspace', 'modules-dev', 'm-rel');
    const abs = dataPath(rel);
    rmSync(abs, { recursive: true, force: true });
    mkdirSync(abs, { recursive: true });
    writeFileSync(path.join(abs, 'module.json'), JSON.stringify({
      name: 'm-rel', version: '1.0.0', description: 'rel install', configSchema: {},
    }));
    const rec = installModule({ path: rel });
    expect(rec.name).toBe('m-rel');
    expect(rec.source).toBe(abs);
    // not-found error still names the RESOLVED path
    expect(() => installModule({ path: 'workspace/no-such-mod' }))
      .toThrow(dataPath('workspace/no-such-mod'));
    uninstallModule('m-rel');
  });

  test('builtin "routine" installs by name: skill rendered with defaults, tick on, work-block off, agenda seeded', () => {
    const rec = installModule({ name: 'routine' });
    expect(rec.source).toBe('builtin');
    expect(rec.config.pilotMode).toBe(true);

    const skill = readFileSync(dataPath('skills', 'routine.md'), 'utf-8');
    expect(skill).toContain('managed-by: routine@');
    expect(skill).toContain('Sun–Thu');                       // workingDays default rendered
    expect(skill).toContain('okrs/q3-2026-draft.md');         // okrSource default rendered
    expect(skill).toContain('Pilot restriction active: **true**');
    expect(skill).not.toContain('{{');                        // every placeholder resolved
    // Restored doctrine renders (F3)
    expect(skill).toContain('self-wake-<slug>');
    expect(skill).toContain('max 4 FUTURE-scheduled self-wakes per day'); // maxSelfWakesPerDay default rendered
    // Pager doctrine (1.2.0): tick dispatches via immediate self-wake, never works
    expect(skill).toContain('Dispatch, don\'t do');
    expect(skill).toContain('NEVER does the work');
    expect(skill).toContain('rules out a previously stated theory');
    expect(skill).toContain('event-triggered reactions');
    expect(skill).toContain('Unsure which tier → digest');
    expect(skill).toContain('NOT the board — `tasks/tasks.md` is the durable record');

    const tick = scheduler.getSchedule('mod-routine-tick')!;
    expect(tick.enabled).toBe(true);
    expect(tick.trigger).toEqual({ kind: 'cron', expr: '0 8-17 * * 0-4', tz: 'Asia/Jerusalem' });
    expect((tick.task as { model?: string }).model).toBe('haiku'); // tickModel knob rendered
    const block = scheduler.getSchedule('mod-routine-work-block')!;
    expect(block.enabled).toBe(false);                        // ships disabled
    expect(block.trigger).toEqual({ kind: 'cron', expr: '0 12 * * 0-4', tz: 'Asia/Jerusalem' });

    const agenda = readFileSync(dataPath('workspace/agenda.md'), 'utf-8');
    expect(agenda).toContain('## Queue');
    uninstallModule('routine');
    rmSync(dataPath('workspace/agenda.md'), { force: true });
  });

  test('module-managed skill exposes managedBy via frontmatter parse', () => {
    makeModule('m-meta', { skill: 'body' });
    installModule({ path: path.join(FIXTURES, 'm-meta') });
    const { meta } = parseSkillFrontmatter(readFileSync(dataPath('skills', 'm-meta.md'), 'utf-8'));
    expect(meta.managedBy).toBe('m-meta@1.0.0');
    uninstallModule('m-meta');
  });
});
