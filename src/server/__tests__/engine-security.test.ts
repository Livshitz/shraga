// The spawn config the REAL ClaudeCodeEngine hands the SDK, with only `query` stubbed (snapshot + delegate:
// mock.module is process-global). Flag OFF must be byte-for-byte today's config — the snapshot below was recorded
// against the engine BEFORE enforcement existed (07182f7) and must never need updating for an enforcement change.
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const realSdk = { ...(await import('@anthropic-ai/claude-agent-sdk')) };
let active = false;
const captured: { options: any; mcpFile?: any }[] = [];

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  ...realSdk,
  query: (args: any) => {
    if (!active) return (realSdk.query as any)(args);
    const o = args.options;
    const file = o.extraArgs?.['mcp-config'];
    captured.push({ options: o, mcpFile: file ? JSON.parse(readFileSync(file, 'utf8')) : undefined });
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'cc-sec', model: 'claude-haiku-4-5', apiKeySource: 'ANTHROPIC_API_KEY', mcp_servers: [] };
      yield { type: 'result', subtype: 'success', session_id: 'cc-sec', num_turns: 1, result: 'ok', usage: {} };
    })();
  },
}));

const { ClaudeCodeEngine } = await import('../engine/claude-code.ts');

const SCRUB = ['SECURITY_ENFORCE', 'AGENT_SHELL_TIMEOUT_MS', 'AGENT_SHELL_MAX_TIMEOUT_MS', 'BASH_DEFAULT_TIMEOUT_MS', 'BASH_MAX_TIMEOUT_MS', 'ENABLE_CLAUDEAI_MCP_SERVERS'];
const saved: Record<string, string | undefined> = {};
beforeAll(() => { active = true; for (const k of SCRUB) { saved[k] = process.env[k]; delete process.env[k]; } });
afterAll(() => { active = false; for (const k of SCRUB) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const MCPS = {
  'mcp-notion': { type: 'stdio', command: 'notion', args: [] },
  'mcp-slack-use': { type: 'stdio', command: 'slack', args: [] },
} as any;

export async function spawnConfig(extra: Record<string, unknown> = {}) {
  captured.length = 0;
  const events: any[] = [];
  for await (const ev of new ClaudeCodeEngine().stream({
    prompt: 'hi', conversation: [], contextBlock: '', sessionId: 'eng-sec-fixed', uid: 'u-sec', userEmail: 'sec@x.test',
    mcpServers: MCPS, abortController: new AbortController(), onPermissionRequest: async () => ({ allow: true }),
    directives: {}, config: { allowedTools: ['Read', 'Edit', 'Bash', 'WebSearch', 'Glob', 'LS'], permissionMode: 'acceptEdits', model: 'claude-sonnet-5' } as any,
    ...extra,
  } as any)) events.push(ev);
  expect(captured).toHaveLength(1);
  return { ...captured[0], events };
}

/** Machine-independent shape of the options: functions/paths masked, env as a diff against process.env. */
async function shape(c: { options: any; mcpFile?: any }) {
  const o = c.options, env = o.env as Record<string, string>;
  const injected = Object.fromEntries(Object.keys(env).filter(k => env[k] !== process.env[k]).sort()
    .map(k => [k, k === 'INTERNAL_API_TOKEN' ? `<signed:${env[k].split(':').slice(1).join(':')}>` : env[k]]));
  const dropped = Object.keys(process.env).filter(k => process.env[k] !== undefined && !(k in env)).sort();
  const canUse = async (tool: string, input: Record<string, unknown>) => (await o.canUseTool(tool, input)).behavior;
  return {
    keys: Object.keys(o).sort(),
    tools: o.tools, allowedTools: o.allowedTools, disallowedTools: o.disallowedTools, permissionMode: o.permissionMode,
    settingSources: o.settingSources, maxTurns: o.maxTurns, includePartialMessages: o.includePartialMessages, model: o.model,
    mcpServers: o.mcpServers, mcpFileServers: c.mcpFile ? Object.keys(c.mcpFile.mcpServers ?? c.mcpFile).sort() : undefined,
    extraArgKeys: Object.keys(o.extraArgs ?? {}),
    hooks: Object.fromEntries(Object.entries(o.hooks).map(([ev, ms]: any) => [ev, ms.map((m: any) => ({ matcher: m.matcher, hooks: m.hooks.length }))])),
    systemPromptSha: createHash('sha256').update(o.systemPrompt).digest('hex').slice(0, 16),
    envInjected: injected, envDropped: dropped,
    canUseTool: {
      read: await canUse('Read', { file_path: 'a.txt' }), readEnv: await canUse('Read', { file_path: '.env' }),
      bash: await canUse('Bash', { command: 'ls' }), bashPrintenv: await canUse('Bash', { command: 'printenv' }),
      mcp: await canUse('mcp__mcp-notion__get_notion_search', {}), write: await canUse('Write', { file_path: 'x.md' }),
    },
  };
}

describe('flag OFF: spawn config is today\'s', () => {
  test('matches the pre-enforcement snapshot', async () => {
    expect(await shape(await spawnConfig())).toMatchSnapshot();
  });
});
