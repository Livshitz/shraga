import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import type { Server } from 'node:http';
import express from 'express';

// Two concurrent /mcp callers must each run their turn as THEMSELVES. The old module-global
// `currentCaller` was overwritten by the second request and nulled by whichever finished first.
delete process.env.DATA_SYNC_ENABLE;
delete process.env.DATA_SYNC_REPO;

const { signMcpToken } = await import('../../auth.ts');
const { createApiKey } = await import('../../api-keys.ts');
const { mountMcpServer, currentMcpCaller } = await import('../../mcp-server.ts');

let server: Server;
let base: string;
const keyA = createApiKey('uid-mcp-a', 'a@mcp.test', 'a');
const keyB = createApiKey('uid-mcp-b', 'b@mcp.test', 'b');

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  mountMcpServer(app, {
    runChatTurn: async (opts) => {
      // Hold the turn open (a real macrotask boundary, like a long turn or the SSE pipe) so other requests
      // run start-to-finish inside this one, THEN re-read the caller: it must still be this request's.
      await new Promise(r => setTimeout(r, opts.prompt === 'slow' ? 300 : 20));
      const late = currentMcpCaller();
      const text = late?.principal.id === opts.principal.id
        ? `${opts.uid}|${opts.userEmail}|${opts.principal.id}`
        : `MISMATCH turn=${opts.principal.id} late=${late?.principal.id}`;
      return { sessionId: opts.sessionId!, text, blocks: [] };
    },
  });
  await new Promise<void>(r => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(() => server?.close());

async function chat(headers: Record<string, string>, prompt: string, sse = false): Promise<string> {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: sse ? 'application/json, text/event-stream' : 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'post_chat', arguments: { body: { prompt } }, ...(sse ? { _meta: { progressToken: 'p1' } } : {}) } }),
  });
  expect(res.status).toBe(200);
  const raw = await res.text();
  const msg = sse
    ? raw.split('\n').filter(l => l.startsWith('data:')).map(l => JSON.parse(l.slice(5))).find(m => m.result)
    : JSON.parse(raw);
  return JSON.parse(msg.result.content[0].text).text;
}

describe('/mcp caller isolation (AsyncLocalStorage)', () => {
  for (const sse of [false, true]) {
    test(`a burst of concurrent api-key callers each keep their own identity (${sse ? 'SSE pipe' : 'JSON'})`, async () => {
      // Fired together: with a shared global, a later request's auth overwrites the caller before an
      // earlier request's tool handler reads it (and the first to finish nulls it for the rest).
      const burst = [keyA, keyB, ...Array.from({ length: 8 }, (_, i) => createApiKey(`uid-mcp-${i}`, `u${i}@mcp.test`, 'burst'))];
      const got = await Promise.all(burst.map((k, i) => chat({ authorization: `Bearer ${k.key}` }, i % 2 ? 'fast' : 'slow', sse)));
      expect(got).toEqual(burst.map(k => `${k.uid}|${k.email}|apikey:${k.id}`));
    });
  }

  test('OAuth access token → user principal; legacy internal token → agent-internal as internal principal', async () => {
    const oauth = await chat({ authorization: `Bearer ${signMcpToken('uid-oauth', 'o@mcp.test')}` }, 'fast');
    expect(oauth).toBe('uid-oauth|o@mcp.test|user:o@mcp.test');
    const legacy = await chat({ 'x-internal-token': process.env.INTERNAL_API_TOKEN! }, 'fast');
    expect(legacy).toBe('agent-internal|agent@internal|internal:agent-internal');
  });

  test('no credential → 401', async () => {
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
  });
});
