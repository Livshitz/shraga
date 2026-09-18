#!/usr/bin/env bun
// stdio↔HTTP bridge for MCP (Streamable HTTP transport, maintains session ID)
// Env: SHRAGA_URL + SHRAGA_API_KEY (preferred), or generic MCP_URL + MCP_API_KEY, or legacy UNCLAW_*
//      MCP_EXTRA_HEADERS — optional JSON object of extra headers sent with every request,
//      for servers that need a second credential beyond the bearer token (e.g. an
//      upstream app behind a proxy that gates its own admin ops on its own header).
//      MCP_BRIDGE_TIMEOUT_MS — per-request bound for protocol calls (initialize, tools/list…), default 60s.
//      MCP_BRIDGE_TOOL_TIMEOUT_MS — bound for tools/call, default 30min (a sync post_chat turn has no
//      server-side wall clock). Without a bound, a frozen server hung the client forever on "connecting…".
const envMs = (v: string | undefined, fallback: number) => (Number(v) > 0 ? Number(v) : fallback);
const REQUEST_TIMEOUT_MS = envMs(process.env.MCP_BRIDGE_TIMEOUT_MS, 60_000);
const TOOL_TIMEOUT_MS = envMs(process.env.MCP_BRIDGE_TOOL_TIMEOUT_MS, 30 * 60_000);
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

  const limit = message?.method === 'tools/call' ? TOOL_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
  // The signal also bounds the body read below, not just the headers.
  const signal = AbortSignal.timeout(limit);
  let res: Response;
  let text: string;
  try {
    res = await fetch(`${baseUrl}${mcpPath}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(message),
      signal,
    });
    text = res.status === 204 ? '' : await res.text();
  } catch (e: any) {
    if (signal.aborted) throw new Error(`no response from ${baseUrl} for ${message?.method ?? 'message'} within ${limit}ms`);
    throw e;
  }

  // Capture session ID from server on initialize
  const newSession = res.headers.get('mcp-session-id');
  if (newSession) sessionId = newSession;

  if (res.status === 204) return;

  // A non-2xx (401 on a stale key, 404 on a wrong MCP_PATH, 502 from a proxy) has no JSON-RPC
  // body, so forwarding nothing left the client waiting on a reply that never came — it surfaced
  // as "connection timed out after 30000ms", which reads as an unreachable server rather than a
  // refused credential. Raising the HTTP status as a JSON-RPC error names the real cause. This
  // cost a full investigation on 2026-09-18 after a key rotation missed one config file.
  if (!res.ok && message?.id !== undefined && message?.id !== null) {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32603, message: `Bridge: ${baseUrl}${mcpPath} returned HTTP ${res.status} for ${message?.method ?? 'message'}${res.status === 401 ? ' — check MCP_API_KEY' : ''}` },
    }) + '\n');
    return;
  }

  const contentType = res.headers.get('content-type') || '';

  if (contentType.includes('text/event-stream')) {
    // SSE: parse and forward each data line
    for (const line of text.split('\n')) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6).trim();
        if (data && data !== '[DONE]') {
          process.stdout.write(data + '\n');
        }
      }
    }
  } else if (text) {
    process.stdout.write(text + '\n');
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
