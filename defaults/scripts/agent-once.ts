#!/usr/bin/env bun
/**
 * Runs one agent turn using the same stack as the UI: streamChat() + getMcpConfig(uid).
 *
 * Usage (from repo root):
 *   bun --env-file=.env scripts/agent-once.ts "your prompt"
 *   bun --env-file=.env scripts/agent-once.ts --uid some-user-id "prompt"
 *
 * Requires ANTHROPIC_API_KEY (Claude Agent SDK). MCP env vars (e.g. SLACK_BOT_TOKEN) must be set.
 */
import { streamChat } from '../src/server/claude.ts';
import { getMcpConfig } from '../src/server/mcp.ts';

const argv = process.argv.slice(2);
let uid = 'cli-smoke';
if (argv[0] === '--uid') {
  uid = argv[1] ?? uid;
  argv.splice(0, 2);
}
const prompt =
  argv.join(' ').trim() ||
  'Call mcp-slack-use tool get_slack_channels with limit=2 only. Output the JSON ok field and first channel name, nothing else.';

if (!process.env.ANTHROPIC_API_KEY?.trim()) {
  console.error('Missing ANTHROPIC_API_KEY — cannot run Claude Agent SDK.');
  process.exit(1);
}

const mcpServers = getMcpConfig(uid);
console.error('[agent-once] uid=%s mcps=%s', uid, Object.keys(mcpServers).join(', ') || '(none)');
console.error('[agent-once] prompt:', prompt.slice(0, 120) + (prompt.length > 120 ? '…' : ''));

// Match UI when auto-approve is on: otherwise MCP tools stall waiting for permission.
for await (const ev of streamChat({
  prompt,
  uid,
  mcpServers,
  onPermissionRequest: async () => ({ allow: true }),
})) {
  switch (ev.type) {
    case 'text_delta':
      process.stdout.write(ev.text);
      break;
    case 'tool_use':
      console.error('\n[tool_use]', ev.tool, JSON.stringify(ev.input).slice(0, 300));
      break;
    case 'tool_result':
      console.error(
        '\n[tool_result]',
        ev.output.length > 800 ? ev.output.slice(0, 800) + '…' : ev.output,
      );
      break;
    case 'permission_request':
      console.error('\n[permission]', ev.tool, ev.id);
      break;
    case 'error':
      console.error('\n[error]', ev.message);
      break;
    case 'done':
      console.error('\n[done] sessionId=%s', ev.sessionId);
      break;
    default:
      break;
  }
}
console.error('');
process.stdout.write('\n');
