import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { json } from 'itty-router';
import { RouterWrapper, captureMcpProgress } from 'edge.libx.js/build/main.js';
import type { Application, Request, Response } from 'express';

import { listWorkspaceTree, readWorkspaceFile, safeResolve, searchWorkspace } from './workspace.ts';
import { listSkills, getSkill, saveSkill } from './skills.ts';
import { getAllSessions, loadConversation, isSessionLocked } from './sessions.ts';
import * as scheduler from './scheduler/index.ts';
import { getAgentConfig } from './claude.ts';
import { validateApiKey } from './api-keys.ts';
import { verifyMcpToken } from './auth.ts';
import { makeProgressEmitter } from './mcp-progress.ts';
import { lookupIdempotent, rememberIdempotent } from './idempotency.ts';
import type { WsEvent } from './claude.ts';

export type RunChatTurnResult =
  | { status: 'busy' }
  | { sessionId: string; text: string; blocks: unknown[] }
  | { sessionId: string; error: string };

export type RunChatTurn = (
  opts: {
    prompt: string;
    sessionId?: string;
    uid: string;
    userEmail: string;
    userName?: string;
    abortController?: AbortController;
    context?: Record<string, string>;
  },
  hooks?: { onEvent?: (ev: WsEvent) => void },
) => Promise<RunChatTurnResult>;

export interface McpServerDeps {
  runChatTurn: RunChatTurn;
}

// Per-request caller identity, set by the /mcp Express handler before forwarding to MCP tool handlers.
// Safe because Node is single-threaded and the handler awaits the full MCP response.
let currentCaller: { uid: string; email: string } | null = null;

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function str(v: unknown): string | undefined {
  if (v === undefined || v === null || String(v) === '') return undefined;
  return String(v);
}

export function createShragaMcp(deps: McpServerDeps) {
  const base = RouterWrapper.getNew('', {
    origin: '*',
    allowMethods: ['GET', 'POST', 'PUT', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
  });
  const { router } = base;
  const allTools = process.env.MCP_ALL_TOOLS === 'true';

  // ── Sessions, Workspace, Skills, Schedules ──────────────────────────────
  // Disabled by default — set MCP_ALL_TOOLS=true to expose (the agent can do everything via chat)

  if (allTools) {

  base.describeMCP('/sessions', 'GET', {
    description: 'List conversations. Returns session metadata (id, title, user, timestamps, status). Use limit/offset for pagination.',
    params: {
      limit: { description: 'Max results (default 50)', type: 'string' },
      offset: { description: 'Skip N results', type: 'string' },
    },
    annotations: { readOnlyHint: true },
  });
  router.get('/sessions', async (req: any) => {
    try {
      const limit = parseInt(str(req.query.limit) ?? '50', 10);
      const offset = parseInt(str(req.query.offset) ?? '0', 10);
      const sorted = [...getAllSessions()].sort((a, b) => (b.lastModified ?? b.createdAt) - (a.lastModified ?? a.createdAt));
      const page = sorted.slice(offset, offset + limit);
      return json({ sessions: page, total: sorted.length });
    } catch (e) { return json({ error: errMessage(e) }, { status: 500 }); }
  });

  base.describeMCP('/sessions/messages', 'GET', {
    description: 'Read conversation messages for a session. Returns structured blocks (text, tool_use, tool_result).',
    params: {
      sessionId: { description: 'Session ID (required)', type: 'string', required: true },
      limit: { description: 'Max messages (default 50, from end)', type: 'string' },
    },
    annotations: { readOnlyHint: true },
  });
  router.get('/sessions/messages', async (req: any) => {
    try {
      const sid = str(req.query.sessionId);
      if (!sid) return json({ error: 'sessionId required' }, { status: 400 });
      const messages = loadConversation(sid);
      const limit = parseInt(str(req.query.limit) ?? '50', 10);
      const sliced = messages.slice(-limit);
      return json({ sessionId: sid, messages: sliced, total: messages.length });
    } catch (e) { return json({ error: errMessage(e) }, { status: 500 }); }
  });

  // ── Workspace ────────────────────────────────────────────────────────────

  base.describeMCP('/workspace', 'GET', {
    description: 'List workspace file tree. Returns paths, types, sizes, and one-line summaries.',
    annotations: { readOnlyHint: true },
  });
  router.get('/workspace', async () => {
    try {
      return json({ entries: listWorkspaceTree() });
    } catch (e) { return json({ error: errMessage(e) }, { status: 500 }); }
  });

  base.describeMCP('/workspace/file', 'GET', {
    description: 'Read a workspace file by relative path. Returns content as text.',
    params: {
      path: { description: 'Relative path within workspace (required)', type: 'string', required: true },
    },
    annotations: { readOnlyHint: true },
  });
  router.get('/workspace/file', async (req: any) => {
    try {
      const rel = str(req.query.path);
      if (!rel) return json({ error: 'path required' }, { status: 400 });
      const result = readWorkspaceFile(rel);
      if (!result) return json({ error: 'Not found' }, { status: 404 });
      return json(result);
    } catch (e) { return json({ error: errMessage(e) }, { status: 500 }); }
  });

  base.describeMCP('/workspace/file', 'PUT', {
    description: 'Write or update a workspace file. Creates parent directories as needed.',
    params: {
      body: { description: '{ path: "relative/path.md", content: "file content" }', type: 'object' },
    },
    annotations: { destructiveHint: false },
  });
  router.put('/workspace/file', async (req: any) => {
    try {
      const body = await req.json();
      const { path: rel, content } = body as { path?: string; content?: string };
      if (!rel || content === undefined) return json({ error: 'path and content required' }, { status: 400 });
      const resolved = safeResolve(rel);
      if (!resolved) return json({ error: 'Invalid path' }, { status: 400 });
      mkdirSync(dirname(resolved), { recursive: true });
      writeFileSync(resolved, content);
      return json({ ok: true, path: rel });
    } catch (e) { return json({ error: errMessage(e) }, { status: 500 }); }
  });

  base.describeMCP('/workspace/search', 'GET', {
    description: 'Search workspace files for a text query. Returns matching file paths, line numbers, and snippets.',
    params: {
      query: { description: 'Search text (case-insensitive, required)', type: 'string', required: true },
      maxResults: { description: 'Max matches (default 50)', type: 'string' },
    },
    annotations: { readOnlyHint: true },
  });
  router.get('/workspace/search', async (req: any) => {
    try {
      const query = str(req.query.query);
      if (!query) return json({ error: 'query required' }, { status: 400 });
      const max = parseInt(str(req.query.maxResults) ?? '50', 10);
      const matches = searchWorkspace(query, max);
      return json({ query, matches, total: matches.length });
    } catch (e) { return json({ error: errMessage(e) }, { status: 500 }); }
  });

  // ── Skills ───────────────────────────────────────────────────────────────

  base.describeMCP('/skills', 'GET', {
    description: 'List available agent skills (markdown prompt templates). Returns names and metadata.',
    annotations: { readOnlyHint: true },
  });
  router.get('/skills', async () => {
    try {
      const names = listSkills();
      const skills = names.map(name => {
        const s = getSkill(name);
        return s ? { name: s.name, builtin: s.builtin, meta: s.meta } : { name };
      });
      return json({ skills });
    } catch (e) { return json({ error: errMessage(e) }, { status: 500 }); }
  });

  base.describeMCP('/skills/read', 'GET', {
    description: 'Read full content of a skill by name.',
    params: {
      name: { description: 'Skill name (required)', type: 'string', required: true },
    },
    annotations: { readOnlyHint: true },
  });
  router.get('/skills/read', async (req: any) => {
    try {
      const name = str(req.query.name);
      if (!name) return json({ error: 'name required' }, { status: 400 });
      const skill = getSkill(name);
      if (!skill) return json({ error: 'Skill not found' }, { status: 404 });
      return json(skill);
    } catch (e) { return json({ error: errMessage(e) }, { status: 500 }); }
  });

  base.describeMCP('/skills/write', 'PUT', {
    description: 'Create or update a skill. Cannot modify built-in skills.',
    params: {
      body: { description: '{ name: "skill-name", content: "markdown content" }', type: 'object' },
    },
    annotations: { destructiveHint: false },
  });
  router.put('/skills/write', async (req: any) => {
    try {
      const body = await req.json();
      const { name, content } = body as { name?: string; content?: string };
      if (!name || !content) return json({ error: 'name and content required' }, { status: 400 });
      saveSkill(name, content);
      return json({ ok: true, name });
    } catch (e) { return json({ error: errMessage(e) }, { status: 500 }); }
  });

  // ── Schedules ────────────────────────────────────────────────────────────

  base.describeMCP('/schedules', 'GET', {
    description: 'List scheduled jobs. Returns schedule definitions with trigger, task, status, and run history.',
    annotations: { readOnlyHint: true },
  });
  router.get('/schedules', async () => {
    try {
      const schedules = scheduler.listSchedules();
      return json({ schedules });
    } catch (e) { return json({ error: errMessage(e) }, { status: 500 }); }
  });

  base.describeMCP('/schedules/run', 'POST', {
    description: 'Trigger an immediate run of a schedule by ID.',
    params: {
      body: { description: '{ id: "schedule-id" }', type: 'object' },
    },
    annotations: { destructiveHint: false },
  });
  router.post('/schedules/run', async (req: any) => {
    try {
      const body = await req.json();
      const { id } = body as { id?: string };
      if (!id) return json({ error: 'id required' }, { status: 400 });
      const schedule = scheduler.getSchedule(id);
      if (!schedule) return json({ error: 'Schedule not found' }, { status: 404 });
      scheduler.runNow(id);
      return json({ ok: true, id });
    } catch (e) { return json({ error: errMessage(e) }, { status: 500 }); }
  });

  } // end if (allTools)

  // ── Chat ─────────────────────────────────────────────────────────────────

  base.describeMCP('/chat', 'POST', {
    description: 'Talk to the Shraga agent — like a conversation. Send a prompt, get a full response. The agent has access to any configured MCP tools, workspace files, and skills. To continue a conversation, pass the sessionId from a previous response. Without sessionId, starts a new conversation. For work expected to exceed ~60s (multi-tool, long reads, reports), pass sync: false — it returns { sessionId, status: "accepted" } immediately. Then poll the UI or get_sessions for that sessionId. Do NOT re-submit the prompt (via /api/chat or a second post_chat) after a client-side timeout — the turn is already running; that only creates duplicate sessions.',
    params: {
      body: { description: '{ prompt: "your message", sessionId?: "continue a conversation", sync?: "wait for response (default true) — set false to fire-and-forget and get the sessionId back immediately for long tasks", clientRequestId?: "idempotency key — a retry with the same id within 15min reuses the same session (returns status: duplicate) instead of creating a new one" }', type: 'object' },
    },
    annotations: { destructiveHint: false },
  });
  router.post('/chat', async (req: any) => {
    try {
      const body = await req.json();
      const { prompt, sessionId, sync = true, clientRequestId } = body as { prompt?: string; sessionId?: string; sync?: boolean; clientRequestId?: string };
      if (!prompt) return json({ error: 'prompt required' }, { status: 400 });

      const caller = currentCaller || { uid: 'agent-internal', email: 'agent@internal' };
      const idemKey = clientRequestId || str(req.headers?.get?.('idempotency-key'));

      // Idempotency: a retried submit with the same key reuses the session that first
      // handled it (within TTL) instead of spawning a duplicate.
      if (idemKey) {
        const existing = lookupIdempotent(caller.uid, idemKey);
        if (existing) return json({ sessionId: existing, status: 'duplicate' });
      }

      // Pre-allocate the session id so async callers get a real id back immediately
      // (parity with POST /api/chat). Lets timeout-prone MCP clients recover/continue
      // instead of double-submitting and creating duplicate sessions.
      const sid = sessionId || `api-${crypto.randomUUID()}`;
      if (idemKey) rememberIdempotent(caller.uid, idemKey, sid);
      const turn = { prompt, sessionId: sid, uid: caller.uid, userEmail: caller.email, context: { source: 'mcp', user: caller.email } };

      if (sync === false) {
        // Reject a duplicate before responding 'accepted' (lock is acquired inside the turn).
        if (sessionId && isSessionLocked(sid)) {
          return json({ error: 'Session is already processing a request' }, { status: 409 });
        }
        // Fire-and-forget: kick off the turn, return the real session id immediately.
        void deps.runChatTurn(turn);
        return json({ sessionId: sid, status: 'accepted' });
      }

      // Capture the progress channel here (within the tools/call async context) and stream
      // agent events as notifications/progress. No-op unless the client requested progress.
      const result = await deps.runChatTurn(turn, { onEvent: makeProgressEmitter(captureMcpProgress()) });
      if ('status' in result) return json({ error: 'Session is already processing a request' }, { status: 409 });
      if ('error' in result) return json({ error: result.error, sessionId: result.sessionId }, { status: 500 });
      return json({ sessionId: result.sessionId, text: result.text, blocks: result.blocks });
    } catch (e) { return json({ error: errMessage(e) }, { status: 500 }); }
  });

  // ── Config ───────────────────────────────────────────────────────────────

  base.describeMCP('/config', 'GET', {
    description: 'Get agent configuration (model, defaults, etc.).',
    annotations: { readOnlyHint: true },
  });
  router.get('/config', async () => {
    try {
      return json(getAgentConfig());
    } catch (e) { return json({ error: errMessage(e) }, { status: 500 }); }
  });

  // ── Finalize ─────────────────────────────────────────────────────────────

  base.catchNotFound();

  const mcp = base.asMCP({
    name: 'shraga',
    version: '0.1.0',
    instructions: [
      'Shraga agent MCP — talk to the agent via post_chat.',
      'The agent has access to the workspace, skills, sessions, schedules, and any configured MCP tools.',
      'Send a prompt to start a new conversation; pass sessionId to continue one.',
      'Auth: pass API key as Bearer token.',
    ].join(' '),
  });

  // Augment with skill resource — the shipped MCP guide, which is also seeded into data/skills/.
  const skillPath = resolve(import.meta.dirname, '../../defaults/skills/mcp-server.md');
  augmentWithSkillResource(mcp, skillPath);

  return { mcp, base };
}

function augmentWithSkillResource(adapter: any, skillPath: string) {
  const canonicalUri = 'skill://shraga/workflow';
  const orig = adapter.handleJsonRpc.bind(adapter);

  adapter.handleJsonRpc = async (message: any, sendNotification?: (n: unknown) => void): Promise<unknown> => {
    const { method, id, params } = message;

    if (method === 'resources/list') {
      return {
        jsonrpc: '2.0', id,
        result: {
          resources: [{
            uri: canonicalUri,
            name: 'shraga-workflow',
            description: 'Shraga agent MCP workflow guide',
            mimeType: 'text/markdown',
          }],
        },
      };
    }

    if (method === 'resources/read') {
      const uri = params?.uri;
      if (uri !== canonicalUri) return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown resource: ${uri}` } };
      if (!existsSync(skillPath)) return { jsonrpc: '2.0', id, error: { code: -32603, message: 'Skill file not found' } };
      return {
        jsonrpc: '2.0', id,
        result: { contents: [{ uri: canonicalUri, mimeType: 'text/markdown', text: readFileSync(skillPath, 'utf-8') }] },
      };
    }

    const res = await orig(message, sendNotification) as any;
    if (method === 'initialize' && res?.result?.capabilities) {
      res.result.capabilities.resources = { subscribe: false, ...(typeof res.result.capabilities.resources === 'object' ? res.result.capabilities.resources : {}) };
    }
    return res;
  };
}

/** Mount the MCP server on an Express app at /mcp. */
export function mountMcpServer(app: Application, deps: McpServerDeps) {
  const { mcp } = createShragaMcp(deps);

  app.all('/mcp', async (req: Request, res: Response) => {
    // Auth: require API key or internal token
    const authHeader = req.headers.authorization?.replace('Bearer ', '');
    const internalToken = req.headers['x-internal-token'] as string | undefined;

    let authed = false;
    let caller: { uid: string; email: string } | null = null;
    if (internalToken && process.env.INTERNAL_API_TOKEN) {
      const secret = process.env.INTERNAL_API_TOKEN;
      authed = internalToken.length === secret.length &&
        timingSafeEqual(Buffer.from(internalToken), Buffer.from(secret));
    }
    if (!authed && authHeader?.startsWith('uck_')) {
      caller = validateApiKey(authHeader);
      authed = !!caller;
    }
    if (!authed && authHeader?.startsWith('mcp_')) {
      const id = verifyMcpToken(authHeader);
      if (id && id.kind === 'access') { caller = { uid: id.uid, email: id.email }; authed = true; }
    }
    if (!authed) {
      // Point MCP clients (claude.ai et al.) at our OAuth discovery so they can run the auth handshake.
      const proto = (req.get('x-forwarded-proto') || req.protocol).split(',')[0];
      const base = `${proto}://${req.get('host')}`;
      res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`);
      return void res.status(401).json({ error: 'Unauthorized — provide API key or complete OAuth' });
    }
    currentCaller = caller;

    // Bridge Express Request → Web API Request → MCPAdapter.httpHandler → Express Response.
    const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
    const webReq = new globalThis.Request(url, {
      method: req.method,
      headers: Object.fromEntries(
        Object.entries(req.headers)
          .filter(([, v]) => typeof v === 'string')
          .map(([k, v]) => [k, v as string]),
      ),
      ...(req.method !== 'GET' && req.method !== 'HEAD' ? { body: JSON.stringify(req.body) } : {}),
    });

    try {
      const webRes: globalThis.Response = await mcp.httpHandler(webReq);
      res.status(webRes.status);
      webRes.headers.forEach((val, key) => res.setHeader(key, val));
      // For a Streamable-HTTP SSE response (progress streaming), pipe the body so frames flush
      // as the agent emits them. currentCaller stays set until the pipe completes (the tool
      // handler reads it inside the stream). Otherwise buffer the single JSON response.
      if (webRes.body && (webRes.headers.get('content-type') || '').includes('text/event-stream')) {
        (res as any).flushHeaders?.();
        const reader = webRes.body.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
          (res as any).flush?.();
        }
        res.end();
      } else {
        res.send(await webRes.text());
      }
    } catch (e) {
      console.error('[mcp-server] handler error:', e);
      if (!res.headersSent) res.status(500).json({ error: 'MCP handler error' });
      else res.end();
    } finally {
      currentCaller = null;
    }
  });

  console.log('[mcp-server] MCP endpoint mounted at /mcp');
}
