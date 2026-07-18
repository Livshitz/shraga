import { mkdirSync, readdirSync, existsSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataPath } from './paths.ts';
import { resolveConfigPath } from './shraga-config.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULTS_DIR = path.resolve(__dirname, '../../defaults');

/**
 * Copy only when content differs — avoids bumping mtime on identical reseeds.
 * Critical for files in the runtime import graph (e.g. *.ext.ts): an unconditional
 * copyFileSync churns mtime every boot, and `bun --watch` then restarts → reseed →
 * restart loop. Returns true if a write happened.
 */
function copyIfChanged(src: string, dest: string): boolean {
  if (existsSync(dest)) {
    try {
      if (readFileSync(src).equals(readFileSync(dest))) return false;
    } catch {}
  }
  copyFileSync(src, dest);
  return true;
}

function copyDirRecursive(src: string, dest: string) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirRecursive(s, d);
    else copyFileSync(s, d);
  }
}

/**
 * Seed data/ from defaults/ on startup.
 * - Skills: always overwritten from defaults (they're shipped code)
 * - Other config files: only created if missing (preserves server state)
 */
export function seedDefaults() {
  if (!existsSync(DEFAULTS_DIR)) return;

  // Skills: always sync from defaults — these are code, not user data.
  const srcSkills = path.join(DEFAULTS_DIR, 'skills');
  if (existsSync(srcSkills)) {
    mkdirSync(dataPath('skills'), { recursive: true });
    let count = 0;
    for (const file of readdirSync(srcSkills).filter(f => f.endsWith('.md'))) {
      copyFileSync(path.join(srcSkills, file), dataPath('skills', file));
      count++;
    }
    console.log(`[seed] Synced ${count} built-in skills from defaults`);
  }

  // Typed subagent defs (data/agents/<name>.md): always sync from defaults — code, not user data.
  // An add-on engine's Task tool loads these (agentsDir) to enable the `agentType` param (e.g. 'summarizer').
  const srcAgents = path.join(DEFAULTS_DIR, 'agents');
  if (existsSync(srcAgents)) {
    mkdirSync(dataPath('agents'), { recursive: true });
    let count = 0;
    for (const file of readdirSync(srcAgents).filter(f => f.endsWith('.md'))) {
      copyFileSync(path.join(srcAgents, file), dataPath('agents', file));
      count++;
    }
    console.log(`[seed] Synced ${count} built-in subagent defs from defaults`);
  }

  // MCPs dir: ensure it exists for per-user configs
  mkdirSync(dataPath('mcps'), { recursive: true });

  // Scripts: seed agent-facing scripts from defaults → data/scripts/
  const srcScripts = path.join(DEFAULTS_DIR, 'scripts');
  const destScripts = dataPath('scripts');
  if (existsSync(srcScripts)) {
    mkdirSync(destScripts, { recursive: true });
    let synced = 0;
    for (const entry of readdirSync(srcScripts, { withFileTypes: true })) {
      if (entry.isDirectory()) continue;
      const dest = path.join(destScripts, entry.name);
      if (!existsSync(dest)) {
        copyFileSync(path.join(srcScripts, entry.name), dest);
        synced++;
      }
    }
    if (synced) console.log(`[seed] Seeded ${synced} agent scripts from defaults`);
  }

  // Extensions: drop-in route modules (data/extensions/*.ext.ts). Copy shipped
  // files from defaults (overwriting same-named, like skills — they're code), and
  // leave any deployment-added *.ext.ts untouched.
  const srcExt = path.join(DEFAULTS_DIR, 'extensions');
  if (existsSync(srcExt)) {
    mkdirSync(dataPath('extensions'), { recursive: true });
    let n = 0;
    for (const entry of readdirSync(srcExt, { withFileTypes: true })) {
      if (entry.isDirectory()) continue;
      if (copyIfChanged(path.join(srcExt, entry.name), dataPath('extensions', entry.name))) n++;
    }
    if (n) console.log(`[seed] Synced ${n} built-in extensions from defaults`);
  }

  // Config: seed the template only when NO config exists under any known name. Guarding on the
  // legacy name too is load-bearing — an existing deployment carries `unclaw.config.ts`, and
  // seeding a fresh (empty) `shraga.config.ts` beside it would take precedence and silently drop
  // every configured global MCP.
  const configSrc = path.join(DEFAULTS_DIR, 'shraga.config.ts');
  if (existsSync(configSrc) && !resolveConfigPath()) {
    copyFileSync(configSrc, dataPath('shraga.config.ts'));
    console.log('[seed] Seeded shraga.config.ts from defaults');
  }

  seedWorkspaceDefaults();

  // Skills defaults: merge new entries from defaults into existing list
  const skillDefaultsSrc = path.join(DEFAULTS_DIR, 'skills-defaults.json');
  const skillDefaultsDest = dataPath('skills-defaults.json');
  if (existsSync(skillDefaultsSrc)) {
    mkdirSync(path.dirname(skillDefaultsDest), { recursive: true });
    let defaults: string[] = [];
    try { defaults = JSON.parse(readFileSync(skillDefaultsSrc, 'utf-8')); } catch {}
    let existing: string[] = [];
    try { existing = JSON.parse(readFileSync(skillDefaultsDest, 'utf-8')); } catch {}
    const added = defaults.filter(s => !existing.includes(s));
    if (added.length || !existsSync(skillDefaultsDest)) {
      const merged = [...new Set([...existing, ...defaults])];
      writeFileSync(skillDefaultsDest, JSON.stringify(merged, null, 2));
      if (added.length) console.log(`[seed] Added default skills: ${added.join(', ')}`);
    }
  }
}

/** Shipped team knowledge: defaults/workspace → data/workspace (synced like extensions). */
function seedWorkspaceDefaults() {
  const srcWorkspace = path.join(DEFAULTS_DIR, 'workspace');
  if (!existsSync(srcWorkspace)) return;

  const destWorkspace = dataPath('workspace');
  mkdirSync(destWorkspace, { recursive: true });

  const srcKnowledge = path.join(srcWorkspace, 'knowledge');
  const destKnowledge = path.join(destWorkspace, 'knowledge');
  if (existsSync(srcKnowledge)) {
    mkdirSync(destKnowledge, { recursive: true });
    let n = 0;
    for (const file of readdirSync(srcKnowledge).filter(f => f.endsWith('.md'))) {
      if (copyIfChanged(path.join(srcKnowledge, file), path.join(destKnowledge, file))) n++;
    }
    if (n) console.log(`[seed] Synced ${n} workspace knowledge file(s) from defaults`);
  }

  const srcContext = path.join(srcWorkspace, 'context.md');
  const destContext = path.join(destWorkspace, 'context.md');
  if (!existsSync(srcContext)) return;

  if (!existsSync(destContext)) {
    copyFileSync(srcContext, destContext);
    console.log('[seed] Seeded workspace/context.md from defaults');
    return;
  }

  // context.md is create-if-missing on purpose: it's the operator's own briefing card, so once it
  // exists it belongs to them. Never rewrite it here — a seeder that edits live operator content is
  // how gardened knowledge gets silently clobbered on boot.
}

/** Returns names of skills shipped in defaults/ */
export function getBuiltinSkillNames(): string[] {
  const srcSkills = path.join(DEFAULTS_DIR, 'skills');
  if (!existsSync(srcSkills)) return [];
  return readdirSync(srcSkills)
    .filter(f => f.endsWith('.md'))
    .map(f => f.slice(0, -3));
}
