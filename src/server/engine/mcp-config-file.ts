import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { McpConfig } from '../mcp.ts';

/**
 * Hands the MCP config to the Claude Code CLI through a private FILE instead of its argv.
 *
 * WHY: the SDK serialises `options.mcpServers` straight onto the command line
 * (`--mcp-config '{"mcpServers":{…}}'`), and an MCP server's `env` block is where every vendor
 * credential lives. On the Circles box that meant the Stripe live key, a GitHub PAT with destructive
 * writes, two Firebase service-account private keys, the prod Postgres password + bastion SSH key and
 * the app-store signing keys were all readable by ANY local process via `ps` / `/proc/<pid>/cmdline`,
 * and were echoed verbatim into journald (so into anything that ships logs). Argv is not a secret
 * channel — a file we own with 0600 is.
 *
 * HOW: the CLI's `--mcp-config` takes either inline JSON or a path, so we write the same JSON to a
 * 0600 file inside a 0700 temp dir and pass the path via the SDK's `extraArgs` escape hatch. The
 * caller must NOT also set `options.mcpServers`, or the SDK appends a second `--mcp-config` with the
 * secrets back in argv. Safe here because shraga only ships `stdio` + `http` servers; an in-process
 * `sdk` server would have to stay on `options.mcpServers` (it holds no secrets — it's a live object).
 */
export function writeMcpConfigFile(mcpServers: McpConfig): { path: string; cleanup: () => void } {
  // mkdtemp gives us a 0700 dir with an unguessable name, so the file is unreachable even in the
  // window before the mode is applied, and two concurrent sessions can never collide.
  const dir = mkdtempSync(path.join(tmpdir(), 'shraga-mcp-'));
  const file = path.join(dir, 'mcp-config.json');
  writeFileSync(file, JSON.stringify({ mcpServers }), { mode: 0o600 });
  return {
    path: file,
    // Best-effort: a leaked temp dir is a much smaller problem than a crash on teardown, and the
    // 0700/0600 modes mean a leftover file is still unreadable by other users.
    cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* nothing to do */ } },
  };
}
