/** Data-plane module system — declarative bundles of skills + schedules + seeds.
 *  A module is a folder: module.json (manifest) + skill templates + seeds/.
 *  No server code — the service reconciles the folder into data/ at runtime. */

import type { Trigger, Task } from '../scheduler/types.ts';

/** One field in a module's config schema. `default` doubles as the initial value. */
export interface ModuleConfigField {
  type: 'string' | 'number' | 'boolean';
  default?: string | number | boolean;
  description?: string;
}

/** A schedule the module owns. `def` is the stable key → schedule id `mod-<module>-<def>`.
 *  String fields (trigger/task) may contain `{{key}}` config placeholders. */
export interface ModuleScheduleDef {
  def: string;
  name: string;
  trigger: Trigger;
  task: Task;
  /** Initial enabled state on first install (default true). Never re-forced by reconcile. */
  enabled?: boolean;
}

export interface ModuleManifest {
  name: string;
  version: string;
  description?: string;
  configSchema?: Record<string, ModuleConfigField>;
  /** Skill template files in the module folder (e.g. "routine.md.tmpl" → data/skills/routine.md). */
  skills?: string[];
  schedules?: ModuleScheduleDef[];
  /** Data-relative paths (e.g. "workspace/agenda.md"); source under <module>/seeds/<path>.
   *  Create-if-missing only — seeds are state, never overwritten. */
  seeds?: string[];
  /** Skill names to add to skills-defaults.json on install/enable (not re-added by reconcile). */
  defaultSkills?: string[];
  /** Artifacts the module's DOCTRINE causes the agent to create (not declared above).
   *  `schedules` is a glob on schedule NAME (e.g. "self-wake-*"): disable/uninstall
   *  disables (never deletes) matches so agent-booked continuations can't fire into
   *  a missing skill. */
  offspring?: { schedules?: string };
}

/** Persisted record in data/modules/state.json. */
export interface InstalledModule {
  name: string;
  version: string;
  enabled: boolean;
  config: Record<string, string | number | boolean>;
  installedAt: number;
  /** Origin: 'builtin' (defaults/modules) or the install path for local installs. */
  source: string;
  /** def → pre-existing schedule id adopted at install (kept instead of mod-<name>-<def>). */
  adoptedScheduleIds?: Record<string, string>;
  /** Per-schedule enabled map captured on disable, restored on enable. */
  scheduleEnabledSnapshot?: Record<string, boolean>;
}

export interface ModulesState {
  installed: InstalledModule[];
}
