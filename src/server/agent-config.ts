// Agent config READ path (shared across users), as its own leaf module.
//
// Why it isn't in claude.ts: the security runtime reads a flag from it (`allowUntrustedReplies`, see
// `mayReplyTo`), and claude.ts imports the runtime — plus the whole engine/skills/sessions graph. A leaf
// that only touches fs + paths keeps that dependency one-way and cheap. The WRITE path stays in claude.ts
// (it also has to tell data-sync, which pulls the Agent SDK).
import { existsSync, readFileSync } from 'node:fs';
import { dataPath } from './paths.ts';
import type { AgentSettings as AgentConfig } from './shraga-config.ts';

export const CONFIG_PATH = dataPath('agent-config.json');

export const DEFAULT_CONFIG: AgentConfig = {
  /** ToolSearch loads deferred MCP tools; without it, permission prompts / tool graph can block Meta Ads tools. */
  allowedTools: ['Read', 'Edit', 'Bash', 'WebSearch', 'Glob', 'LS', 'ToolSearch'],
  permissionMode: 'acceptEdits',
  maxTurns: 15,
  // Defaults are what a fresh self-hosted install runs before anyone touches the UI, so they favour
  // cost/latency over ceiling. Both are overridable per-deployment via agent-config.json and per-send
  // via directives — an operator who wants a bigger model sets it once; every operator pays for a default.
  model: 'claude-sonnet-5',
  effort: 'low',
  // `allowUntrustedReplies` is deliberately absent: undefined = off, so a fresh install never auto-replies
  // to an unverified sender, and an owner has to turn it on explicitly.
};

export function getAgentConfig(): AgentConfig {
  // agent-config.json (UI-writable, git-tracked) is the single source of truth for agent settings.
  let config = { ...DEFAULT_CONFIG };
  if (existsSync(CONFIG_PATH)) {
    try { Object.assign(config, JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))); } catch (e) { console.warn('[claude] failed to parse agent-config.json:', e); }
  }
  return config;
}
