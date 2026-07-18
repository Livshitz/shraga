import { mkdirSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { dataPath } from './paths.ts';

const AGENTS_DIR = dataPath('agents');
const DEFAULTS_DIR = path.resolve(import.meta.dirname, '../../defaults/agents');

export interface AgentDef {
  description: string;
  prompt: string;
  model?: 'sonnet' | 'opus' | 'haiku' | 'inherit';
  tools?: string[];
  maxTurns?: number;
}

function parseFrontmatter(content: string): { meta: Record<string, string>; body: string } {
  if (!content.startsWith('---')) return { meta: {}, body: content };
  const end = content.indexOf('---', 3);
  if (end < 0) return { meta: {}, body: content };
  const yaml = content.slice(3, end).trim();
  const body = content.slice(end + 3).trim();
  const meta: Record<string, string> = {};
  for (const line of yaml.split('\n')) {
    const [k, ...rest] = line.split(':');
    if (k && rest.length) meta[k.trim()] = rest.join(':').trim();
  }
  return { meta, body };
}

export function loadAgents(): Record<string, AgentDef> {
  mkdirSync(AGENTS_DIR, { recursive: true });

  const agents: Record<string, AgentDef> = {};
  const dirs = [DEFAULTS_DIR, AGENTS_DIR];

  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter(f => f.endsWith('.md'))) {
      const name = f.slice(0, -3);
      const content = readFileSync(path.join(dir, f), 'utf-8');
      const { meta, body } = parseFrontmatter(content);

      agents[name] = {
        description: meta.description || name,
        prompt: body,
        model: (meta.model as AgentDef['model']) || undefined,
        tools: meta.tools ? meta.tools.split(',').map(s => s.trim()) : undefined,
        maxTurns: meta['max-turns'] ? parseInt(meta['max-turns'], 10) : undefined,
      };
    }
  }

  return agents;
}
