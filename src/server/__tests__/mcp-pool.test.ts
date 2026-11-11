import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// A minimal newline-JSON stdio MCP server: counts spawns in a file, echoes tool calls, emits progress.
const dir = mkdtempSync(path.join(tmpdir(), 'mcp-pool-'));
const spawns = path.join(dir, 'spawns.txt');
const fake = path.join(dir, 'fake.ts');
writeFileSync(fake, `
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(spawns)}, 'x');
let buf = '';
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (d) => {
  buf += d; let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (m.id === undefined) continue;
    if (m.method === 'initialize') out({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } });
    else if (m.method === 'tools/list') out({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] } });
    else if (m.method === 'tools/call') {
      const tok = m.params?._meta?.progressToken;
      if (tok !== undefined) out({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: tok, progress: 1 } });
      setTimeout(() => out({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'echo:' + JSON.stringify(m.params.arguments) }] } }), 20);
    } else out({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'nope' } });
  }
});
`);

process.env.DATA_DIR ??= dir;
process.env.SHRAGA_MCP_POOL_IDLE_MS = '300';

const pool = await import('../mcp-pool.ts');
const cfg = { fake: { command: process.execPath, args: ['run', fake] } } as any;
const keyOf = (c: any) => new URL(c.fake.url).pathname.split('/').pop()!;
const count = () => (existsSync(spawns) ? readFileSync(spawns, 'utf-8').length : 0);

afterAll(() => pool.stopMcpPool());

describe('mcp-pool', () => {
  test('rewrites stdio entries to loopback http, deterministically, leaving http/excluded ones alone', () => {
    const a = pool.poolMcpServers({ ...cfg, remote: { type: 'http', url: 'https://x/mcp' }, 'para-pty': { command: 'x' } } as any) as any;
    const b = pool.poolMcpServers(cfg) as any;
    expect(a.fake.type).toBe('http');
    expect(a.fake.url).toBe(b.fake.url);
    expect(a.remote.url).toBe('https://x/mcp');
    expect(a['para-pty'].command).toBe('x');
  });

  test('concurrent sessions share ONE child; tool calls are multiplexed with ids restored', async () => {
    const srv = pool.getPooledServer(keyOf(pool.poolMcpServers(cfg)))!;
    const res = await Promise.all([1, 2, 3].map((n) =>
      pool.handlePoolMessage(srv, { jsonrpc: '2.0', id: `c${n}`, method: 'tools/call', params: { name: 'echo', arguments: { n } } })));
    expect(res.map((r: any) => r.id)).toEqual(['c1', 'c2', 'c3']);
    expect(res[1].result.content[0].text).toBe('echo:{"n":2}');
    expect(count()).toBe(1);
  });

  test('initialize + tools/list come from cache without spawning; progress keeps the client token', async () => {
    const srv = pool.getPooledServer(keyOf(pool.poolMcpServers(cfg)))!;
    await new Promise((r) => setTimeout(r, 700)); // idle reaper
    expect(srv.running).toBe(false);
    const init = await pool.handlePoolMessage(srv, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const list = await pool.handlePoolMessage(srv, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    expect(init.result.serverInfo.name).toBe('fake');
    expect(list.result.tools[0].name).toBe('echo');
    expect(srv.running).toBe(false);
    expect(count()).toBe(1);

    const notes: any[] = [];
    const r = await pool.handlePoolMessage(srv, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: {}, _meta: { progressToken: 'tok-9' } } }, (m) => notes.push(m));
    expect(r.result).toBeDefined();
    expect(notes[0].params.progressToken).toBe('tok-9');
    expect(count()).toBe(2); // lazily respawned for the real call
  });

  test('pool can be switched off', () => {
    process.env.SHRAGA_MCP_POOL = '0';
    try { expect((pool.poolMcpServers(cfg) as any).fake.command).toBe(process.execPath); }
    finally { delete process.env.SHRAGA_MCP_POOL; }
  });
});
