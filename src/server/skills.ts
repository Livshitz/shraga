import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, unlinkSync, renameSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR, dataPath } from './paths.ts';
import { getBuiltinSkillNames } from './seed.ts';
import { dataSync } from './data-sync.ts';
import { injectFile } from './file-inject.ts';
import { getGlobalMcpConfig } from './mcp.ts';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..');

const SKILLS_DIR = dataPath('skills');
const DEFAULTS_PATH = dataPath('skills-defaults.json');

function ensureDir() {
  mkdirSync(SKILLS_DIR, { recursive: true });
}

export interface SkillMeta {
  description?: string;
  model?: string;
  allowedTools?: string[];
  argumentHint?: string;
  triggers?: string[];
  expires?: string;
  origin?: string;
  reviewed?: boolean;
}

export function isExpired(meta: SkillMeta): boolean {
  if (!meta.expires) return false;
  return new Date(meta.expires).getTime() < Date.now();
}

export interface Skill {
  name: string;
  content: string;
  builtin: boolean;
  meta: SkillMeta;
}

export function parseSkillFrontmatter(content: string): { meta: SkillMeta; body: string } {
  if (!content.startsWith('---')) return { meta: {}, body: content };
  const end = content.indexOf('---', 3);
  if (end < 0) return { meta: {}, body: content };
  const yaml = content.slice(3, end).trim();
  const body = content.slice(end + 3).trim();
  const meta: SkillMeta = {};
  const lines = yaml.split('\n');
  let currentKey = '';
  for (const line of lines) {
    const listMatch = line.match(/^\s+-\s+"?([^"]+)"?\s*$/);
    if (listMatch && currentKey === 'triggers') {
      (meta.triggers ??= []).push(listMatch[1]);
      continue;
    }
    const [k, ...rest] = line.split(':');
    const key = k.trim();
    const val = rest.join(':').trim();
    currentKey = key;
    if (key === 'description') meta.description = val;
    if (key === 'model') meta.model = val;
    if (key === 'allowed-tools') meta.allowedTools = val.split(',').map(s => s.trim());
    if (key === 'argument-hint') meta.argumentHint = val;
    if (key === 'triggers' && val) {
      try { meta.triggers = JSON.parse(val); } catch {
        meta.triggers = val.split(',').map(s => s.trim());
      }
    }
    if (key === 'expires') meta.expires = val;
    if (key === 'origin') meta.origin = val;
    if (key === 'reviewed') meta.reviewed = val === 'true' ? true : val === 'false' ? false : undefined;
  }
  return { meta, body };
}

export function isBuiltin(name: string): boolean {
  return getBuiltinSkillNames().includes(name);
}

export function listSkills(): string[] {
  ensureDir();
  return readdirSync(SKILLS_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.slice(0, -3));
}

export function listMcpCommands(): string[] {
  const skillNames = new Set(listSkills());
  return Object.keys(getGlobalMcpConfig()).filter(name => !skillNames.has(name));
}

export function getMcpCommandPrompt(mcpName: string, args: string): string {
  const bundled = resolveMcpBundledSkillContent(mcpName);
  if (bundled) {
    const { body } = parseSkillFrontmatter(bundled);
    return formatMcpCommandBlock(mcpName, body, args);
  }
  return formatMcpCommandBlock(mcpName, '', args);
}

function formatMcpCommandBlock(mcpName: string, skillBody: string, args: string): string {
  const instruction = args || 'Show available tools and what you can do.';
  const context = skillBody ? `\n\nReference:\n${skillBody}` : '';
  return `<command name="${mcpName}">\nUse the ${mcpName} MCP tools to: ${instruction}${context}\n</command>`;
}

/**
 * Markdown from `vendor/<serverName>/.claude/skills/<serverName>/SKILL.md` — same file the MCP exposes as skill://serverName/workflow.
 */
export function resolveMcpBundledSkillContent(serverName: string): string | null {
  const file = path.join(PROJECT_ROOT, 'vendor', serverName, '.claude/skills', serverName, 'SKILL.md');
  if (!existsSync(file)) return null;
  return readFileSync(file, 'utf-8');
}

/**
 * One `<skill>` block; `mcp-resource-uri` only when vendor SKILL.md exists (same bytes as MCP resources/read).
 */
export function resolvedSkillInjectionBlock(name: string): string | null {
  const bundled = resolveMcpBundledSkillContent(name);
  if (bundled !== null) {
    return `<skill name="${name}" mcp-resource-uri="skill://${name}/workflow">\n${bundled}\n</skill>`;
  }
  const s = getSkill(name);
  if (!s) return null;
  const { body } = parseSkillFrontmatter(s.content);
  return `<skill name="${name}">\n${body}\n</skill>`;
}

function mcpSkillFilePath(serverName: string): string {
  return path.join(PROJECT_ROOT, 'vendor', serverName, '.claude/skills', serverName, 'SKILL.md');
}

/**
 * Build a compact block for all active MCP skills.
 * @param mcpNames — active MCP server names
 * @param maxChars — 0 = hint-only (name + resource URI), >0 = injectFile with that limit
 */
export function buildMcpSkillHintsBlock(mcpNames: string[], maxChars = 0): string {
  const entries: string[] = [];
  for (const name of mcpNames) {
    const file = mcpSkillFilePath(name);
    if (!existsSync(file)) continue;
    if (maxChars > 0) {
      const block = injectFile(file, { label: 'mcp-skill', maxChars });
      if (block) entries.push(block);
    } else {
      let content = readFileSync(file, 'utf-8');
      if (content.startsWith('---')) {
        const endIdx = content.indexOf('---', 3);
        if (endIdx > 0) content = content.slice(endIdx + 3);
      }
      const desc = content.split('\n').find(l => l.trim() && !l.startsWith('#'))?.trim() ?? name;
      entries.push(`- **${name}**: \`skill://${name}/workflow\` — ${desc}`);
    }
  }
  if (entries.length === 0) return '';
  if (maxChars > 0) return `<mcp-skills>\n${entries.join('\n')}\n</mcp-skills>`;
  return `<mcp-skills>\nActive MCP servers with workflow docs — read the skill resource URI for full tool reference and usage patterns:\n${entries.join('\n')}\n</mcp-skills>`;
}

export function getSkill(name: string): Skill | null {
  const file = path.join(SKILLS_DIR, `${name}.md`);
  if (!existsSync(file)) return null;
  const raw = readFileSync(file, 'utf-8');
  const { meta } = parseSkillFrontmatter(raw);
  return { name, content: raw, builtin: isBuiltin(name), meta };
}

export function saveSkill(name: string, content: string): void {
  if (isBuiltin(name)) throw new Error(`Cannot modify built-in skill "${name}"`);
  ensureDir();
  writeFileSync(path.join(SKILLS_DIR, `${name}.md`), content);
  dataSync.trackWrite(`skills/${name}.md`);
}

export function deleteSkill(name: string): void {
  if (isBuiltin(name)) throw new Error(`Cannot delete built-in skill "${name}"`);
  const file = path.join(SKILLS_DIR, `${name}.md`);
  if (existsSync(file)) unlinkSync(file);
  dataSync.trackWrite(`skills/${name}.md`);
}

export function duplicateSkill(source: string, newName: string): Skill {
  const original = getSkill(source);
  if (!original) throw new Error(`Skill "${source}" not found`);
  if (existsSync(path.join(SKILLS_DIR, `${newName}.md`))) throw new Error(`Skill "${newName}" already exists`);
  ensureDir();
  writeFileSync(path.join(SKILLS_DIR, `${newName}.md`), original.content);
  dataSync.trackWrite(`skills/${newName}.md`);
  return { name: newName, content: original.content, builtin: false, meta: original.meta };
}

export function renameSkill(oldName: string, newName: string): void {
  if (isBuiltin(oldName)) throw new Error(`Cannot rename built-in skill "${oldName}"`);
  const oldFile = path.join(SKILLS_DIR, `${oldName}.md`);
  const newFile = path.join(SKILLS_DIR, `${newName}.md`);
  if (!existsSync(oldFile)) throw new Error(`Skill "${oldName}" not found`);
  if (existsSync(newFile)) throw new Error(`Skill "${newName}" already exists`);
  renameSync(oldFile, newFile);
  dataSync.trackWrite(`skills/${oldName}.md`);
  dataSync.trackWrite(`skills/${newName}.md`);
  // Update defaults list if the old name was a default
  const defs = getDefaultSkills();
  const idx = defs.findIndex(e => parseDefaultEntry(e).name === oldName);
  if (idx !== -1) {
    const prev = defs[idx];
    if (typeof prev === 'string') {
      defs[idx] = newName;
    } else {
      defs[idx] = { ...prev, name: newName };
    }
    setDefaultSkills(defs);
  }
}

// Default skills — injected into every conversation
export function getDefaultSkills(): DefaultSkillEntry[] {
  if (!existsSync(DEFAULTS_PATH)) return [];
  try { return JSON.parse(readFileSync(DEFAULTS_PATH, 'utf-8')); } catch { return []; }
}

export function getDefaultSkillNames(): string[] {
  return getDefaultSkills().map(e => parseDefaultEntry(e).name);
}

export function setDefaultSkills(names: DefaultSkillEntry[]): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(DEFAULTS_PATH, JSON.stringify(names, null, 2));
  dataSync.trackWrite('skills-defaults.json');
}

/** `string` = full inject, `{ name, capped: true }` = capped at default, `{ name, capped: 600 }` = custom cap */
export type DefaultSkillEntry = string | { name: string; capped?: boolean | number };

function parseDefaultEntry(entry: DefaultSkillEntry): { name: string; capChars: number } {
  if (typeof entry === 'string') return { name: entry, capChars: 0 };
  const c = entry.capped;
  if (c === true) return { name: entry.name, capChars: 600 };
  if (typeof c === 'number' && c > 0) return { name: entry.name, capChars: c };
  return { name: entry.name, capChars: 0 };
}

export function resolveDefaultSkillsContent(): string {
  const defaults = getDefaultSkills();
  if (defaults.length === 0) return '';
  const blocks: string[] = [];
  for (const entry of defaults) {
    const { name, capChars } = parseDefaultEntry(entry);
    const skill = getSkill(name);
    if (skill && isExpired(skill.meta)) continue;
    if (capChars > 0) {
      const file = path.join(SKILLS_DIR, `${name}.md`);
      const block = injectFile(file, { label: 'skill', maxChars: capChars });
      if (block) blocks.push(block);
    } else {
      const block = resolvedSkillInjectionBlock(name);
      if (block) blocks.push(block);
    }
  }
  return blocks.join('\n');
}

export function expandMentionedSkills(text: string): string {
  const mentions = [...new Set(Array.from(text.matchAll(/@([\w-]+)/g), (m) => m[1]))];
  if (mentions.length === 0) return text;
  const blocks = mentions
    .map((name) => {
      const file = path.join(SKILLS_DIR, `${name}.md`);
      if (existsSync(file)) return injectFile(file, { label: 'skill', maxChars: 600 });
      const vendorFile = mcpSkillFilePath(name);
      if (existsSync(vendorFile)) return injectFile(vendorFile, { label: 'skill', maxChars: 600 });
      return null;
    })
    .filter((s): s is string => !!s);
  if (blocks.length === 0) return text;
  return `${blocks.join('\n')}\n\n${text}`;
}

/**
 * Compact index of ALL available skills — name, description, triggers.
 * Injected into every session so the agent knows what's available.
 */
export function buildSkillIndexBlock(): string {
  const names = listSkills();
  if (names.length === 0) return '';
  const defaultNames = new Set(getDefaultSkillNames());
  const lines: string[] = [];
  for (const name of names) {
    const skill = getSkill(name);
    if (!skill) continue;
    const { meta } = parseSkillFrontmatter(skill.content);
    if (isExpired(meta)) continue;
    const desc = meta.description || '';
    const triggers = meta.triggers?.length ? ` [triggers: ${meta.triggers.join(', ')}]` : '';
    const expiry = meta.expires ? ` [expires: ${meta.expires}]` : '';
    const tag = defaultNames.has(name) ? ' (default)' : '';
    lines.push(`- **${name}**${tag}: ${desc}${triggers}${expiry}`);
  }
  return `<available-skills>\nSkills available in data/skills/. Use Read to load full skill content when needed.\n${lines.join('\n')}\n</available-skills>`;
}

/**
 * Match message text against skill triggers. Returns matched skill names.
 * Skips skills already in the defaults list (they're already injected).
 */
export function matchTriggeredSkillNames(message: string, context?: Record<string, string>): string[] {
  const ctxPrefix = context
    ? Object.entries(context).map(([k, v]) => `[${k}:${v}]`).join(' ')
    : '';
  const triggerInput = ctxPrefix ? `${ctxPrefix} ${message}` : message;
  const lower = triggerInput.toLowerCase();
  const defaultNames = new Set(getDefaultSkillNames());
  const matched: string[] = [];
  for (const name of listSkills()) {
    if (defaultNames.has(name)) continue;
    const skill = getSkill(name);
    if (!skill) continue;
    const { meta } = parseSkillFrontmatter(skill.content);
    if (isExpired(meta)) continue;
    if (!meta.triggers?.length) continue;
    if (meta.origin === 'auto' && meta.reviewed === false) continue;
    const hit = meta.triggers.some(t => lower.includes(t.toLowerCase()));
    if (hit) {
      console.log(`[skills] Trigger matched: ${name}${ctxPrefix ? ` (context: ${ctxPrefix})` : ''}`);
      matched.push(name);
    }
  }
  return matched;
}

/** Build injection blocks for a list of skill names (deleted/unresolvable skills and defaults — already injected — are skipped). */
export function skillInjectionBlocks(names: string[]): string {
  const defaultNames = new Set(getDefaultSkillNames());
  return names
    .filter((name) => !defaultNames.has(name))
    .map((name) => resolvedSkillInjectionBlock(name))
    .filter((b): b is string => !!b)
    .join('\n');
}

/** Lint skills for index visibility — returns warnings for skills missing description frontmatter. */
export function lintSkills(): string[] {
  const warnings: string[] = [];
  for (const name of listSkills()) {
    const skill = getSkill(name);
    if (!skill) continue;
    const { meta } = parseSkillFrontmatter(skill.content);
    if (!meta.description) warnings.push(`${name}: missing description frontmatter — invisible in the skill index`);
  }
  return warnings;
}

export function purgeExpiredSkills(): string[] {
  const purged: string[] = [];
  for (const name of listSkills()) {
    if (isBuiltin(name)) continue;
    const skill = getSkill(name);
    if (!skill) continue;
    if (isExpired(skill.meta)) {
      console.log(`[skills] Purging expired skill: ${name} (expired ${skill.meta.expires})`);
      unlinkSync(path.join(SKILLS_DIR, `${name}.md`));
      purged.push(name);
    }
  }
  if (purged.length) {
    const defaults = getDefaultSkills();
    const filtered = defaults.filter(e => !purged.includes(parseDefaultEntry(e).name));
    if (filtered.length < defaults.length) setDefaultSkills(filtered);
  }
  return purged;
}
