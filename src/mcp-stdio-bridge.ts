#!/usr/bin/env bun
// stdio↔HTTP bridge for MCP (Streamable HTTP transport, maintains session ID)
// Env: SHRAGA_URL + SHRAGA_API_KEY (preferred), or generic MCP_URL + MCP_API_KEY, or legacy UNCLAW_*
//      MCP_EXTRA_HEADERS — optional JSON object of extra headers sent with every request,
//      for servers that need a second credential beyond the bearer token (e.g. an
//      upstream app behind a proxy that gates its own admin ops on its own header).
const baseUrl = (process.env.SHRAGA_URL || process.env.MCP_URL || process.env.UNCLAW_URL || 'http://localhost:3033').replace(/\/$/, '');
const mcpPath = process.env.SHRAGA_MCP_PATH || process.env.MCP_PATH || '/mcp';
const apiKey = process.env.SHRAGA_API_KEY || process.env.MCP_API_KEY || process.env.UNCLAW_API_KEY;
if (!apiKey) { console.error('[mcp-bridge] SHRAGA_API_KEY (or MCP_API_KEY/UNCLAW_API_KEY) is required'); process.exit(1); }

let extraHeaders: Record<string, string> = {};
if (process.env.MCP_EXTRA_HEADERS) {
  try {
    const parsed = JSON.parse(process.env.MCP_EXTRA_HEADERS);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('must be a JSON object');
    extraHeaders = Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]));
  } catch (e: any) {
    // Fail loudly: silently dropping a credential header would surface far away as a 403.
    console.error(`[mcp-bridge] MCP_EXTRA_HEADERS is not a valid JSON object: ${e.message}`);
    process.exit(1);
  }
}

let sessionId: string | null = null;

async function sendMessage(message: any): Promise<void> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
    'Accept': 'application/json, text/event-stream',
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  Object.assign(headers, extraHeaders);

  const res = await fetch(`${baseUrl}${mcpPath}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(message),
  });

  // Capture session ID from server on initialize
  const newSession = res.headers.get('mcp-session-id');
  if (newSession) sessionId = newSession;

  if (res.status === 204) return;

  const contentType = res.headers.get('content-type') || '';

  if (contentType.includes('text/event-stream')) {
    // SSE: parse and forward each data line
    const text = await res.text();
    for (const line of text.split('\n')) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6).trim();
        if (data && data !== '[DONE]') {
          process.stdout.write(data + '\n');
        }
      }
    }
  } else {
    const body = await res.text();
    if (body) process.stdout.write(body + '\n');
  }
}

import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin, terminal: false });
let buffer = '';

rl.on('line', async (line) => {
  buffer += line;
  let message: any;
  try { message = JSON.parse(buffer); } catch { return; }
  buffer = '';

  try {
    await sendMessage(message);
  } catch (e: any) {
    const err = {
      jsonrpc: '2.0',
      id: message?.id ?? null,
      error: { code: -32603, message: `Bridge error: ${e.message}` },
    };
    process.stdout.write(JSON.stringify(err) + '\n');
  }
});
