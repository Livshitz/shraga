import { describe, test, expect } from 'bun:test';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { writeMcpConfigFile } from '../engine/mcp-config-file.ts';

// The point of this file is that MCP credentials never reach the CLI's argv (where `ps`, `/proc` and
// journald expose them). These assertions guard the two properties that buys us: the config really is
// on disk in the shape the CLI expects, and it is readable only by us.

describe('MCP config is handed over as a private file', () => {
  const config = {
    stripe: { type: 'stdio' as const, command: 'bun', args: ['x'], env: { STRIPE_SECRET_KEY: 'sk_live_TOPSECRET' } },
    pod: { type: 'http' as const, url: 'https://pod.example/mcp', headers: { Authorization: 'Bearer TOPSECRET' } },
  };

  test('writes the CLI-shaped JSON and cleans up after itself', () => {
    const { path, cleanup } = writeMcpConfigFile(config);

    // `{ mcpServers: … }` is the envelope `--mcp-config <file>` expects — a bare map is silently ignored.
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({ mcpServers: config });

    cleanup();
    expect(existsSync(path)).toBe(false);
  });

  test('the file is not readable by other users', () => {
    const { path, cleanup } = writeMcpConfigFile(config);
    try {
      // 0600 on the file, 0700 on its dir — group/other must have nothing.
      expect(statSync(path).mode & 0o077).toBe(0);
      expect(statSync(path.replace(/\/[^/]+$/, '')).mode & 0o077).toBe(0);
    } finally {
      cleanup();
    }
  });

  test('concurrent sessions never share a path', () => {
    const a = writeMcpConfigFile(config);
    const b = writeMcpConfigFile(config);
    try {
      expect(a.path).not.toBe(b.path);
    } finally {
      a.cleanup();
      b.cleanup();
    }
  });

  test('cleanup is safe to call twice', () => {
    const { cleanup } = writeMcpConfigFile(config);
    cleanup();
    expect(() => cleanup()).not.toThrow();
  });
});
