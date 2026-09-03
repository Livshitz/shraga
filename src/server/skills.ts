import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, unlinkSync, renameSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR, dataPath, APP_ROOT } from './paths.ts';
import { getBuiltinSkillNames } from './seed.ts';
import { dataSync } from './data-sync.ts';
import { injectFile } from './file-inject.ts';
import { getGlobalMcpConfig } from './mcp.ts';

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
  /** Per-skill turn budget. Gap-fills `directives.turns` for the turn that invokes the skill —
   * inline `[turns:N]` and a session-pinned value both still win. Capped at MAX_SKILL_TURNS. */
  turns?: number;
  triggers?: string[];
  expires?: string;
  origin?: string;
  reviewed?: boolean;
  /** `managed-by: <module>@<version>` — set on skills rendered by a data-plane module. */
  managedBy?: string;
}

/** Ceiling on a skill's self-declared turn budget. A skill file is data — it is edited without a
 * deploy and shipped by rsync — so an unbounded number there is an unattended spend hazard. 300 is
 * one step above the 250 the video-ad pipeline needs in practice, so no real skill is clipped,
 * while a typo'd `turns: 30000` costs a bounded worst case instead of an open-ended one. A human
 * typing `[turns:N]` inline is NOT capped — that is a deliberate, attended choice. */
export const MAX_SKILL_TURNS = 300;

/** Largest turn budget declared by any of the named skills, clamped to MAX_SKILL_TURNS. */
export function resolveSkillTurns(names: (string | undefined)[]): number | undefined {
  let best = 0;
  for (const name of names) {
    if (!name) continue;
    const t = getSkill(name)?.meta.turns;
    if (t && t > best) best = t;
  }
  return best ? Math.min(best, MAX_SKILL_TURNS) : undefined;
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
    if ((key === 'turns' || key === 'max-turns') && /^\d+$/.test(val)) meta.turns = parseInt(val, 10);
    if (key === 'triggers' && val) {
      try { meta.triggers = JSON.parse(val); } catch {
        meta.triggers = val.split(',').map(s => s.trim());
      }
    }
    if (key === 'expires') meta.expires = val;
    if (key === 'origin') meta.origin = val;
    if (key === 'managed-by') meta.managedBy = val;
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
  const file = path.join(APP_ROOT, 'vendor', serverName, '.claude/skills', serverName, 'SKILL.md');
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
  return path.join(APP_ROOT, 'vendor', serverName, '.claude/skills', serverName, 'SKILL.md');
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

/* ── Trigger matching ─────────────────────────────────────────────────────────
 * Triggers are authored as natural phrases ("make a video ad"), but real briefs
 * insert words into them ("make a NEW video ad variant"). A plain substring test
 * missed those, and a missed trigger silently costs more than the skill text —
 * it also drops the skill's `turns` budget (see resolveSkillTurns).
 *
 * So: match on WORD TOKENS, not raw characters.
 *  - Short triggers (< MIN_TOKENS_FOR_GAPS) must still match as a contiguous run.
 *    This is strictly NARROWER than `includes` — "cost per" no longer fires on
 *    "cost performance", "ad" no longer fires on "adding".
 *  - Longer triggers (3+ tokens) tolerate a few inserted words, bounded hard so
 *    the phrase cannot smear across a whole message.
 * A trailing plural on either side is tolerated at every position ("video ads").
 */

/** Words, keeping decimal numbers whole so "wan 2.2" is [wan, 2.2] and not [wan, 2, 2]. */
const TRIGGER_TOKEN_RE = /[a-z0-9]+(?:\.[0-9]+)*/g;
/** Triggers with fewer tokens than this must match contiguously — too short to be safely loosened. */
const MIN_TOKENS_FOR_GAPS = 3;
/** Words that may be inserted across the WHOLE trigger phrase. This one bound is what stops a
 * phrase smearing over a long message: "make a video ad" reaches "make a NEW video ad" and
 * "make me a new video ad", but not "make something. later, a video. then an ad.". */
const MAX_INSERTED = 3;
/** Articles the trigger's AUTHOR typed that the asker may not ("make SOME video ads"). Skipping
 * one costs an insertion, so it is not free. */
const TRIGGER_FILLER = new Set(['a', 'an', 'the']);

function tokenizeTrigger(s: string): string[] {
  return s.toLowerCase().match(TRIGGER_TOKEN_RE) ?? [];
}

/** Token equality with a tolerated trailing plural on either side ("ad" ~ "ads", "match" ~ "matches"). */
function tokenEq(a: string, b: string): boolean {
  if (a === b) return true;
  const [long, short] = a.length > b.length ? [a, b] : [b, a];
  return long === `${short}s` || long === `${short}es`;
}

function matchTokens(hay: string[], needle: string[]): boolean {
  if (!needle.length || needle.length > hay.length) return false;
  for (let start = 0; start + needle.length <= hay.length; start++) {
    if (!tokenEq(hay[start], needle[0])) continue;
    if (needle.length < MIN_TOKENS_FOR_GAPS) {
      // Too short to loosen. Contiguous whole words only — strictly NARROWER than `includes`,
      // which fired "ad set" on "ad settings" and "cost per" on "cost performance".
      if (needle.every((t, k) => tokenEq(hay[start + k], t))) return true;
      continue;
    }
    // Leftmost-greedy subsequence, then bound the SPAN it consumed.
    let i = start + 1, n = 1, inserted = 0;
    while (n < needle.length && i < hay.length && inserted <= MAX_INSERTED) {
      if (tokenEq(hay[i], needle[n])) { n++; i++; continue; }
      i++; inserted++;
    }
    if (n === needle.length && inserted <= MAX_INSERTED) return true;
  }
  return false;
}

/**
 * True when `trigger` occurs in `text` as an in-order run of whole words spanning at most
 * MAX_INSERTED extra words. Exported for tests — a trigger layer is easy to widen by accident.
 *
 * Two passes rather than one clever one: the trigger as authored, then the trigger with its
 * articles dropped ("make a video ad" -> make/video/ad, so "make SOME video ads" lands). A single
 * pass that skipped articles inline had to guess, greedily and wrongly, whether the article ahead
 * in the message was the one the trigger meant.
 */
export function triggerMatches(text: string, trigger: string): boolean {
  const hay = tokenizeTrigger(text);
  const needle = tokenizeTrigger(trigger);
  if (matchTokens(hay, needle)) return true;
  const stripped = needle.filter(t => !TRIGGER_FILLER.has(t));
  return stripped.length !== needle.length && stripped.length >= MIN_TOKENS_FOR_GAPS
    && matchTokens(hay, stripped);
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
    const hit = meta.triggers.some(t => triggerMatches(lower, t));
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
