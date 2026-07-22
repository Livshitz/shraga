/** Data-plane module service — installs/reconciles declarative module folders into data/.
 *
 *  A module folder: module.json + skill templates (*.md / *.md.tmpl) + seeds/<data-relative-path>.
 *  Applied source lives at data/modules/<name>/ (origin-agnostic); installed records in
 *  data/modules/state.json (atomic tmp+rename).
 *
 *  Invariants:
 *  - Module schedules use createdBy.uid `module:<name>` — NEVER the system uid: scheduler/builtins.ts
 *    purges system-scope schedules with the system uid not in the builtins list on every boot.
 *  - Seeds are memory, not status: create-if-missing, never overwritten, survive uninstall.
 *    Only state.json answers "is the module on".
 *  - Reconcile is idempotent: write-if-changed skills, upserts preserve enabled/runCount/lastRun.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, unlinkSync, renameSync, rmSync, copyFileSync, statSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { dataPath, PACKAGE_ROOT } from '../paths.ts';
import { dataSync } from '../data-sync.ts';
import * as scheduler from '../scheduler/index.ts';
import type { Schedule } from '../scheduler/types.ts';
import { parseSkillFrontmatter, getDefaultSkills, setDefaultSkills } from '../skills.ts';
import type { ModuleManifest, InstalledModule, ModulesState, ModuleScheduleDef } from './types.ts';

const MODULES_DIR = () => dataPath('modules');
const STATE_FILE = () => dataPath('modules/state.json');
const BUILTIN_MODULES_DIR = path.join(PACKAGE_ROOT, 'defaults', 'modules');

// ── State ───────────────────────────────────────────────────────────────────

export function loadState(): ModulesState {
  const file = STATE_FILE();
  if (!existsSync(file)) return { installed: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8'));
    return parsed && Array.isArray(parsed.installed) ? parsed : { installed: [] };
  } catch (err) {
    console.error('[modules] failed to parse state.json:', err);
    return { installed: [] };
  }
}

function saveState(state: ModulesState): void {
  mkdirSync(MODULES_DIR(), { recursive: true });
  const tmp = `${STATE_FILE()}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, STATE_FILE());
  dataSync.trackWrite('modules/state.json');
}

export function getInstalled(name: string): InstalledModule | undefined {
  return loadState().installed.find((m) => m.name === name);
}

// ── Manifest ────────────────────────────────────────────────────────────────

export function readManifest(folder: string): ModuleManifest {
  const file = path.join(folder, 'module.json');
  if (!existsSync(file)) throw new Error(`No module.json in ${folder}`);
  const m = JSON.parse(readFileSync(file, 'utf-8')) as ModuleManifest;
  if (!m.name || !/^[\w-]+$/.test(m.name)) throw new Error('Manifest: invalid or missing "name"');
  if (!m.version) throw new Error('Manifest: missing "version"');
  for (const def of m.schedules ?? []) {
    if (!def.def || !/^[\w-]+$/.test(def.def)) throw new Error(`Manifest: schedule def key invalid: "${def.def}"`);
    if (!def.name || !def.trigger || !def.task) throw new Error(`Manifest: schedule "${def.def}" needs name/trigger/task`);
  }
  for (const s of m.skills ?? []) {
    if (!/\.md(\.tmpl)?$/.test(s)) throw new Error(`Manifest: skill file must be .md or .md.tmpl: "${s}"`);
  }
  for (const seed of m.seeds ?? []) {
    if (path.isAbsolute(seed) || seed.split(/[\\/]/).includes('..')) throw new Error(`Manifest: seed path must be data-relative: "${seed}"`);
  }
  return m;
}

function moduleDir(name: string): string {
  return dataPath('modules', name);
}

function installedManifest(name: string): ModuleManifest {
  return readManifest(moduleDir(name));
}

/** Built-ins shipped in defaults/modules/<name>/ — "available" = readdir. */
export function listAvailableModules(): ModuleManifest[] {
  if (!existsSync(BUILTIN_MODULES_DIR)) return [];
  const out: ModuleManifest[] = [];
  for (const entry of readdirSync(BUILTIN_MODULES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try { out.push(readManifest(path.join(BUILTIN_MODULES_DIR, entry.name))); }
    catch (err) { console.warn(`[modules] skipping builtin ${entry.name}:`, (err as Error).message); }
  }
  return out;
}

// ── Templating ──────────────────────────────────────────────────────────────

/** `{{key}}` → config[key]. Unknown keys warn and are left literal. Strings only. */
export function renderTemplate(tpl: string, config: Record<string, unknown>, ctx = ''): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => {
    if (key in config) return String(config[key]);
    console.warn(`[modules] unknown template key {{${key}}}${ctx ? ` in ${ctx}` : ''}`);
    return whole;
  });
}

/** Deep-walk any JSON value, rendering string leaves. */
export function renderDeep<T>(value: T, config: Record<string, unknown>, ctx = ''): T {
  if (typeof value === 'string') return renderTemplate(value, config, ctx) as T;
  if (Array.isArray(value)) return value.map((v) => renderDeep(v, config, ctx)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = renderDeep(v, config, ctx);
    return out as T;
  }
  return value;
}

export function effectiveConfig(manifest: ModuleManifest, stored: Record<string, unknown> = {}): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, field] of Object.entries(manifest.configSchema ?? {})) {
    if (field.default !== undefined) out[key] = field.default;
  }
  for (const [key, val] of Object.entries(stored)) {
    if (val !== undefined && val !== null) out[key] = val as string | number | boolean;
  }
  return out;
}

// ── Skills ──────────────────────────────────────────────────────────────────

function skillNameFor(file: string): string {
  return path.basename(file).replace(/\.tmpl$/, '').replace(/\.md$/, '');
}

/** Render a skill template and stamp `managed-by: <module>@<ver>` into its frontmatter. */
function renderSkill(mod: ModuleManifest, file: string, config: Record<string, unknown>): { name: string; content: string } {
  const raw = readFileSync(path.join(moduleDir(mod.name), file), 'utf-8');
  const rendered = renderTemplate(raw, config, `${mod.name}/${file}`);
  const marker = `managed-by: ${mod.name}@${mod.version}`;
  let content: string;
  if (rendered.startsWith('---')) {
    content = rendered.replace('---', `---\n${marker}`);
  } else {
    content = `---\n${marker}\n---\n\n${rendered}`;
  }
  return { name: skillNameFor(file), content };
}

function skillPath(name: string): string {
  return dataPath('skills', `${name}.md`);
}

/** True when the on-disk skill of this name is owned by `moduleName` (or absent). */
function skillOwnedBy(name: string, moduleName: string): boolean {
  const file = skillPath(name);
  if (!existsSync(file)) return true;
  const { meta } = parseSkillFrontmatter(readFileSync(file, 'utf-8'));
  return (meta.managedBy ?? '').split('@')[0] === moduleName;
}

// ── Schedules ───────────────────────────────────────────────────────────────

function scheduleIdFor(rec: InstalledModule, def: ModuleScheduleDef): string {
  return rec.adoptedScheduleIds?.[def.def] ?? `mod-${rec.name}-${def.def}`;
}

function managedSchedules(name: string): Schedule[] {
  return scheduler.listSchedules().filter((s) => s.managedBy === name);
}

function globToRegex(glob: string): RegExp {
  return new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
}

/** Unmanaged schedules the module's doctrine caused the agent to create (name glob match). */
function offspringSchedules(manifest: ModuleManifest): Schedule[] {
  const glob = manifest.offspring?.schedules;
  if (!glob) return [];
  const re = globToRegex(glob);
  return scheduler.listSchedules().filter((s) => !s.managedBy && re.test(s.name));
}

// ── Seeds & dormancy ────────────────────────────────────────────────────────

function dormancyLine(moduleName: string): string {
  return `> [${moduleName} disabled ${new Date().toISOString().slice(0, 10)} — retained as state; no proactive cadence active]`;
}

const dormancyPrefix = (moduleName: string) => `> [${moduleName} disabled `;

/** Stamp a dormancy header on declared seeds — idempotent (never double-stamps). */
function stampSeeds(manifest: ModuleManifest): void {
  for (const seed of manifest.seeds ?? []) {
    const file = dataPath(seed);
    if (!existsSync(file)) continue;
    const content = readFileSync(file, 'utf-8');
    if (content.startsWith(dormancyPrefix(manifest.name))) continue;
    writeFileSync(file, `${dormancyLine(manifest.name)}\n\n${content}`);
    dataSync.trackWrite(seed);
  }
}

function unstampSeeds(manifest: ModuleManifest): void {
  for (const seed of manifest.seeds ?? []) {
    const file = dataPath(seed);
    if (!existsSync(file)) continue;
    const content = readFileSync(file, 'utf-8');
    if (!content.startsWith(dormancyPrefix(manifest.name))) continue;
    const nl = content.indexOf('\n');
    writeFileSync(file, content.slice(nl + 1).replace(/^\n+/, ''));
    dataSync.trackWrite(seed);
  }
}

/** Seeds are state: create-if-missing (rendered once), never overwritten. */
function applySeeds(manifest: ModuleManifest, config: Record<string, unknown>): void {
  for (const seed of manifest.seeds ?? []) {
    const dest = dataPath(seed);
    if (existsSync(dest)) continue;
    const src = path.join(moduleDir(manifest.name), 'seeds', seed);
    if (!existsSync(src)) { console.warn(`[modules] ${manifest.name}: seed source missing: seeds/${seed}`); continue; }
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, renderTemplate(readFileSync(src, 'utf-8'), config, `${manifest.name}/seeds/${seed}`));
    dataSync.trackWrite(seed);
  }
}

// ── Journal ─────────────────────────────────────────────────────────────────

/** One lifecycle line into the workspace journal so the agent's self-knowledge matches reality. */
function journal(line: string): void {
  try {
    const file = dataPath('workspace', 'journal.md');
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `- ${new Date().toISOString()} ${line}\n`);
    dataSync.trackWrite('workspace/journal.md');
  } catch (err) {
    console.warn('[modules] journal append failed:', (err as Error).message);
  }
}

// ── skills-defaults ─────────────────────────────────────────────────────────

/** Add on install/enable only — reconcile never re-adds (a user's removal sticks). */
function addDefaultSkills(manifest: ModuleManifest): void {
  const names = manifest.defaultSkills ?? [];
  if (!names.length) return;
  const existing = getDefaultSkills();
  const have = new Set(existing.map((e) => (typeof e === 'string' ? e : e.name)));
  const added = names.filter((n) => !have.has(n));
  if (added.length) setDefaultSkills([...existing, ...added]);
}

function removeDefaultSkills(manifest: ModuleManifest): void {
  const names = new Set(manifest.defaultSkills ?? []);
  if (!names.size) return;
  const existing = getDefaultSkills();
  const kept = existing.filter((e) => !names.has(typeof e === 'string' ? e : e.name));
  if (kept.length !== existing.length) setDefaultSkills(kept);
}

// ── Reconcile ───────────────────────────────────────────────────────────────

/** Apply one enabled module's folder into data/ — idempotent. */
function applyModule(rec: InstalledModule): void {
  const manifest = installedManifest(rec.name);
  const config = effectiveConfig(manifest, rec.config);

  // Skills: render → write-if-changed
  for (const file of manifest.skills ?? []) {
    const { name, content } = renderSkill(manifest, file, config);
    if (!skillOwnedBy(name, rec.name)) {
      console.warn(`[modules] ${rec.name}: skill "${name}" is owned elsewhere — not overwriting`);
      continue;
    }
    const dest = skillPath(name);
    if (existsSync(dest) && readFileSync(dest, 'utf-8') === content) continue;
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, content);
    dataSync.trackWrite(`skills/${name}.md`);
  }

  // Schedules: upsert preserving runtime state; module uid — NOT the system uid (builtins purge trap)
  const expectedIds = new Set<string>();
  for (const def of manifest.schedules ?? []) {
    const id = scheduleIdFor(rec, def);
    expectedIds.add(id);
    const rendered = renderDeep({ name: def.name, trigger: def.trigger, task: def.task }, config, `${rec.name}/schedules/${def.def}`);
    const existing = scheduler.getSchedule(id);
    const now = Date.now();
    const schedule: Schedule = {
      id,
      name: rendered.name,
      enabled: existing ? existing.enabled : (def.enabled ?? true),
      trigger: rendered.trigger,
      task: rendered.task,
      scope: 'system',
      createdBy: existing?.createdBy ?? { uid: `module:${rec.name}`, email: 'module@shraga.local' },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastRun: existing?.lastRun,
      runCount: existing?.runCount ?? 0,
      managedBy: rec.name,
    };
    const result = scheduler.upsertSchedule(schedule);
    if (!result.ok) console.error(`[modules] ${rec.name}: schedule "${def.def}" rejected: ${result.error}`);
  }
  // Remove managed schedules whose def vanished
  for (const s of managedSchedules(rec.name)) {
    if (!expectedIds.has(s.id)) scheduler.deleteSchedule(s.id);
  }

  applySeeds(manifest, config);
}

/** Boot-time reconcile of all installed modules. Builtin version bump → auto-reapply folder. */
export function reconcileInstalledModules(): void {
  const state = loadState();
  let dirty = false;
  for (const rec of state.installed) {
    try {
      if (rec.source === 'builtin') {
        const builtinDir = path.join(BUILTIN_MODULES_DIR, rec.name);
        if (existsSync(builtinDir)) {
          const shipped = readManifest(builtinDir);
          if (shipped.version !== rec.version) {
            copyDir(builtinDir, moduleDir(rec.name));
            rec.version = shipped.version;
            dirty = true;
            console.log(`[modules] ${rec.name}: builtin updated → ${shipped.version}`);
          }
        }
      }
      if (rec.enabled) applyModule(rec);
    } catch (err) {
      console.error(`[modules] reconcile failed for ${rec.name}:`, (err as Error).message);
    }
  }
  if (dirty) saveState(state);
}

// ── Install / enable / disable / uninstall ──────────────────────────────────

function copyDir(src: string, dest: string): void {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else copyFileSync(s, d);
  }
}

/** Install from a builtin name or an explicit folder path. Idempotent re-install = upgrade
 *  (keeps config/enabled/adoptions). Adopts unmanaged same-name artifacts, with backup. */
export function installModule(opts: { name?: string; path?: string }): InstalledModule {
  let srcDir: string;
  let source: string;
  if (opts.path) {
    srcDir = path.resolve(opts.path);
    source = srcDir;
  } else if (opts.name) {
    srcDir = path.join(BUILTIN_MODULES_DIR, opts.name);
    source = 'builtin';
  } else {
    throw new Error('install requires "name" (builtin) or "path"');
  }
  if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) throw new Error(`Module folder not found: ${srcDir}`);
  const manifest = readManifest(srcDir);
  if (opts.name && manifest.name !== opts.name) throw new Error(`Manifest name "${manifest.name}" ≠ requested "${opts.name}"`);

  const destDir = moduleDir(manifest.name);
  if (path.resolve(srcDir) !== path.resolve(destDir)) copyDir(srcDir, destDir);
  for (const rel of walkFiles(destDir)) dataSync.trackWrite(`modules/${manifest.name}/${rel}`);

  const state = loadState();
  let rec = state.installed.find((m) => m.name === manifest.name);
  const fresh = !rec;
  if (!rec) {
    rec = {
      name: manifest.name,
      version: manifest.version,
      enabled: true,
      config: effectiveConfig(manifest),
      installedAt: Date.now(),
      source,
    };
    state.installed.push(rec);
  } else {
    rec.version = manifest.version;
    rec.source = source;
    rec.config = { ...effectiveConfig(manifest), ...rec.config };
  }

  if (fresh) adoptExisting(rec, manifest);
  saveState(state);
  if (rec.enabled) {
    applyModule(rec);
    addDefaultSkills(manifest);
  }
  journal(`module "${manifest.name}"@${manifest.version} ${fresh ? 'installed' : 'reinstalled'}${rec.enabled ? '' : ' (disabled)'}`);
  return rec;
}

/** Adoption (install-time, fresh installs only): unmanaged exact-name matches become managed.
 *  Skills: back up original to data/modules/<name>/adopted/*.orig before first overwrite.
 *  Schedules: stamp managedBy, keep the existing id, preserve enabled/runCount/lastRun. */
function adoptExisting(rec: InstalledModule, manifest: ModuleManifest): void {
  for (const file of manifest.skills ?? []) {
    const name = skillNameFor(file);
    const existing = skillPath(name);
    if (!existsSync(existing)) continue;
    const { meta } = parseSkillFrontmatter(readFileSync(existing, 'utf-8'));
    if (meta.managedBy) continue;
    const bakDir = path.join(moduleDir(rec.name), 'adopted');
    mkdirSync(bakDir, { recursive: true });
    copyFileSync(existing, path.join(bakDir, `${name}.md.orig`));
    dataSync.trackWrite(`modules/${rec.name}/adopted/${name}.md.orig`);
    // Adoption = install-time consent to take the name over: with the backup safe,
    // remove the unmanaged original so applyModule's ownership guard lets the rendered
    // skill in (the guard otherwise protects unmanaged user skills from module clobber).
    unlinkSync(existing);
    dataSync.trackWrite(`skills/${name}.md`);
    console.log(`[modules] ${rec.name}: adopted existing skill "${name}" (backup in adopted/)`);
  }
  for (const def of manifest.schedules ?? []) {
    const renderedName = renderTemplate(def.name, effectiveConfig(manifest, rec.config));
    const match = scheduler.listSchedules().find((s) => !s.managedBy && s.name === renderedName);
    if (!match) continue;
    (rec.adoptedScheduleIds ??= {})[def.def] = match.id;
    console.log(`[modules] ${rec.name}: adopted existing schedule "${renderedName}" (id ${match.id})`);
  }
}

function* walkFiles(dir: string, prefix = ''): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) yield* walkFiles(path.join(dir, entry.name), rel);
    else yield rel;
  }
}

export function enableModule(name: string): InstalledModule {
  const state = loadState();
  const rec = state.installed.find((m) => m.name === name);
  if (!rec) throw new Error(`Module "${name}" not installed`);
  const manifest = installedManifest(name);
  rec.enabled = true;
  applyModule(rec);
  // Restore per-schedule enabled states captured at disable
  const snapshot = rec.scheduleEnabledSnapshot;
  if (snapshot) {
    for (const [id, enabled] of Object.entries(snapshot)) scheduler.toggleSchedule(id, enabled);
    delete rec.scheduleEnabledSnapshot;
  }
  unstampSeeds(manifest);
  addDefaultSkills(manifest);
  saveState(state);
  journal(`module "${name}" enabled — schedules restored, skills active`);
  return rec;
}

export function disableModule(name: string): InstalledModule {
  const state = loadState();
  const rec = state.installed.find((m) => m.name === name);
  if (!rec) throw new Error(`Module "${name}" not installed`);
  const manifest = installedManifest(name);

  // Snapshot + disable managed schedules
  const snapshot: Record<string, boolean> = {};
  for (const s of managedSchedules(name)) {
    snapshot[s.id] = s.enabled;
    scheduler.toggleSchedule(s.id, false);
  }
  // Offspring: agent-booked continuations — disable (never delete) so they can't fire into a missing skill
  for (const s of offspringSchedules(manifest)) {
    snapshot[s.id] = s.enabled;
    scheduler.toggleSchedule(s.id, false);
  }

  // Remove rendered skill files (only ones we own) + drop module entries from skills-defaults
  for (const file of manifest.skills ?? []) {
    const skillName = skillNameFor(file);
    const dest = skillPath(skillName);
    if (existsSync(dest) && skillOwnedBy(skillName, name)) {
      unlinkSync(dest);
      dataSync.trackWrite(`skills/${skillName}.md`);
    }
  }
  removeDefaultSkills(manifest);
  stampSeeds(manifest);

  rec.enabled = false;
  rec.scheduleEnabledSnapshot = snapshot;
  saveState(state);
  journal(`module "${name}" disabled — schedules paused, skills removed, seeds retained as dormant state`);
  return rec;
}

export function setModuleConfig(name: string, config: Record<string, unknown>): InstalledModule {
  const state = loadState();
  const rec = state.installed.find((m) => m.name === name);
  if (!rec) throw new Error(`Module "${name}" not installed`);
  const manifest = installedManifest(name);
  const schema = manifest.configSchema ?? {};
  for (const [key, val] of Object.entries(config)) {
    const field = schema[key];
    if (!field) throw new Error(`Unknown config key "${key}"`);
    if (typeof val !== field.type) throw new Error(`Config "${key}" must be ${field.type}`);
  }
  rec.config = { ...rec.config, ...(config as Record<string, string | number | boolean>) };
  saveState(state);
  if (rec.enabled) applyModule(rec);
  return rec;
}

/** Uninstall: rendered skills + module-created schedules + folder + state entry go; SEEDS STAY
 *  (stamped dormant). Adopted schedules are released (managedBy cleared, disabled), never deleted.
 *  Offspring schedules are disabled, never deleted. */
export function uninstallModule(name: string): void {
  const state = loadState();
  const idx = state.installed.findIndex((m) => m.name === name);
  if (idx < 0) throw new Error(`Module "${name}" not installed`);
  const rec = state.installed[idx];
  let manifest: ModuleManifest | null = null;
  try { manifest = installedManifest(name); } catch { /* folder gone — best-effort cleanup below */ }

  if (manifest) {
    for (const file of manifest.skills ?? []) {
      const skillName = skillNameFor(file);
      const dest = skillPath(skillName);
      if (existsSync(dest) && skillOwnedBy(skillName, name)) {
        unlinkSync(dest);
        dataSync.trackWrite(`skills/${skillName}.md`);
      }
    }
    removeDefaultSkills(manifest);
    for (const s of offspringSchedules(manifest)) scheduler.toggleSchedule(s.id, false);
    stampSeeds(manifest);
  }
  const adoptedIds = new Set(Object.values(rec.adoptedScheduleIds ?? {}));
  for (const s of managedSchedules(name)) {
    if (adoptedIds.has(s.id)) {
      delete s.managedBy;
      scheduler.toggleSchedule(s.id, false); // persists the un-stamp too
    } else {
      scheduler.deleteSchedule(s.id);
    }
  }

  rmSync(moduleDir(name), { recursive: true, force: true });
  dataSync.trackWrite(`modules/${name}`);
  state.installed.splice(idx, 1);
  saveState(state);
  journal(`module "${name}" uninstalled — skills/schedules removed, seeds retained as dormant state`);
}
