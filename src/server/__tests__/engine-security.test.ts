// The spawn config the REAL ClaudeCodeEngine hands the SDK, with only `query` stubbed (snapshot + delegate:
// mock.module is process-global). Flag OFF must be byte-for-byte today's config — the snapshot below was recorded
// against the engine BEFORE enforcement existed (07182f7) and must never need updating for an enforcement change.
// One deliberate, flag-INDEPENDENT baseline change since: the tamper-protection PreToolUse hook
// (`Write|Edit|MultiEdit|NotebookEdit` → deny writes to server-owned data; normal workspace writes unchanged).
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

describe('flag ON: the engine applies the effective profile', () => {
  const { mkdtempSync, rmSync } = require('node:fs') as typeof import('node:fs');
  const { tmpdir } = require('node:os') as typeof import('node:os');
  const path = require('node:path') as typeof import('node:path');
  const { SecurityRuntime } = require('../security/runtime.ts') as typeof import('../security/runtime.ts');
  const { TurnGuard } = require('../security/enforce.ts') as typeof import('../security/enforce.ts');
  const { fromAuthUser, fromSlack } = require('../security/principal.ts') as typeof import('../security/principal.ts');

  const OWNER = 'owner@engine-sec.test';
  const SECRETS = { OWNERS: OWNER, SLACK_SIGNING_SECRET: 'sss', SLACK_CLIENT_SECRET: 'ccc', DATA_SYNC_WEBHOOK_SECRET: 'www', FIREBASE_SERVICE_ACCOUNT_JSON_PROD: '{"k":1}' };
  const prev: Record<string, string | undefined> = {};
  let root: string;
  let rt: InstanceType<typeof SecurityRuntime>;
  const floors = new Map<string, number>();

  beforeAll(() => {
    for (const [k, v] of Object.entries({ ...SECRETS, GITHUB_TOKEN: 'ghp_probe' })) { prev[k] = process.env[k]; process.env[k] = v; }
    root = mkdtempSync(path.join(tmpdir(), 'engine-sec-'));
    rt = new SecurityRuntime({ policy: { path: path.join(root, 'security', 'policy.json'), whitelistPath: path.join(root, 'w.json'), watch: false }, audit: { dir: path.join(root, 'audit') }, notify: () => {}, log: { info() {}, warn() {}, error() {} } });
    const p = rt.policy.current;
    p.profiles.standard.mcps = ['mcp-notion'];
    p.bindings = [{ match: { kind: 'user', emailIn: ['member@engine-sec.test'] }, role: 'member' }, { match: { kind: 'slack', id: 'slack:UGUEST' }, role: 'guest' }];
    rt.policy.save(p);
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(root, { recursive: true, force: true });
  });

  function guardFor(principal: ReturnType<typeof fromAuthUser>, sessionId: string) {
    const r = rt.policy.resolve(principal);
    floors.set(sessionId, r.rank);
    return new TurnGuard({ runtime: rt, principal, sessionId, role: r.role, rank: r.rank, floorOf: (s) => floors.get(s), log: { log() {}, error() {} } });
  }
  const run = (principal: ReturnType<typeof fromAuthUser>, sessionId: string) =>
    spawnConfig({ sessionId, security: guardFor(principal, sessionId) });
  const deny = async (o: any, tool: string, input: Record<string, unknown> = {}) => (await o.canUseTool(tool, input)).behavior;
  const hookDecision = async (o: any, tool: string, input: Record<string, unknown> = {}) => {
    const r = await o.hooks.PreToolUse[0].hooks[0]({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: 't' }, 't', { signal: new AbortController().signal });
    return r.hookSpecificOutput?.permissionDecision ?? 'pass';
  };

  test('owner (full): all tools + MCPs, env = everything minus server secrets, scoped internal token, gate hook first', async () => {
    const { options: o, mcpFile } = await run(fromAuthUser({ uid: 'o', email: OWNER }), 'eng-on-owner');
    expect(o.tools).toEqual({ type: 'preset', preset: 'claude_code' });
    expect(o.allowedTools).toEqual(['Read', 'Edit', 'Bash', 'WebSearch', 'Glob', 'LS', 'ToolSearch']);
    expect(Object.keys(mcpFile.mcpServers ?? mcpFile).sort()).toEqual(['mcp-notion', 'mcp-slack-use']);
    expect(o.mcpServers).toBeUndefined();
    for (const k of Object.keys(SECRETS)) expect(o.env).not.toHaveProperty(k);
    expect(o.env.GITHUB_TOKEN).toBe('ghp_probe');
    expect(o.env.PATH).toBe(process.env.PATH);
    expect(o.env.INTERNAL_API_TOKEN).not.toBe(process.env.INTERNAL_API_TOKEN);
    expect(o.env.INTERNAL_API_TOKEN).toMatch(/^[0-9a-f]{64}\.\d+:u-sec:sec@x\.test$/); // scoped to the turn's uid/email (+ issued-at, for tokensValidAfter), never the raw secret
    expect(o.hooks.PreToolUse[0].matcher).toBeUndefined();
    expect(o.hooks.PreToolUse.slice(1).map((m: any) => m.matcher)).toEqual(['Bash', 'mcp__mcp-slack-use__post_slack_.*', 'mcp__mcp-firebase-(?:prod|lab)__get_db.*', 'Write|Edit|MultiEdit|NotebookEdit']);
    expect(await deny(o, 'Bash', { command: 'ls' })).toBe('allow');
  });

  test('member (standard + mcp-notion): tools availability, MCP filtered before the file, baseline env only', async () => {
    const { options: o, mcpFile } = await run(fromAuthUser({ uid: 'm', email: 'member@engine-sec.test' }), 'eng-on-member');
    expect(o.tools).toEqual(['Read', 'Glob', 'LS', 'WebSearch', 'ToolSearch']);
    expect(o.allowedTools).toEqual(['Read', 'WebSearch', 'Glob', 'LS', 'ToolSearch']);
    expect(Object.keys(mcpFile.mcpServers ?? mcpFile)).toEqual(['mcp-notion']);
    expect(o.env).not.toHaveProperty('GITHUB_TOKEN');
    expect(o.env).not.toHaveProperty('INTERNAL_API_TOKEN');
    for (const k of Object.keys(SECRETS)) expect(o.env).not.toHaveProperty(k);
    expect(o.env.SHRAGA_SESSION_ID).toBe('eng-on-member');
    expect(await deny(o, 'Bash', { command: 'ls' })).toBe('deny'); // onPermissionRequest: allow does NOT override
    expect(await deny(o, 'mcp__mcp-slack-use__post_slack_message')).toBe('deny');
    expect(await deny(o, 'mcp__mcp-notion__get_notion_search')).toBe('allow');
  });

  test('guest (reply-only): no built-ins, no MCP file, only the in-process escalate server', async () => {
    const { options: o, mcpFile } = await run(fromSlack('UGUEST', {}) as any, 'eng-on-guest');
    expect(o.tools).toEqual(['ToolSearch']);
    expect(o.allowedTools).toEqual(['ToolSearch']);
    expect(mcpFile).toBeUndefined();
    expect(o.extraArgs).toBeUndefined();
    expect(Object.keys(o.mcpServers)).toEqual(['security']);
    expect(o.mcpServers.security.type).toBe('sdk');
    expect(await hookDecision(o, 'Read', { file_path: 'a' })).toBe('deny');
    expect(await hookDecision(o, 'mcp__security__escalate', { summary: 'x' })).toBe('pass');
  });

  test('taint mid-turn: a lower floor after spawn flips canUseTool AND the hook to deny for the running turn', async () => {
    const sid = 'eng-on-taint';
    const { options: o } = await run(fromAuthUser({ uid: 'o', email: OWNER }), sid);
    expect(await deny(o, 'Bash', { command: 'ls' })).toBe('allow');
    expect(await hookDecision(o, 'Bash', { command: 'ls' })).toBe('pass');
    floors.set(sid, 20); // a guest's message lands in the session while the turn runs
    expect(await deny(o, 'Bash', { command: 'ls' })).toBe('deny');
    expect(await hookDecision(o, 'Bash', { command: 'ls' })).toBe('deny');
    const recs = rt.audit.query({ limit: 50, type: 'tool.deny' }).items;
    expect(recs.find(r => r.sessionId === sid && r.target === 'Bash')).toMatchObject({ role: 'guest', principal: `user:${OWNER}` });
  });
});
