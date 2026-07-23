import './env-resolve.ts'; // resolve named .env file (must be first — before any config read)
import './env-sanitize.ts'; // strip unresolved ${VAR} placeholders before any config is read

const SUPPRESSED_ERRORS = /NGHTTP2|h2 is not supported|socket disconnected before secure TLS/i;
process.on('uncaughtException', (err) => {
  if (SUPPRESSED_ERRORS.test(err.message ?? '')) return;
  console.error('[server] Uncaught exception (kept alive):', err.message ?? err);
});
process.on('unhandledRejection', (reason) => {
  const msg = (reason as Error)?.message ?? String(reason);
  if (SUPPRESSED_ERRORS.test(msg)) return;
  console.error('[server] Unhandled rejection (kept alive):', msg);
});
import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { requireAuth, verifyBearer, AUTH_PROVIDER, localLogin, addLocalUser, localUserCount } from './auth.ts';
import { getMcpConfig, getRawMcpConfig, getResolvedMcpConfig, getGlobalMcpConfig, saveMcpConfig, maskEnvValues, mergeWithOriginal, type McpConfig } from './mcp.ts';
import { streamChat, consumeStream, getAgentConfig, saveAgentConfig, getClaudeAuthSource, type AgentConfig, type PermissionHandler, type QuestionHandler, type QuestionAnswers, type AttachmentMeta, type WsEvent } from './claude.ts';
import { mountFeatures, registerFeature, resumeFeatureSession, collectFeatureFlags, collectSidecarRoutes } from './features.ts';
import { registerSpaCatchAll } from './spa-catchall.ts';
import { slackFeature } from './slack/feature.ts';
import { dataPath } from './paths.ts';
import { getAllSessions, getSession, getSessionHistory, upsertSession, appendMessage, saveConversation, loadConversation, setSessionDirectives, getAutoApprove, setAutoApprove, getSessionsByScheduleId, getSessionsVisibleTo, isSessionVisibleTo, setRunStatus, incrementRetryCount, resetRetryCount, getRunningSessions, getActiveLockCount, updateScheduledSessionStatus, setShuttingDown, backfillSessionVisibility, writePartial, readPartial, clearPartial, registerLivePartial, unregisterLivePartial, readLivePartial, acquireSessionLock, releaseSessionLock, replaceSessionLock, isSessionLocked, getSessionAbortController, forkSession, generateSessionTitle, type ConvBlock, type ConvMessage, type SessionMeta } from './sessions.ts';
import { setBroadcaster } from './session-bus.ts';
import * as scheduler from './scheduler/index.ts';
import { initPolls } from './polls.ts';
import { pushEnabled } from './push/push.ts';
import { upsertToken, removeToken } from './push/store.ts';
import { initPushTriggers, pushTurnDone, pushQuestion } from './push/triggers.ts';
import type { Schedule } from './scheduler/index.ts';
import { listSkills, listMcpCommands, getSkill, saveSkill, deleteSkill, duplicateSkill, renameSkill, getDefaultSkills, setDefaultSkills, resolveDefaultSkillsContent, purgeExpiredSkills, lintSkills } from './skills.ts';
import { listWorkspaceTree, listWorkspaceDir, readWorkspaceFile, safeResolve as resolveWorkspacePath, watchWorkspace, ensureDir as ensureWorkspaceDir } from './workspace.ts';
import { seedDefaults, getBuiltinSkillNames } from './seed.ts';
import { registerModuleRoutes, reconcileInstalledModules } from './modules/index.ts';
import { hydrateSlackUserToken } from './slack/oauth.ts';
import { registerMcpOAuthRoutes } from './mcp-oauth.ts';
import { registerEventRoutes } from './events/routes.ts';
import { registerWebhook } from './events/webhook.ts';
import { startEventDispatcher } from './events/dispatcher.ts';
import { seedOperators } from './contacts.ts';
import { dataSync } from './data-sync.ts';
import { mountMcpServer } from './mcp-server.ts';
import { lookupIdempotent, rememberIdempotent } from './idempotency.ts';
import { createApiKey, deleteApiKey, listApiKeys } from './api-keys.ts';
import { addUnread, markRead as markUnread, getUnreads } from './unread.ts';

import { loadShragaConfig, getPublicOrigin } from './shraga-config.ts';
import { startSidecars, stopSidecars } from './mcp-sidecar.ts';
import { syncVendorRepos } from './vendor-sync.ts';
import { initEngines, getAvailableEngines, getEngine } from './engine/index.ts';
import { statsSampler } from './stats.ts';
import { getAll as getAllContacts } from './contacts.ts';
import { artifactsRouter } from './artifacts/artifacts.routes.ts';
import { handleArtifactToolUse } from './artifacts/artifacts.handler.ts';
import { registerEngine } from './engine/index.ts';
import { subscribeEvent } from './events/bus.ts';
import type { AgentEngine } from './engine/types.ts';
import type { ServerFeature } from './features.ts';
import type { Server as HttpServer } from 'node:http';
import type { Express } from 'express';
import { emitEvent } from './events/bus.ts';
import type { ExtRegisterFn } from './extensions.ts';
import type { WebhookOptions } from './events/webhook.ts';
import type { ShragaEvent, PayloadOf } from './events/types.ts';

export interface BootRegistrations {
  features?: ServerFeature[];
  engines?: AgentEngine[];
  extensions?: ExtRegisterFn[];
  eventSubs?: Array<{ source: string; handler: (payload: any, evt: any) => void }>;
}

export interface ServerHandle {
  app: Express;
  server: HttpServer;
  port: number;
  url: string;
  /** Publish an event onto the in-process bus (same fn extensions get as ctx.emitEvent). */
  emitEvent: typeof emitEvent;
  /** Register an extension AFTER start() — mounts onto the live extension Router (before the SPA
   *  catch-all), the same seam file-based *.ext.ts drop-ins hot-load through. OPT-IN: throws unless
   *  ShragaOptions.runtimeRegistration is enabled. */
  registerExtension: (fn: ExtRegisterFn) => Promise<void>;
  /** Declare a verified vendor webhook AFTER start() (sugar over registerExtension — a webhook IS an
   *  extension). OPT-IN: throws unless runtimeRegistration is enabled. */
  registerWebhook: <K extends string>(opts: WebhookOptions<K>) => Promise<void>;
  /** Subscribe to a typed event source AFTER start(). Returns an unsubscribe fn. OPT-IN: throws
   *  unless runtimeRegistration is enabled. */
  on: <K extends string>(source: K, handler: (payload: PayloadOf<K>, evt: ShragaEvent<K>) => void) => () => void;
  /** Drain in-flight streams, stop consumers, close the server. Does NOT exit the process. */
  stop: () => Promise<void>;
}

export async function bootServer(__reg: BootRegistrations = {}): Promise<ServerHandle> {
// Passive mode: HTTP serving only — no schedulers, event consumers, or background writers.
// Used by shadow-verify instances and warm-standby twins that share a live DATA_DIR
// (single-active-writer rule: the active instance is the only one mutating data/).
// `UNCLAW_PASSIVE` is the legacy name — still honoured so existing deploy recipes keep working.
const PASSIVE_FLAG = process.env.SHRAGA_PASSIVE ?? process.env.UNCLAW_PASSIVE;
const PASSIVE = PASSIVE_FLAG === '1' || PASSIVE_FLAG === 'true';
if (PASSIVE) console.log('[server] PASSIVE mode — schedulers, consumers and background writers disabled');

if (!PASSIVE) await dataSync.init();
await loadShragaConfig();
// Programmatic engines register through the same seam an overlay uses — BEFORE initEngines() so
// getAvailableEngines() includes them and a directive can resolve to one immediately.
for (const e of __reg.engines ?? []) registerEngine(e);
// Programmatic event subscribers land before the dispatcher starts, symmetric with an overlay.
for (const s of __reg.eventSubs ?? []) subscribeEvent(s.source, s.handler);
await initEngines();
if (!PASSIVE) syncVendorRepos().catch(err => console.warn('[vendor-sync] error:', (err as Error).message));
seedDefaults();
const purged = purgeExpiredSkills();
if (purged.length) console.log(`[skills] Purged ${purged.length} expired skill(s): ${purged.join(', ')}`);
for (const w of lintSkills()) console.warn(`[skills] lint: ${w}`);
hydrateSlackUserToken();

// Seed operator contacts from whitelist
try {
  const wl = JSON.parse(readFileSync(dataPath('whitelist.json'), 'utf-8'));
  if (Array.isArray(wl)) seedOperators(wl);
} catch (err) { console.warn('[contacts] Could not seed operators:', (err as Error).message); }

// Backfill visibleTo on legacy bot sessions (idempotent — skips already-patched)
backfillSessionVisibility(({ name }) => {
  if (!name) return null;
  const lower = name.toLowerCase();
  return getAllContacts().find((c) => c.name.toLowerCase() === lower) ?? null;
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The client build to serve. Default = shraga's shipped dist/client; a consumer shipping its own UI
// (e.g. the EE client) sets SHRAGA_CLIENT_DIR (via the clientDir option or env) to its own dist.
const distPath = process.env.SHRAGA_CLIENT_DIR
  ? path.resolve(process.env.SHRAGA_CLIENT_DIR)
  : path.resolve(__dirname, '../../dist/client');

const app = express();
app.use(express.json({
  limit: '20mb',
  verify: (req, _res, buf) => { (req as any).rawBody = buf; },
}));
// Slack interactivity posts application/x-www-form-urlencoded; capture rawBody for signature verification.
app.use(express.urlencoded({
  extended: true,
  limit: '5mb',
  verify: (req, _res, buf) => { (req as any).rawBody = buf; },
}));

app.use((req, _res, next) => {
  const start = Date.now();
  const orig = _res.end.bind(_res);
  (_res as any).end = (...args: any[]) => {
    console.log(`[http] ${req.method} ${req.url} → ${_res.statusCode} (${Date.now() - start}ms)`);
    return orig(...args);
  };
  next();
});

const SERVER_BUILD_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// ── REST routes ───────────────────────────────────────────────────────────────

app.get('/api/version', (_req, res) => {
  try {
    const pkg = JSON.parse(readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'));
    res.json({ version: pkg.version });
  } catch { res.json({ version: 'unknown' }); }
});

// Cached host stats — returns the in-memory ring buffer (does NOT sample on request).
app.get('/api/stats', requireAuth, (_req, res) => {
  res.json({ samples: statsSampler.getStats() });
});

app.get('/api/sessions', requireAuth, async (req, res) => {
  const user = (req as any).user;
  // Exclude PTY-only sessions — a standalone/terminal-first shell is not a conversation.
  res.json(getSessionsVisibleTo(user.uid, user.isOwner, user.email).filter((s) => s.kind !== 'terminal'));
});

app.get('/api/sessions/:id/meta', requireAuth, async (req, res) => {
  const user = (req as any).user;
  const meta = getSession(String(req.params.id));
  if (!meta) return res.status(404).json({ error: 'not found' });
  if (!isSessionVisibleTo(meta, user.uid, user.isOwner, user.email)) return res.status(404).json({ error: 'not found' });
  res.json(meta);
});

// Per-session runtime directives (engine/model/turns/thinking). The Agent Config panel writes these
// for the active session so a change applies to THIS conversation — session directives shadow the
// global agent-config at send time (see claude.ts), so editing the global config alone never affects
// an already-started session.
app.put('/api/sessions/:id/directives', requireAuth, (req, res) => {
  const user = (req as any).user;
  const sid = String(req.params.id);
  const meta = getSession(sid);
  if (!meta) return void res.status(404).json({ error: 'not found' });
  if (!isSessionVisibleTo(meta, user.uid, user.isOwner, user.email)) return void res.status(404).json({ error: 'not found' });
  // thinking is an untrusted request field; type it to the valid set (invalid strings fall through
  // the `|| undefined` below). Keys the core doesn't own (an add-on's, e.g. voice model directives)
  // pass through OPAQUELY — the core names none of them: '' clears, `false` is preserved, else stored.
  const CORE_KEYS = new Set(['engine', 'model', 'turns', 'thinking']);
  const body = (req.body ?? {}) as Record<string, unknown> & { engine?: string; model?: string; turns?: number; thinking?: 'enabled' | 'adaptive' | 'disabled' };
  const passthrough: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (CORE_KEYS.has(k)) continue;
    passthrough[k] = v === '' ? undefined : v; // '' = unset → fall back to default; `false` preserved (e.g. a tier off)
  }
  const next = {
    ...meta.directives,
    ...(body.engine !== undefined ? { engine: body.engine || undefined } : {}),
    ...(body.model !== undefined ? { model: body.model || undefined } : {}),
    ...(body.turns !== undefined ? { turns: body.turns } : {}),
    ...(body.thinking !== undefined ? { thinking: body.thinking || undefined } : {}),
    ...passthrough,
  };
  setSessionDirectives(sid, next);
  res.json({ directives: next });
});

app.get('/api/sessions/:id/messages', requireAuth, async (req, res) => {
  const sid = String(req.params.id);
  console.log(`[http] loading messages for session ${sid.slice(0, 8)}…`);
  const session = getSession(sid);
  const conv = loadConversation(sid);
  if (conv.length > 0) {
    const partial = readLivePartial(sid) ?? readPartial(sid);
    if (partial?.length) {
      conv.push({ id: `partial-${sid}`, role: 'assistant', blocks: partial, ts: Date.now() });
      console.log(`[http] loaded ${conv.length} messages (incl. partial) from own store for ${sid.slice(0, 8)}`);
    } else {
      console.log(`[http] loaded ${conv.length} messages from own store for ${sid.slice(0, 8)}`);
    }
    const senders = new Set(conv.filter(m => m.role === 'user' && m.senderName).map(m => m.senderName));
    if (session?.userName) senders.add(session.userName);
    return res.json({ format: 'conv', messages: conv, busy: isSessionBusy(sid), participants: [...senders] });
  }
  const messages = await getSessionHistory(sid);
  console.log(`[http] loaded ${messages.length} messages from Claude JSONL for ${sid.slice(0, 8)}`);
  res.json({ format: 'jsonl', messages, busy: isSessionBusy(sid) });
});

app.post('/api/sessions/:id/fork', requireAuth, (req, res) => {
  const user = (req as any).user as import('./auth.ts').AuthUser;
  const sourceId = String(req.params.id);
  const source = getSession(sourceId);
  if (!source) return void res.status(404).json({ error: 'not found' });
  if (!isSessionVisibleTo(source, user.uid, user.isOwner, user.email)) return void res.status(404).json({ error: 'not found' });
  const { truncateAtIndex } = req.body as { truncateAtIndex?: number };
  const newId = forkSession(sourceId, { uid: user.uid, email: user.email, name: user.email.split('@')[0] }, truncateAtIndex);
  if (!newId) return void res.status(400).json({ error: 'nothing to fork' });
  console.log(`[http] forked session ${sourceId.slice(0, 8)} → ${newId.slice(0, 8)} for ${user.email}`);
  res.json({ sessionId: newId });
});

app.post('/api/sessions/:id/push', requireAuth, (req, res) => {
  const sid = String(req.params.id);
  const meta = getSession(sid);
  if (!meta) return void res.status(404).json({ error: 'not found' });
  const { message, source } = req.body as { message?: string; source?: 'proactive' | 'schedule' };
  if (!message) return void res.status(400).json({ error: 'message required' });
  appendMessage(sid, { id: crypto.randomUUID(), role: 'assistant', blocks: [{ type: 'text', text: message }], ts: Date.now() });
  upsertSession(sid, meta.title, { uid: meta.uid, email: meta.userEmail });
  notifyUnread(meta.uid, sid, message.slice(0, 120), source || 'proactive', meta.title);
  broadcast({ type: 'session_messages_changed', sessionId: sid });
  console.log(`[http] pushed message to ${sid.slice(0, 8)} for ${meta.userEmail}`);
  res.json({ ok: true });
});

app.get('/api/mcps', requireAuth, (req, res) => {
  const user = (req as any).user;
  const globalNames = new Set(Object.keys(getGlobalMcpConfig()));
  const resolved = maskEnvValues(getResolvedMcpConfig(user.uid));
  const entries: Record<string, McpConfig[string] & { readonly?: boolean }> = {};
  for (const [name, config] of Object.entries(resolved)) {
    entries[name] = { ...config, readonly: globalNames.has(name) };
  }
  res.json(entries);
});

app.put('/api/mcps', requireAuth, (req, res) => {
  const user = (req as any).user;
  const globalNames = new Set(Object.keys(getGlobalMcpConfig()));
  const incoming = req.body as McpConfig;
  const userOnly: McpConfig = {};
  for (const [name, config] of Object.entries(incoming)) {
    if (!globalNames.has(name)) userOnly[name] = config;
  }
  const original = getRawMcpConfig(user.uid);
  const merged = mergeWithOriginal(userOnly, original);
  saveMcpConfig(user.uid, merged);
  res.json({ ok: true });
});

app.get('/api/config', requireAuth, (_req, res) => {
  // `claudeAuthSource` is derived server state (not persisted config) — the spread always overrides
  // any stale value, so it can never round-trip into agent-config.json even if a client echoes it back.
  res.json({ ...getAgentConfig(), claudeAuthSource: getClaudeAuthSource() });
});

app.put('/api/config', requireAuth, (req, res) => {
  const { claudeAuthSource: _drop, ...config } = (req.body ?? {}) as AgentConfig & { claudeAuthSource?: string };
  saveAgentConfig(config);
  res.json({ ok: true });
});

app.get('/api/engines', requireAuth, (_req, res) => {
  const engines = getAvailableEngines();
  const result = engines.map(name => {
    const engine = getEngine(name);
    return { name, models: engine.getModels() };
  });
  res.json({ engines: result, multiEngine: engines.length > 1 });
});


app.get('/api/skills', requireAuth, (_req, res) => {
  res.json({ skills: [...listSkills(), ...listMcpCommands(), 'compact'], builtins: getBuiltinSkillNames() });
});

app.get('/api/skills/:name', requireAuth, (req, res) => {
  const skill = getSkill(String(req.params.name));
  if (!skill) return res.status(404).json({ error: 'Not found' });
  res.json(skill);
});

app.put('/api/skills/:name', requireAuth, (req, res) => {
  try {
    const { content } = req.body as { content: string };
    saveSkill(String(req.params.name), content ?? '');
    res.json({ ok: true });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/skills/:name', requireAuth, (req, res) => {
  try {
    deleteSkill(String(req.params.name));
    res.json({ ok: true });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.post('/api/skills/:name/duplicate', requireAuth, (req, res) => {
  try {
    const { newName } = req.body as { newName: string };
    const skill = duplicateSkill(String(req.params.name), newName);
    res.json(skill);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.post('/api/skills/:name/rename', requireAuth, (req, res) => {
  try {
    const { newName } = req.body as { newName: string };
    renameSkill(String(req.params.name), newName);
    res.json({ ok: true });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.get('/api/skills-defaults', requireAuth, (_req, res) => {
  res.json(getDefaultSkills());
});

app.put('/api/skills-defaults', requireAuth, (req, res) => {
  setDefaultSkills(req.body);
  res.json({ ok: true });
});

// ── Data-plane modules ───────────────────────────────────────────────────────
registerModuleRoutes(app, requireAuth);

// ── Schedules ────────────────────────────────────────────────────────────────

function scheduleIfVisible(id: string, uid: string, isOwner = false): Schedule | undefined {
  const s = scheduler.getSchedule(id);
  if (!s) return undefined;
  if (isOwner || s.scope === 'system' || s.createdBy.uid === uid) return s;
  return undefined;
}

app.get('/api/schedules', requireAuth, (req, res) => {
  const user = (req as any).user;
  const schedules = scheduler.listSchedules().filter((s) => user.isOwner || s.scope === 'system' || s.createdBy.uid === user.uid);
  const runningIds = scheduler.getRunningIds();
  res.json({ schedules, runningIds });
});

app.get('/api/schedules/:id', requireAuth, (req, res) => {
  const user = (req as any).user;
  const s = scheduleIfVisible(String(req.params.id), user.uid, user.isOwner);
  if (!s) return res.status(404).json({ error: 'Not found' });
  res.json(s);
});

app.post('/api/schedules', requireAuth, (req, res) => {
  const user = (req as any).user;
  const body = req.body as Partial<Schedule>;
  const now = Date.now();
  const schedule: Schedule = {
    id: crypto.randomUUID(),
    name: body.name || 'Untitled schedule',
    enabled: body.enabled ?? true,
    trigger: body.trigger as Schedule['trigger'],
    task: body.task as Schedule['task'],
    scope: 'user',
    createdBy: { uid: user.uid, email: user.email },
    createdAt: now,
    updatedAt: now,
    runCount: 0,
  };
  const result = scheduler.upsertSchedule(schedule);
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json(result.schedule);
});

app.put('/api/schedules/:id', requireAuth, (req, res) => {
  const user = (req as any).user;
  const id = String(req.params.id);
  const existing = scheduleIfVisible(id, user.uid, user.isOwner);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (existing.createdBy.uid !== user.uid && !user.isOwner) return res.status(403).json({ error: 'Only the owner can edit this schedule' });
  const body = req.body as Partial<Schedule>;
  const updated: Schedule = {
    ...existing,
    name: body.name ?? existing.name,
    enabled: body.enabled ?? existing.enabled,
    trigger: (body.trigger ?? existing.trigger) as Schedule['trigger'],
    task: (body.task ?? existing.task) as Schedule['task'],
  };
  const result = scheduler.upsertSchedule(updated);
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json(result.schedule);
});

app.delete('/api/schedules/:id', requireAuth, (req, res) => {
  const user = (req as any).user;
  const id = String(req.params.id);
  const existing = scheduleIfVisible(id, user.uid, user.isOwner);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (existing.createdBy.uid !== user.uid && !user.isOwner) return res.status(403).json({ error: 'Only the owner can delete this schedule' });
  const ok = scheduler.deleteSchedule(id);
  if (!ok) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

app.post('/api/schedules/:id/toggle', requireAuth, (req, res) => {
  const user = (req as any).user;
  const id = String(req.params.id);
  if (!scheduleIfVisible(id, user.uid, user.isOwner)) return res.status(404).json({ error: 'Not found' });
  const s = scheduler.toggleSchedule(id, !!req.body.enabled);
  if (!s) return res.status(404).json({ error: 'Not found' });
  res.json(s);
});

app.post('/api/schedules/:id/run', requireAuth, (req, res) => {
  const user = (req as any).user;
  const id = String(req.params.id);
  if (!scheduleIfVisible(id, user.uid, user.isOwner)) return res.status(404).json({ error: 'Not found' });
  const override = typeof req.body?.override === 'string' ? req.body.override.trim() || undefined : undefined;
  const sessionId = scheduler.runNow(id, override);
  if (!sessionId) return res.status(404).json({ error: 'Not found' });
  res.json({ sessionId });
});

app.post('/api/schedules/:id/cancel', requireAuth, (req, res) => {
  const user = (req as any).user;
  const id = String(req.params.id);
  if (!scheduleIfVisible(id, user.uid, user.isOwner)) return res.status(404).json({ error: 'Not found' });
  const ok = scheduler.cancelRun(id);
  res.json({ ok });
});

app.get('/api/schedules/:id/runs', requireAuth, (req, res) => {
  const user = (req as any).user;
  const id = String(req.params.id);
  if (!scheduleIfVisible(id, user.uid, user.isOwner)) return res.status(404).json({ error: 'Not found' });
  res.json(getSessionsByScheduleId(id));
});

// ── REST chat endpoint (for automation / CLI triggers / agent-to-agent) ──────
/**
 * Run a single chat turn with all its side effects (session lock, message
 * persistence, run-status, unread notify, broadcast). Shared by the /api/chat
 * route and the MCP streaming handler. Pass `hooks.onEvent` to observe the live
 * agent stream (progress streaming). Returns a discriminated result so callers
 * map it to their own transport (HTTP status / MCP frame).
 */
type RunChatTurnResult =
  | { status: 'busy' }
  | { sessionId: string; text: string; blocks: ConvBlock[] }
  | { sessionId: string; error: string };

async function runChatTurn(
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
): Promise<RunChatTurnResult> {
  const { prompt, sessionId: reqSid, uid, userEmail } = opts;
  const userName = opts.userName ?? userEmail.split('@')[0];
  const sid = reqSid || `api-${crypto.randomUUID()}`;
  const abortController = opts.abortController ?? new AbortController();

  if (reqSid && !acquireSessionLock(sid, 'api', abortController)) {
    return { status: 'busy' };
  }
  if (!reqSid) acquireSessionLock(sid, 'api', abortController);
  upsertSession(sid, prompt, { uid, email: userEmail });
  appendMessage(sid, { id: crypto.randomUUID(), role: 'user', blocks: [{ type: 'text', text: prompt }], channel: 'api', senderName: userName });
  setRunStatus(sid, 'running', 'web');

  try {
    const blocks = await consumeStream(streamChat({
      prompt,
      sessionId: sid,
      uid,
      userEmail,
      userName,
      mcpServers: getMcpConfig(uid),
      abortController,
      context: opts.context ?? { source: 'api', user: userEmail },
      onPermissionRequest: async () => ({ allow: true }),
    }), hooks?.onEvent);
    if (blocks.length) {
      appendMessage(sid, { id: crypto.randomUUID(), role: 'assistant', blocks });
    }
    const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n');
    const meta = getSession(sid);
    notifyUnread(uid, sid, text.slice(0, 120) || '(completed)', 'response', meta?.title);
    broadcast({ type: 'session_messages_changed', sessionId: sid });
    return { sessionId: sid, text, blocks };
  } catch (err: any) {
    console.error(`[chat-turn] error:`, err.message);
    return { sessionId: sid, error: err.message };
  } finally {
    if (releaseSessionLock(sid, abortController)) {
      setRunStatus(sid, 'idle');
    }
  }
}

app.post('/api/chat', requireAuth, async (req, res) => {
  const user = (req as any).user as import('./auth.ts').AuthUser;
  const { prompt, sessionId: reqSid, callbackUrl, sync, clientRequestId } = req.body as {
    prompt?: string; sessionId?: string; callbackUrl?: string; sync?: boolean; clientRequestId?: string;
  };
  if (!prompt) return void res.status(400).json({ error: 'prompt required' });
  if (callbackUrl) {
    try { const u = new URL(callbackUrl); if (!['http:', 'https:'].includes(u.protocol)) throw 0; }
    catch { return void res.status(400).json({ error: 'callbackUrl must be a valid HTTP(S) URL' }); }
  }

  // Idempotency: a retried submit with the same key reuses the session that first
  // handled it (within TTL) instead of spawning a duplicate.
  const idemKey = clientRequestId || (req.get('idempotency-key') || undefined);
  if (idemKey) {
    const existing = lookupIdempotent(user.uid, idemKey);
    if (existing) return void res.json({ sessionId: existing, status: 'duplicate' });
  }

  const sid = reqSid || `api-${crypto.randomUUID()}`;
  if (idemKey) rememberIdempotent(user.uid, idemKey, sid);
  const apiAbortController = new AbortController();
  const run = () => runChatTurn({
    prompt,
    sessionId: sid,
    uid: user.uid,
    userEmail: user.email,
    abortController: apiAbortController,
    context: { source: 'api', user: user.email },
  });

  if (sync) {
    const result = await run();
    if ('status' in result) return void res.status(409).json({ error: 'Session is already processing a request' });
    if ('error' in result) return void res.status(500).json(result);
    res.json(result);
  } else {
    // Reject a duplicate before responding 'accepted' (lock is acquired inside run()).
    if (reqSid && isSessionLocked(sid)) {
      return void res.status(409).json({ error: 'Session is already processing a request' });
    }
    res.json({ sessionId: sid, status: 'accepted' });
    const result = await run();
    if (callbackUrl) {
      try {
        await fetch(callbackUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(result),
        });
      } catch (err: any) {
        console.error(`[api-chat] callback failed (${callbackUrl}):`, err.message);
      }
    }
  }
});

app.get('/api/workspace', requireAuth, (_req, res) => {
  res.json({ entries: listWorkspaceTree() });
});

app.get('/api/workspace/ls', requireAuth, (req, res) => {
  const dir = String(req.query.path ?? '');
  res.json({ entries: listWorkspaceDir(dir) });
});

app.get('/api/workspace/file', requireAuth, (req, res) => {
  const rel = String(req.query.path ?? '');
  if (!rel) return res.status(400).json({ error: 'path required' });
  const result = readWorkspaceFile(rel);
  if (!result) return res.status(404).json({ error: 'Not found or invalid path' });
  res.json(result);
});

app.get('/api/workspace/raw', requireAuth, (req, res) => {
  const rel = String(req.query.path ?? '');
  if (!rel) return res.status(400).json({ error: 'path required' });
  const resolved = resolveWorkspacePath(rel);
  if (!resolved || !existsSync(resolved)) return res.status(404).json({ error: 'Not found' });
  try { if (!statSync(resolved).isFile()) return res.status(400).json({ error: 'Not a file' }); }
  catch { return res.status(404).json({ error: 'Not found' }); }
  if (req.query.dl) {
    const filename = (rel.split('/').pop() || 'download').replace(/"/g, '\\"');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  }
  res.sendFile(resolved);
});

app.use('/uploads/shared', express.static(dataPath('uploads/shared'), { dotfiles: 'deny', index: false }));
app.use('/uploads', requireAuth, express.static(dataPath('uploads'), { dotfiles: 'deny', index: false }));

app.post('/api/upload', requireAuth, express.raw({ type: '*/*', limit: '50mb' }), (req, res) => {
  const sid = (req.headers['x-session-id'] as string) || 'shared';
  const uploadsDir = dataPath(`uploads/${sid}`);
  mkdirSync(uploadsDir, { recursive: true });
  const raw = (req.headers['x-filename'] as string) || 'upload';
  const safeName = path.basename(decodeURIComponent(raw));
  const id = crypto.randomUUID().slice(0, 8);
  const filename = `${id}-${safeName}`;
  const dest = path.join(uploadsDir, filename);
  writeFileSync(dest, req.body as Buffer);
  const mimeType = (req.headers['content-type'] as string) || 'application/octet-stream';
  res.json({ url: `/uploads/${sid}/${filename}`, path: dest, name: safeName, mimeType });
});

registerMcpOAuthRoutes(app);

app.get('/api/data-sync/log', requireAuth, async (_req, res) => {
  const log = await dataSync.getLog();
  res.json(log);
});

app.use(artifactsRouter);

// Runtime feature flags for the client (env-gated, never persisted to agent-config.json).
// ── Auth mode + local login (PUBLIC — no requireAuth) ────────────────────────
// The client asks /api/auth/mode to decide which login UI to render (local form vs
// Firebase Google). Local login/register only exist when AUTH_PROVIDER=local (default).
app.get('/api/auth/mode', (_req, res) => {
  res.json({ provider: AUTH_PROVIDER, needsSetup: AUTH_PROVIDER === 'local' && localUserCount() === 0 });
});
app.post('/api/auth/login', (req, res) => {
  if (AUTH_PROVIDER !== 'local') return void res.status(404).json({ error: 'local auth disabled' });
  const { email, password } = (req.body ?? {}) as { email?: string; password?: string };
  const token = email && password ? localLogin(email, password) : null;
  if (!token) return void res.status(401).json({ error: 'Invalid credentials' });
  res.json({ token, user: { uid: email, email } });
});
app.post('/api/auth/register', (req, res) => {
  if (AUTH_PROVIDER !== 'local') return void res.status(404).json({ error: 'local auth disabled' });
  // First-run bootstrap: allow creating the first user; after that require SHRAGA_ALLOW_SIGNUP=1.
  if (localUserCount() > 0 && process.env.SHRAGA_ALLOW_SIGNUP !== '1') return void res.status(403).json({ error: 'Signup disabled' });
  const { email, password } = (req.body ?? {}) as { email?: string; password?: string };
  if (!email || !password) return void res.status(400).json({ error: 'email + password required' });
  try { addLocalUser(email, password); } catch (e: any) { return void res.status(409).json({ error: e.message }); }
  res.json({ token: localLogin(email, password), user: { uid: email, email } });
});

// Feature gates. Add-on surfaces ship OFF; enable per-deployment via SHRAGA_FEAT_* env
// (an optional add-on / downstream distribution sets them on). Single source of truth for the web UI.
const featEnabled = (k: string, def = false): boolean => {
  const v = process.env[`SHRAGA_FEAT_${k}`];
  return v === undefined ? def : v === '1' || v === 'true';
};
app.get('/api/features', requireAuth, (_req, res) => {
  // Core flags (SHRAGA_FEAT_* env), then merge feature-contributed flags OVER them. The core names no
  // add-on surface: add-on features declare their own capability flags through the seam (collectFeatureFlags).
  res.json({
    push: pushEnabled(),
    workspace: featEnabled('WORKSPACE'), // multi-tab workspace (FlexLayout). Default = chat-only.
    instances: featEnabled('INSTANCES'), // multi-instance (fleet) switcher
    ...collectFeatureFlags(),            // add-on surfaces declare their own flags here.
  });
});

// ── Remote push (native appwrap wrappers register device tokens here) ──────────
// Gated by PUSH_ENABLED + provider creds; register is a no-op-OK when disabled.
app.post('/api/push/register', requireAuth, (req, res) => {
  const uid = (req as any).user.uid as string;
  const { token, platform, topic } = (req.body || {}) as { token?: string; platform?: string; topic?: string };
  if (!pushEnabled()) return void res.json({ ok: true, enabled: false });
  if (!token || (platform !== 'apns' && platform !== 'fcm')) {
    return void res.status(400).json({ error: 'token + platform(apns|fcm) required' });
  }
  upsertToken(uid, token, platform, topic);
  res.json({ ok: true });
});
app.post('/api/push/unregister', requireAuth, (req, res) => {
  const uid = (req as any).user.uid as string;
  const { token } = (req.body || {}) as { token?: string };
  if (token) removeToken(uid, token);
  res.json({ ok: true });
});

// ── API Keys ──────────────────────────────────────────────────────────────────
app.get('/api/api-keys', requireAuth, (req, res) => {
  res.json({ keys: listApiKeys() });
});
app.post('/api/api-keys', requireAuth, (req, res) => {
  const user = (req as any).user as import('./auth.ts').AuthUser;
  const { label } = req.body as { label?: string };
  const key = createApiKey(user.uid, user.email, label || 'Unnamed');
  res.json(key);
});
app.delete('/api/api-keys/:id', requireAuth, (req: express.Request<{ id: string }>, res) => {
  const user = (req as any).user as import('./auth.ts').AuthUser;
  const ok = deleteApiKey(req.params.id, user.uid, user.isOwner);
  if (ok === 'not_found') return void res.status(404).json({ error: 'Key not found' });
  if (ok === 'forbidden') return void res.status(403).json({ error: 'Cannot delete another user\'s key' });
  res.json({ ok: true });
});

// ── MCP Server ────────────────────────────────────────────────────────────────
mountMcpServer(app, { runChatTurn });

// Mount deployment drop-in routes from data/extensions/*.ext.ts (hot-reload, before catch-all).
const { loadExtensions, registerExtension } = await import('./extensions.ts');
// Programmatic extensions funnel through the SAME router+ctx as file-based *.ext.ts drop-ins
// (mounted before the SPA catch-all). Queue them before loadExtensions so it flushes them.
for (const fn of __reg.extensions ?? []) await registerExtension(fn);
await loadExtensions(app);

// `index: false` so `/` falls through to the SPA catch-all, which injects the runtime web-config
// into index.html. Static assets (JS/CSS/etc.) are still served directly from here.
if (existsSync(distPath)) app.use(express.static(distPath, { index: false }));

// The SPA catch-all (`app.get('*')`) is registered LATER — after mountFeatures() — via
// registerSpaCatchAll(), so feature/extension GET routes are matched before falling through to
// index.html. It is re-registered on passive→active promotion (mountFeatures runs again there),
// each call splicing out the prior catch-all layer so it stays truly LAST in the router stack.
// In dev (no dist/) it is skipped entirely — Vite serves the SPA and a catch-all would 404-shadow it.
// Implementation + predicate live in ./spa-catchall.ts (unit-tested there).

// ── WebSocket + Server ───────────────────────────────────────────────────────

const server = createServer(app);

// ── WebSocket ────────────────────────────────────────────────────────────────

const wss = new WebSocketServer({ noServer: true });

interface WsSession {
  uid: string;
  email: string;
  busySessions: Set<string>;
  autoApprove: boolean;
  abortControllers: Map<string, AbortController>;
  pendingPermissions: Map<string, { resolve: (result: { allow: boolean }) => void; destructive?: boolean; tool?: string; input?: unknown; sessionId?: string }>;
  pendingQuestions: Map<string, { resolve: (answers: QuestionAnswers | null) => void }>;
  steerPending: Map<string, string>;
  lastSessionId: string | null;
  viewingSessionId: string | null;
  focused: boolean;
}

function isUserViewingSession(uid: string, sessionId: string, excludeWs?: WebSocket): boolean {
  for (const [ws, s] of activeConnections) {
    if (ws === excludeWs) continue;
    if (s.uid === uid && s.viewingSessionId === sessionId && s.focused) return true;
  }
  return false;
}

function isUserConnected(uid: string): boolean {
  for (const [, s] of activeConnections) {
    if (s.uid === uid) return true;
  }
  return false;
}

function notifyUnread(uid: string, sessionId: string, preview: string, source: 'response' | 'proactive' | 'schedule', title?: string, senderWs?: WebSocket) {
  if (senderWs) {
    const senderSession = activeConnections.get(senderWs);
    if (senderSession?.viewingSessionId === sessionId && senderSession.focused) return;
  }
  if (isUserViewingSession(uid, sessionId)) return;
  const entry = addUnread(uid, sessionId, preview, source, title);
  console.log(`[unread] ${source} notification for ${uid.slice(0, 8)} session=${sessionId.slice(0, 8)} count=${entry.count}`);
  for (const [ws, s] of activeConnections) {
    if (s.uid === uid) {
      send(ws, { type: 'unread', sessionId, count: entry.count, preview, source, title });
    }
  }
}

function sendUnreadSync(ws: WebSocket, uid: string) {
  const unreads = getUnreads(uid);
  if (Object.keys(unreads.sessions).length > 0) {
    send(ws, { type: 'unread_sync', sessions: unreads.sessions });
  }
}

// ── Sidecar WebSocket proxy ─────────────────────────────────────────────────

// Sidecar WS proxy routes (url-prefix → localhost port). CE owns NONE — every route is an add-on's
// own daemon (its prefix → its port), folded in from the `sidecarRoutes` feature seam after feature
// registration below (see `Object.assign(WS_PROXY_ROUTES, collectSidecarRoutes())`).
const WS_PROXY_ROUTES: Record<string, number> = {};

function resolveSidecarPort(urlPath: string): number | null {
  const prefix = urlPath.split('/').filter(Boolean)[0];
  return prefix ? WS_PROXY_ROUTES[prefix] ?? null : null;
}

const sidecarWss = new WebSocketServer({ noServer: true });

function proxySidecarWebSocket(req: import('node:http').IncomingMessage, socket: import('node:stream').Duplex, head: Buffer, port: number) {
  const targetUrl = `ws://127.0.0.1:${port}${req.url}`;
  sidecarWss.handleUpgrade(req, socket as any, head, (clientWs) => {
    const targetWs = new WebSocket(targetUrl);
    let opened = false;

    targetWs.on('open', () => {
      opened = true;
      clientWs.on('message', (data, isBinary) => {
        // App-level liveness probe (Layer 2): the client can't read protocol pongs from JS and the daemon
        // doesn't speak ping, so answer `{type:'ping'}` here without forwarding. Lets the browser detect a
        // half-open socket the server-side terminate can't reach (broken path) and force a reconnect.
        // Cheap prefilter (small + contains "ping") so we don't JSON-parse every keystroke/paste frame.
        if (!isBinary && (data as Buffer).length < 64) {
          const s = data.toString();
          if (s.includes('"ping"')) {
            try {
              if (JSON.parse(s).type === 'ping') {
                if (clientWs.readyState === WebSocket.OPEN) clientWs.send(JSON.stringify({ type: 'pong' }));
                return;
              }
            } catch { /* not JSON — fall through to relay */ }
          }
        }
        if (targetWs.readyState === WebSocket.OPEN) targetWs.send(data, { binary: isBinary });
      });
      targetWs.on('message', (data, isBinary) => {
        if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data, { binary: isBinary });
      });
    });

    // Keepalive: a proxied sidecar socket carries no app-level heartbeat, so an idle WS gets silently dropped
    // by an intermediary (Cloudflare tunnel idles WS at ~100s) leaving the BROWSER half-open — readyState
    // stays OPEN, no onclose fires, the "connected" dot stays green and keystrokes vanish into a dead pipe.
    // Ping the client (browsers auto-pong at the protocol level) to keep intermediaries from idling us out,
    // and terminate a peer that misses a pong so the client gets a real close → its reconnect kicks in.
    // Tolerate ONE missed pong before terminating (~2 intervals of grace): a backgrounded mobile tab is
    // JS/network-frozen and can't auto-pong for a cycle, so a 1-strike policy force-closed it every 30s and
    // churned reconnects. Two strikes lets a brief freeze ride through; a truly dead pipe still gets cut.
    let missedPongs = 0;
    clientWs.on('pong', () => { missedPongs = 0; });
    const pingInterval = setInterval(() => {
      if (clientWs.readyState !== WebSocket.OPEN) return;
      if (missedPongs >= 2) { console.warn('[ws-proxy] client missed pongs — terminating (likely backgrounded/frozen client)'); clientWs.terminate(); return; }
      missedPongs++;
      clientWs.ping();
    }, WS_PING_INTERVAL);

    targetWs.on('close', () => { clearInterval(pingInterval); clientWs.close(); });
    targetWs.on('error', (e) => {
      // Pre-open failure = the sidecar daemon is unreachable (e.g. it idle-exited, or is not up yet
      // after a restart). This is TRANSIENT: the daemon (and its shells) survive a server/proxy blip, and
      // we revive it right below — so flag `fatal:false`. The client must keep the pane alive and re-attach
      // (a mobile client that backgrounded for minutes recovers its still-running sidecar on resume), NOT show a
      // permanent "session unavailable". Only the daemon's own `session not found` (post-open) is fatal.
      if (!opened) {
        if (clientWs.readyState === WebSocket.OPEN) {
          try { clientWs.send(JSON.stringify({ type: 'error', message: 'sidecar daemon unavailable', fatal: false })); } catch { /* socket gone */ }
        }
      } else {
        console.warn('[ws-proxy] target error:', e.message);
      }
      clientWs.close();
    });
    clientWs.on('close', () => { clearInterval(pingInterval); if (targetWs.readyState === WebSocket.OPEN) targetWs.close(); });
    clientWs.on('error', (e) => { console.error(`[ws-proxy] client error:`, e.message); targetWs.close(); });
  });
}

server.on('upgrade', (req, socket, head) => {
  if (req.url === '/ws') {
    wss.handleUpgrade(req, socket as any, head, (ws) => {
      const session: WsSession = { uid: '', email: '', busySessions: new Set(), autoApprove: false, abortControllers: new Map(), pendingPermissions: new Map(), pendingQuestions: new Map(), steerPending: new Map(), lastSessionId: null, viewingSessionId: null, focused: true };
      handleConnection(ws, session);
    });
  } else {
    const port = req.url ? resolveSidecarPort(req.url) : null;
    if (port) {
      proxySidecarWebSocket(req, socket, head, port);
    } else {
      socket.destroy();
    }
  }
});

function send(ws: WebSocket, data: object) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

const DESTRUCTIVE_PERMISSION_TTL = 10 * 60_000;
const WS_PING_INTERVAL = 30_000;
const activeConnections = new Map<WebSocket, WsSession>();
const globalPendingPermissions = new Map<string, { resolve: (r: { allow: boolean }) => void; sessionId: string; tool: string; input: unknown; uid: string }>();
function isSessionBusy(sid: string): boolean {
  return isSessionLocked(sid);
}
function broadcast(data: object, exclude?: WebSocket) {
  for (const ws of activeConnections.keys()) {
    if (ws !== exclude) send(ws, data);
  }
}

setBroadcaster(broadcast); // let session-bus push async events (e.g. an add-on's background worker output) to clients
ensureWorkspaceDir();
watchWorkspace((event) => broadcast({ type: 'workspace_change', ...event }));
if (!PASSIVE) {
  scheduler.start(broadcast);
  startEventDispatcher();
  // Modules reconcile MUST follow scheduler.start(): upsertSchedule mutates the engine's
  // in-memory list, which is empty (and would be saved over schedules.json) before start.
  // Skipped when passive (single-active-writer: no data/ mutations from a standby twin).
  try { reconcileInstalledModules(); } catch (err) { console.error('[modules] boot reconcile failed:', (err as Error).message); }
}
// Host telemetry is read-only (no persistence, unref'd timer) — not a writer or consumer, so it
// runs in passive too. Otherwise a standby instance reports empty stats and /api/stats is a lie.
statsSampler.start(broadcast);
registerEventRoutes(app, requireAuth);
initPolls({
  broadcast,
  runTurn: ({ prompt, sessionId, uid, userEmail }) =>
    consumeStream(streamChat({ prompt, sessionId, uid, userEmail, mcpServers: getMcpConfig(uid), abortController: new AbortController(), onPermissionRequest: async () => ({ allow: true }) })),
});
// Remote-push triggers: subscribe to schedule.finished and expose turn-done/question
// hooks. isForeground reuses the existing presence tracking (see isUserViewingSession).
initPushTriggers({
  origin: getPublicOrigin(),
  isForeground: (uid, sessionId) => isUserViewingSession(uid, sessionId),
});
// Optional add-ons (voice, github, gmail, fleet, …) mount here through the feature seam.
// The core registers none; an optional add-on calls registerFeature(...) before startup.
// SHRAGA_OVERLAY points at an external add-on module (outside the core tree) that imports
// features.ts and registerFeature(...)s its add-ons at import time. Guarded so a missing/broken
// add-on logs and never crashes the core.
if (process.env.SHRAGA_OVERLAY) {
  try {
    // Resolve relative to CWD (not this module) so a path like ../my-extensions/index.ts works as typed.
    const overlaySpec = path.isAbsolute(process.env.SHRAGA_OVERLAY)
      ? process.env.SHRAGA_OVERLAY
      : path.resolve(process.cwd(), process.env.SHRAGA_OVERLAY);
    await import(overlaySpec);
    console.log(`[overlay] loaded ${process.env.SHRAGA_OVERLAY}`);
  } catch (err) {
    console.error(`[overlay] failed to load ${process.env.SHRAGA_OVERLAY}:`, (err as Error)?.stack || err);
  }
}
// Slack ships in this app — register it through the same feature seam add-ons use.
// Programmatic features register through the same seam an overlay uses — BEFORE mountFeatures()
// so their routes mount ahead of the SPA fallback, identical to the overlay path.
for (const f of __reg.features ?? []) registerFeature(f);
registerFeature(slackFeature);
mountFeatures({ app, requireAuth, broadcast, passive: PASSIVE });
// Fold in feature-contributed sidecar WS proxy routes (the core names none; each add-on adds its own).
Object.assign(WS_PROXY_ROUTES, collectSidecarRoutes());

// SPA fallback — MUST be the last GET route so it never shadows real API/feature/extension routes.
registerSpaCatchAll(app, distPath);

// ── Runtime promotion (blue-green flip) ──────────────────────────────────────
// A passive instance can be promoted to active once traffic has been flipped to it:
// starts every consumer/writer that passive boot skipped. One-way; idempotent-guarded.
let activated = !PASSIVE;
async function activateConsumers() {
  activated = true;
  console.log('[server] ACTIVATING — starting consumers and background writers');
  await dataSync.init();
  syncVendorRepos().catch(err => console.warn('[vendor-sync] error:', (err as Error).message));
  scheduler.start(broadcast);
  startEventDispatcher();
  mountFeatures({ app, requireAuth, broadcast, passive: false });
  // Re-place the SPA catch-all AFTER the promotion's feature mount so newly-added GET routes win.
  registerSpaCatchAll(app, distPath);
  startSidecars().catch(err => console.error('[sidecar] startup error:', err));
  recoverInterruptedSessions().catch(err => console.error('[recovery] failed:', err));
}
app.post('/internal/activate', async (req, res) => {
  const token = req.headers['x-internal-token'] as string | undefined;
  if (!token || token !== process.env.INTERNAL_API_TOKEN) return res.sendStatus(403);
  if (activated) return res.status(409).json({ error: 'already active' });
  await activateConsumers();
  res.json({ ok: true });
});

// Constant-time equality for two strings (avoids leaking length/content via timing).
function safeStrEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// Verify GitHub's HMAC signature (x-hub-signature-256 = "sha256=" + HMAC-SHA256(secret, RAW BODY)).
// Must run over the EXACT bytes GitHub sent, captured as req.rawBody by express.json's verify hook —
// re-serializing req.body would change the bytes and never match.
function validGithubSignature(req: express.Request, secret: string): boolean {
  const header = req.headers['x-hub-signature-256'];
  if (typeof header !== 'string') return false;
  const raw = (req as any).rawBody as Buffer | undefined;
  if (!raw) return false;
  const expected = 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');
  return safeStrEqual(header, expected);
}

// Data-sync webhook, ported to shraga's first-class registerWebhook convention: the framework mounts
// the PUBLIC route, captures rawBody, runs `verify` (the ONLY per-vendor piece — the HMAC below),
// rejects on a falsy result, and on a pass emits the 'data-sync.pull' event. The subscribeEvent below
// (gated on active/non-passive) consumes it and calls dataSync.pull(). Mounted on `app` at the
// SAME position the bespoke route occupied — before the SPA catch-all — via the `path` option, so the
// GitHub webhook needs no reconfig.
//
// Semantic deltas vs the old inline route (documented, deliberate):
//   • bad signature → 400 (was 403): registerWebhook's convention is 400 for any falsy verify. GitHub
//     treats any non-2xx as a failed delivery, so redelivery/behavior is unchanged.
//   • not-activated / data-sync disabled → 200 (was 404): the route now always accepts + emits; the
//     PULL is what's gated. In passive/standby no pull handler is subscribed (single-active-writer),
//     and pull() itself no-ops when disabled — so no data is mutated. The webhook only ever targets
//     the active instance, so the visible-status change is inert in practice.
//   • response no longer awaits the pull: 200 is returned on emit and pull() runs async. This is the
//     convention (and safer — a git pull must not block GitHub's ~10s webhook timeout).
registerWebhook(app, {
  source: 'data-sync.pull',
  path: '/api/data-sync/webhook',
  // Reuse the verified-correct crypto below verbatim — signature-only; activation/enablement gating
  // lives on the pull handler, not here.
  verify: (req) => {
    const secret = process.env.DATA_SYNC_WEBHOOK_SECRET;
    if (!secret) return true; // secret unset → open (current live behavior)
    // Accept EITHER a valid GitHub HMAC signature OR the legacy plain header (backward-compat).
    const plain = req.headers['x-webhook-secret'];
    return validGithubSignature(req, secret) || (typeof plain === 'string' && safeStrEqual(plain, secret));
  },
});

// Consume the verified webhook's event → pull. The PULL is gated on active (non-passive) via the live
// `activated`/`PASSIVE` closure: a passive/standby twin shares DATA_DIR and must NOT mutate data/
// (single-active-writer), and before promotion there's nothing to pull into serving. `activated` flips
// true in activateConsumers(), so a promoted instance starts pulling with no extra wiring. pull() also
// self-no-ops when data-sync is disabled.
subscribeEvent('data-sync.pull', () => {
  if (PASSIVE || !activated) return;
  dataSync.pull().catch((err) => console.error('[data-sync] webhook pull failed:', (err as Error).message));
});

async function runStream(ws: WebSocket, session: WsSession, sid: string, promptText: string, attachments: AttachmentMeta[] | undefined, mcpServers: McpConfig, isSteerRestart = false, conversationReset = false, turnHints?: Record<string, unknown>) {
  const abortController = new AbortController();
  if (!isSteerRestart) {
    if (!acquireSessionLock(sid, 'web', abortController)) {
      console.warn(`[ws] Session ${sid.slice(0, 8)} already locked, rejecting`);
      send(ws, { type: 'error', message: 'Session is already processing a request (from another source)', sessionId: sid });
      session.busySessions.delete(sid);
      return;
    }
  } else {
    replaceSessionLock(sid, 'web', abortController);
  }
  session.abortControllers.set(sid, abortController);
  session.steerPending.delete(sid);
  send(ws, { type: 'session_busy', sessionId: sid, busy: true });
  broadcast({ type: 'session_busy', sessionId: sid, busy: true }, ws);

  // An unattended turn (e.g. a voice-originated one) has nobody watching the UI to click Allow, so
  // auto-approve for the whole run. Generic hint off the opaque bag — the core names no add-on concept.
  const unattended = turnHints?.unattended === true;

  const onPermissionRequest: PermissionHandler = (id, tool, input) => {
    if (session.autoApprove || unattended) {
      console.log(`[ws] Auto-approved ${tool} id=${id}${unattended ? ' (unattended)' : ''}`);
      return Promise.resolve({ allow: true });
    }
    if (ws.readyState !== WebSocket.OPEN) {
      console.log(`[ws] Auto-approved ${tool} id=${id} (client disconnected)`);
      return Promise.resolve({ allow: true });
    }
    return new Promise<{ allow: boolean }>((resolve) => {
      session.pendingPermissions.set(id, { resolve });
      send(ws, { type: 'permission_request', id, tool, input, sessionId: sid });
      console.log(`[ws] Permission request for ${tool} id=${id}`);
    });
  };

  const onUserQuestion: QuestionHandler = (id, questions) => {
    if (ws.readyState !== WebSocket.OPEN) {
      console.log(`[ws] Question id=${id} skipped (client disconnected) — agent self-decides`);
      return Promise.resolve(null);
    }
    try { pushQuestion(getSession(sid)?.uid || session.uid, sid); }
    catch (err) { console.error('[push] question trigger failed:', err); }
    return new Promise<QuestionAnswers | null>((resolve) => {
      session.pendingQuestions.set(id, { resolve });
      send(ws, { type: 'question_request', id, questions, sessionId: sid });
      console.log(`[ws] Question request id=${id} (${questions.length}q)`);
    });
  };

  const isFirstTurn = loadConversation(sid).length === 0;
  let assistantText = '';
  let thinkingText = '';
  const assistantBlocks: ConvBlock[] = [];
  let saved = false;

  const collectPartialBlocks = () => [
    ...assistantBlocks,
    ...(thinkingText ? [{ type: 'thinking' as const, text: thinkingText }] : []),
    ...(assistantText ? [{ type: 'text' as const, text: assistantText }] : []),
  ];

  const flushAssistant = () => {
    if (saved) return;
    saved = true;
    clearPartial(sid);
    if (thinkingText) { assistantBlocks.push({ type: 'thinking', text: thinkingText }); thinkingText = ''; }
    if (assistantText) assistantBlocks.push({ type: 'text', text: assistantText });
    if (assistantBlocks.length === 0) return;
    appendMessage(sid, { id: crypto.randomUUID(), role: 'assistant', blocks: assistantBlocks });
    console.log(`[ws] Saved assistant (${assistantBlocks.length} blocks) for ${sid.slice(0, 8)}`);
  };

  registerLivePartial(sid, collectPartialBlocks);
  const partialInterval = setInterval(() => {
    const blocks = collectPartialBlocks();
    if (blocks.length) writePartial(sid, blocks);
  }, 5_000);

  resetRetryCount(sid);
  setRunStatus(sid, 'running', 'web');

  let stopReason = '';
  try {
    let eventCount = 0;
    for await (const event of streamChat({
      prompt: promptText,
      attachments,
      sessionId: sid,
      uid: session.uid,
      userEmail: session.email,
      userName: session.email.split('@')[0],
      mcpServers,
      abortController,
      conversationReset,
      turnHints,
      context: { source: 'web', user: session.email },
      onPermissionRequest,
      onUserQuestion,
      onDestructiveApproval: (id, tool, input) => {
        if (unattended) {
          console.log(`[ws] Auto-approved destructive ${tool} id=${id} (unattended)`);
          return Promise.resolve({ allow: true });
        }
        return new Promise<{ allow: boolean }>((resolve) => {
          const ttl = ws.readyState !== WebSocket.OPEN ? DESTRUCTIVE_PERMISSION_TTL : undefined;
          session.pendingPermissions.set(id, { resolve, destructive: true, tool, input, sessionId: sid });
          if (ws.readyState === WebSocket.OPEN) {
            send(ws, { type: 'permission_request', id, tool, input, sessionId: sid });
          } else {
            globalPendingPermissions.set(id, { resolve, sessionId: sid, tool, input, uid: session.uid });
          }
          if (ttl) setTimeout(() => {
            if (globalPendingPermissions.delete(id)) {
              console.log(`[ws] Destructive ${tool} id=${id} denied after TTL (client didn't reconnect)`);
              resolve({ allow: false });
            }
          }, ttl);
          console.log(`[ws] Destructive op approval required for ${tool} id=${id}${ws.readyState !== WebSocket.OPEN ? ` (queued for reconnect, ${ttl! / 1000}s TTL)` : ''}`);
        });
      },
    })) {
      eventCount++;
      if (event.type !== 'done' && event.type !== 'error') send(ws, { ...event, sessionId: sid });

      if (event.type === 'thinking_delta') {
        thinkingText += event.text;
        broadcast({ type: 'session_stream', sessionId: sid, event: { type: 'thinking_delta', text: event.text } }, ws);
      } else if (event.type === 'text_delta') {
        if (thinkingText) { assistantBlocks.push({ type: 'thinking', text: thinkingText }); thinkingText = ''; }
        assistantText += event.text;
        broadcast({ type: 'session_stream', sessionId: sid, event: { type: 'text_delta', text: event.text } }, ws);
      } else if (event.type === 'tool_use') {
        if (thinkingText) { assistantBlocks.push({ type: 'thinking', text: thinkingText }); thinkingText = ''; }
        if (assistantText) {
          assistantBlocks.push({ type: 'text', text: assistantText });
          assistantText = '';
        }
        assistantBlocks.push({ type: 'tool_use', tool: event.tool, toolUseId: event.toolUseId, input: event.input });
        broadcast({ type: 'session_stream', sessionId: sid, event: { type: 'tool_use', tool: event.tool, toolUseId: event.toolUseId, input: event.input } }, ws);
        const artifactEvent = handleArtifactToolUse(sid, event.tool, event.input);
        if (artifactEvent) send(ws, artifactEvent);
      } else if (event.type === 'tool_use_input') {
        const existing = assistantBlocks.find((b: any) => b.type === 'tool_use' && b.toolUseId === event.toolUseId) as any;
        if (existing) existing.input = event.input;
        broadcast({ type: 'session_stream', sessionId: sid, event: { type: 'tool_use_input', toolUseId: event.toolUseId, input: event.input } }, ws);
        if (existing?.tool) {
          const artifactEvent = handleArtifactToolUse(sid, existing.tool, event.input);
          if (artifactEvent) send(ws, artifactEvent);
        }
      } else if (event.type === 'tool_result') {
        assistantBlocks.push({ type: 'tool_result', toolUseId: event.toolUseId, output: event.output });
        broadcast({ type: 'session_stream', sessionId: sid, event: { type: 'tool_result', toolUseId: event.toolUseId, output: event.output } }, ws);
      } else if (event.type === 'tool_result_image') {
        assistantBlocks.push({ type: 'image', src: event.dataUrl });
        broadcast({ type: 'session_stream', sessionId: sid, event: { type: 'tool_result_image', toolUseId: event.toolUseId, dataUrl: event.dataUrl } }, ws);
      } else if (event.type === 'done') {
        stopReason = event.stopReason ?? 'end_turn';
        if (stopReason === 'max_turns_reached') {
          assistantBlocks.push({ type: 'text', text: '\n\n---\n⚠️ Reached the maximum number of steps for this turn. Send "continue" to pick up where I left off.' });
        }
        if (!assistantText && !thinkingText && assistantBlocks.length === 0 && !event.builtinHandled) {
          const fallback = '⚠️ No response was generated. Try rephrasing or sending again.';
          assistantText = fallback;
          send(ws, { type: 'text_delta', text: fallback, sessionId: sid });
          broadcast({ type: 'session_stream', sessionId: sid, event: { type: 'text_delta', text: fallback } }, ws);
        }
        flushAssistant();
        console.log(`[ws] Done for ${session.email}: sessionId=${sid.slice(0, 8)} events=${eventCount} stopReason=${stopReason}`);
        upsertSession(sid, promptText, { uid: session.uid, email: session.email });
        send(ws, { type: 'done', sessionId: sid, stopReason });
        broadcast({ type: 'session_messages_changed', sessionId: sid }, ws);

        // Notify owner if they're not viewing this session
        const meta = getSession(sid);
        const preview = assistantText.slice(0, 120) || '(completed)';
        notifyUnread(session.uid, sid, preview, 'response', meta?.title, ws);

        // Generate a better title after first turn
        if (isFirstTurn && assistantText) {
          generateSessionTitle(sid, promptText, assistantText).then((title) => {
            if (title) {
              send(ws, { type: 'session_title_updated', sessionId: sid, title });
              broadcast({ type: 'session_title_updated', sessionId: sid, title }, ws);
            }
          });
        }
        break;
      } else if (event.type === 'error') {
        if (session.steerPending.has(sid)) {
          console.log(`[ws] Suppressing error during steer for ${sid.slice(0, 8)}`);
        } else {
          console.error(`[ws] Error event for ${session.email}: ${event.message}`);
          // Persist alongside whatever partial output the turn produced — flushAssistant() saves it.
          if (thinkingText) { assistantBlocks.push({ type: 'thinking', text: thinkingText }); thinkingText = ''; }
          if (assistantText) { assistantBlocks.push({ type: 'text', text: assistantText }); assistantText = ''; }
          assistantBlocks.push({ type: 'error', text: event.message });
          send(ws, { type: 'error', message: event.message, sessionId: sid });
        }
        break;
      }
    }
    if (eventCount === 0) {
      console.warn(`[ws] Stream yielded 0 events for ${session.email}`);
      send(ws, { type: 'error', message: 'No response from agent — check server logs', sessionId: sid });
    }
  } catch (err: any) {
    if (session.steerPending.has(sid)) {
      console.log(`[ws] Stream aborted for steer in ${sid.slice(0, 8)}`);
    } else {
      stopReason = 'error';
      const msg = err.message || String(err);
      console.error(`[ws] Stream error for ${session.email}:`, msg);
      // Flush partial output first — flushAssistant() appends it in the finally, which would
      // otherwise order the failure ahead of the text it followed.
      if (thinkingText) { assistantBlocks.push({ type: 'thinking', text: thinkingText }); thinkingText = ''; }
      if (assistantText) { assistantBlocks.push({ type: 'text', text: assistantText }); assistantText = ''; }
      assistantBlocks.push({ type: 'error', text: msg });
      send(ws, { type: 'error', message: msg, sessionId: sid });
    }
  } finally {
    clearInterval(partialInterval);
    unregisterLivePartial(sid);
    flushAssistant();
    session.abortControllers.delete(sid);

    const steerText = session.steerPending.get(sid);
    session.steerPending.delete(sid);
    if (steerText) {
      appendMessage(sid, { id: crypto.randomUUID(), role: 'user', blocks: [{ type: 'text', text: steerText }], channel: 'web', senderName: session.email.split('@')[0] });
      console.log(`[ws] Restarting stream with steer for ${sid.slice(0, 8)}`);
      // Preserve the turn hints (e.g. unattended auto-approve) across a steer-restart, else auto-approve is lost mid-turn and prompts hang.
      await runStream(ws, session, sid, steerText, undefined, mcpServers, true, false, turnHints);
      return;
    }

    releaseSessionLock(sid);
    const okReasons = ['', 'end_turn', 'success'];
    const resolvedStop = stopReason === 'max_turns_reached' ? 'max_turns_reached'
      : (!okReasons.includes(stopReason)) ? 'error' : undefined;
    setRunStatus(sid, 'idle', undefined, resolvedStop);
    session.busySessions.delete(sid);
    broadcast({ type: 'session_busy', sessionId: sid, busy: false });
    // Turn-done remote push (owner only; suppressed if they're foregrounding this session).
    try { pushTurnDone(getSession(sid)?.uid || session.uid, sid); }
    catch (err) { console.error('[push] turn-done trigger failed:', err); }
    for (const [id, perm] of globalPendingPermissions) {
      if (perm.sessionId === sid) globalPendingPermissions.delete(id);
    }
  }
}

function handleConnection(ws: WebSocket, session: WsSession) {
  console.log('[ws] New connection');

  // Tolerate ONE missed pong before terminating (~2 intervals of grace) — see the ws-proxy keepalive note:
  // a 1-strike policy force-closed backgrounded/frozen mobile clients every 30s, triggering reconnect churn
  // (and, paired with an OS tab-discard, the reload + "Verifying" + sidecar re-attach the user saw).
  let missedPongs = 0;
  ws.on('pong', () => { missedPongs = 0; });
  const pingInterval = setInterval(() => {
    if (missedPongs >= 2) { console.warn(`[ws] client missed pongs — terminating (${session.email || 'unauth'})`); ws.terminate(); return; }
    missedPongs++;
    ws.ping();
  }, WS_PING_INTERVAL);

  ws.on('message', async (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return send(ws, { type: 'error', message: 'Invalid JSON' });
    }

    if (msg.type === 'auth') {
      try {
        const user = await verifyBearer(msg.token); // pluggable (local|firebase), not firebase-only
        session.uid = user.uid;
        session.email = user.email;
        session.autoApprove = getAutoApprove(user.uid);
        console.log(`[ws] Authenticated: ${user.email} (${user.uid}) autoApprove=${session.autoApprove}`);
        send(ws, { type: 'auth_ok', uid: user.uid, email: user.email, buildId: SERVER_BUILD_ID });
        activeConnections.set(ws, session);
        sendUnreadSync(ws, user.uid);
        // Re-send any orphaned permission requests waiting for this user
        for (const [id, perm] of globalPendingPermissions) {
          if (perm.uid === user.uid) {
            session.pendingPermissions.set(id, { resolve: perm.resolve, destructive: true });
            send(ws, { type: 'permission_request', id, tool: perm.tool, input: perm.input, sessionId: perm.sessionId });
            globalPendingPermissions.delete(id);
            console.log(`[ws] Re-sent orphaned permission ${id} (${perm.tool}) to reconnected ${user.email}`);
          }
        }
      } catch (err: any) {
        console.error(`[ws] Auth failed:`, err.message);
        send(ws, { type: 'auth_error', message: err.message });
        ws.close();
      }
      return;
    }

    if (!session.uid) return send(ws, { type: 'error', message: 'Not authenticated' });

    if (msg.type === 'permission_response') {
      if (msg.allowAll) {
        session.autoApprove = true;
        setAutoApprove(session.uid, true);
        console.log(`[ws] Auto-approve enabled and persisted for ${session.email}`);
      }
      const entry = session.pendingPermissions.get(msg.id);
      if (entry) {
        session.pendingPermissions.delete(msg.id);
        entry.resolve({ allow: !!msg.allow });
      }
      return;
    }

    if (msg.type === 'question_response') {
      const entry = session.pendingQuestions.get(msg.id);
      if (entry) {
        session.pendingQuestions.delete(msg.id);
        entry.resolve((msg.answers as QuestionAnswers) ?? null);
        console.log(`[ws] Question ${msg.id} answered`);
      }
      return;
    }

    if (msg.type === 'presence') {
      session.viewingSessionId = msg.sessionId || null;
      session.focused = !!msg.focused;
      return;
    }

    // Native wrapper foreground signal (push suppression). Reuses the same presence
    // fields so triggers' isUserViewingSession() sees a native client like a web one.
    if (msg.type === 'client_presence') {
      session.viewingSessionId = msg.visible ? (msg.sessionId || null) : null;
      session.focused = !!msg.visible;
      return;
    }

    if (msg.type === 'mark_read') {
      const sid = msg.sessionId;
      if (sid) {
        markUnread(session.uid, sid);
        for (const [otherWs, s] of activeConnections) {
          if (s.uid === session.uid && otherWs !== ws) {
            send(otherWs, { type: 'unread_cleared', sessionId: sid });
          }
        }
      }
      return;
    }

    if (msg.type === 'steer') {
      const steerSid = msg.sessionId || session.lastSessionId;
      if (!steerSid) return;
      const localAc = session.abortControllers.get(steerSid);
      const globalAc = !localAc ? getSessionAbortController(steerSid) : null;
      const ac = localAc || globalAc;
      if (!ac) return;
      const steerText = msg.text ?? '';
      console.log(`[ws] Steer from ${session.email}: "${steerText.slice(0, 80)}" session=${steerSid.slice(0, 8)}`);
      if (localAc) {
        session.steerPending.set(steerSid, steerText);
        ac.abort();
      } else {
        ac.abort();
        appendMessage(steerSid, { id: crypto.randomUUID(), role: 'user', blocks: [{ type: 'text', text: steerText }], channel: 'web', senderName: session.email.split('@')[0] });
        console.log(`[ws] External steer takeover for ${steerSid.slice(0, 8)}`);
        session.busySessions.add(steerSid);
        session.lastSessionId = steerSid;
        runStream(ws, session, steerSid, steerText, undefined, getMcpConfig(session.uid), true);
      }
      return;
    }

    if (msg.type === 'message') {
      if (_draining) return send(ws, { type: 'error', message: 'Server is restarting — please retry in a moment' });
      let sid = msg.sessionId || crypto.randomUUID();
      const wantsFork = typeof msg.truncateAt === 'number' && msg.truncateAt >= 0 && (session.busySessions.has(sid) || isSessionLocked(sid));
      if (!wantsFork && (session.busySessions.has(sid) || isSessionLocked(sid))) return send(ws, { type: 'error', message: 'Already processing a request', sessionId: sid });
      if (!wantsFork) session.busySessions.add(sid);
      const mcpServers = getMcpConfig(session.uid);
      // Opaque per-send bag from the client's send-options slot. The core forwards it verbatim to the
      // turn-context/engine seams and interprets no add-on key (a plain object only — never an array/primitive).
      const turnHints = msg.turnHints && typeof msg.turnHints === 'object' && !Array.isArray(msg.turnHints)
        ? (msg.turnHints as Record<string, unknown>) : undefined;
      // Ephemeral user turn (generic hint): a synthetic, add-on-originated opener (e.g. a voice greeting).
      // Run it, but DON'T persist it as a user message — the reply is the real turn, not a user turn.
      const ephemeralUser = turnHints?.ephemeralUser === true;
      const promptText = msg.text ?? '';
      session.lastSessionId = sid;
      session.viewingSessionId = sid;
      session.focused = true;
      const isNew = !msg.sessionId;
      if (isNew) {
        upsertSession(sid, promptText, { uid: session.uid, email: session.email });
        send(ws, { type: 'session_id', sessionId: sid });
        // Immediate prompt-derived title so the tab renames off "New Chat" now; the LLM title refines it later.
        const t0 = getSession(sid)?.title;
        if (t0) send(ws, { type: 'session_title_updated', sessionId: sid, title: t0 });
        console.log(`[ws] New session ${sid.slice(0, 8)} for ${session.email}`);
      }

      console.log(`[ws] Message from ${session.email}: "${promptText.slice(0, 100)}" session=${sid.slice(0, 8)}`);

      // Truncate or fork conversation if replaying/editing a previous message
      if (typeof msg.truncateAt === 'number' && msg.truncateAt >= 0) {
        if (wantsFork) {
          // Session is busy — fork instead of destructive truncate to avoid race conditions
          let forkedId: string | null = null;
          if (msg.truncateAt > 0) {
            // forkSession truncateAtIndex is inclusive (slices to index+1), truncateAt is message count to keep
            forkedId = forkSession(sid, { uid: session.uid, email: session.email, name: session.email.split('@')[0] }, msg.truncateAt - 1);
          }
          if (!forkedId) {
            // truncateAt=0 (restart from scratch) or forkSession failed — create a fresh session
            forkedId = crypto.randomUUID();
            upsertSession(forkedId, promptText, { uid: session.uid, email: session.email });
          }
          console.log(`[ws] Forked busy session ${sid.slice(0, 8)} → ${forkedId.slice(0, 8)} (truncateAt=${msg.truncateAt})`);
          session.busySessions.add(forkedId);
          sid = forkedId;
          session.lastSessionId = forkedId;
          send(ws, { type: 'forked', sourceSessionId: msg.sessionId, sessionId: forkedId });
        } else {
          const existing = loadConversation(sid);
          saveConversation(sid, existing.slice(0, msg.truncateAt));
          console.log(`[ws] Truncated conversation ${sid.slice(0, 8)} to ${msg.truncateAt} messages`);
        }
      }

      // Save user message to disk immediately
      const attachments: AttachmentMeta[] = msg.attachments ?? [];
      const attBlocks: ConvBlock[] = attachments.map((a: any) =>
        a.mimeType.startsWith('image/')
          ? { type: 'image' as const, src: a.url }
          : { type: 'file' as const, src: a.url, name: a.name, mimeType: a.mimeType }
      );
      if (!ephemeralUser) appendMessage(sid, { id: crypto.randomUUID(), role: 'user', blocks: [...attBlocks, { type: 'text', text: promptText }], channel: 'web', senderName: session.email.split('@')[0] });

      const wasReset = typeof msg.truncateAt === 'number' && msg.truncateAt >= 0;
      await runStream(ws, session, sid, promptText, attachments, mcpServers, false, wasReset, turnHints);
    }

    if (msg.type === 'interruption_marker') {
      const sid = msg.sessionId || session.lastSessionId;
      if (sid && msg.revealedText) {
        const tail = msg.revealedText.length > 120
          ? '…' + msg.revealedText.slice(-120)
          : msg.revealedText;
        appendMessage(sid, {
          id: crypto.randomUUID(),
          role: 'system',
          blocks: [{ type: 'text', text: `[User interrupted playback — only heard up to: "${tail}"]` }],
        });
      }
    }

    if (msg.type === 'cancel') {
      const cancelSid = msg.sessionId || session.lastSessionId;
      if (!cancelSid) return;
      const localAc = session.abortControllers.get(cancelSid);
      const globalAc = getSessionAbortController(cancelSid);
      const ac = localAc || globalAc;
      if (ac) {
        console.log(`[ws] Cancel requested by ${session.email} session=${cancelSid.slice(0, 8)}`);
        ac.abort();
        session.abortControllers.delete(cancelSid);
      }
      session.busySessions.delete(cancelSid);
    }
  });

  ws.on('close', () => {
    clearInterval(pingInterval);
    console.log(`[ws] Disconnected: ${session.email || 'unauthenticated'}`);
    activeConnections.delete(ws);
    // Don't abort running processes — let them finish and save results.
    // Auto-approve regular permissions; queue destructive ones for reconnect.
    for (const [id, entry] of session.pendingPermissions) {
      if (entry.destructive && entry.tool && entry.sessionId) {
        globalPendingPermissions.set(id, { resolve: entry.resolve, sessionId: entry.sessionId, tool: entry.tool, input: entry.input, uid: session.uid });
        setTimeout(() => {
          if (globalPendingPermissions.delete(id)) {
            console.log(`[ws] Destructive ${entry.tool} id=${id} denied after TTL (client didn't reconnect)`);
            entry.resolve({ allow: false });
          }
        }, DESTRUCTIVE_PERMISSION_TTL);
        console.log(`[ws] Destructive permission ${id} (${entry.tool}) queued for reconnect (${DESTRUCTIVE_PERMISSION_TTL / 1000}s TTL)`);
      } else {
        console.log(`[ws] Auto-approving orphaned permission ${id} (client disconnected)`);
        entry.resolve({ allow: true });
      }
    }
    session.pendingPermissions.clear();
    // Orphaned questions: resolve null so the agent proceeds with its own judgement.
    for (const [id, entry] of session.pendingQuestions) {
      console.log(`[ws] Resolving orphaned question ${id} as null (client disconnected)`);
      entry.resolve(null);
    }
    session.pendingQuestions.clear();
    session.abortControllers.clear();
  });

  ws.on('error', (err) => console.error(`[ws] Error (${session.email}):`, err.message));
}

// ── Deploy recovery ──────────────────────────────────────────────────────────

async function retryWebSession(session: SessionMeta, prompt: string) {
  const sid = session.sessionId;
  console.log(`[recovery] retrying web session ${sid.slice(0, 8)}`);
  const recoveryAc = new AbortController();
  if (!acquireSessionLock(sid, 'web', recoveryAc)) {
    console.warn(`[recovery] session ${sid.slice(0, 8)} already locked, skipping`);
    return;
  }
  setRunStatus(sid, 'running', 'web');
  broadcast({ type: 'session_busy', sessionId: sid, busy: true });

  try {
    let assistantText = '';
    const assistantBlocks: ConvBlock[] = [];
    const collectPartial = () => [
      ...assistantBlocks,
      ...(assistantText ? [{ type: 'text' as const, text: assistantText }] : []),
    ];
    registerLivePartial(sid, collectPartial);
    for await (const ev of streamChat({
      prompt,
      sessionId: sid,
      uid: session.uid,
      userEmail: session.userEmail,
      userName: session.userName || session.userEmail.split('@')[0],
      mcpServers: getMcpConfig(session.uid),
      abortController: recoveryAc,
      context: { source: 'web', user: session.userEmail },
      onPermissionRequest: async () => ({ allow: true }),
    })) {
      if (ev.type === 'text_delta') {
        assistantText += ev.text;
        broadcast({ type: 'session_stream', sessionId: sid, event: { type: 'text_delta', text: ev.text } });
      } else if (ev.type === 'tool_use') {
        if (assistantText) { assistantBlocks.push({ type: 'text', text: assistantText }); assistantText = ''; }
        assistantBlocks.push({ type: 'tool_use', tool: ev.tool, toolUseId: ev.toolUseId, input: ev.input });
        broadcast({ type: 'session_stream', sessionId: sid, event: { type: 'tool_use', tool: ev.tool, toolUseId: ev.toolUseId, input: ev.input } });
      } else if (ev.type === 'tool_use_input') {
        const existing = assistantBlocks.find((b: any) => b.type === 'tool_use' && b.toolUseId === ev.toolUseId) as any;
        if (existing) existing.input = ev.input;
        broadcast({ type: 'session_stream', sessionId: sid, event: { type: 'tool_use_input', toolUseId: ev.toolUseId, input: ev.input } });
      } else if (ev.type === 'tool_result') {
        assistantBlocks.push({ type: 'tool_result', toolUseId: ev.toolUseId, output: ev.output });
      } else if (ev.type === 'tool_result_image') {
        assistantBlocks.push({ type: 'image', src: ev.dataUrl });
        broadcast({ type: 'session_stream', sessionId: sid, event: { type: 'tool_result_image', toolUseId: ev.toolUseId, dataUrl: ev.dataUrl } });
      } else if (ev.type === 'done') {
        break;
      } else if (ev.type === 'error') {
        if (assistantText) { assistantBlocks.push({ type: 'text', text: assistantText }); assistantText = ''; }
        assistantBlocks.push({ type: 'error', text: ev.message });
        break;
      }
    }
    if (assistantText) assistantBlocks.push({ type: 'text', text: assistantText });
    if (assistantBlocks.length) {
      appendMessage(sid, { id: crypto.randomUUID(), role: 'assistant', blocks: assistantBlocks });
      broadcast({ type: 'session_messages_changed', sessionId: sid });
      const errBlock = assistantBlocks.find((b) => b.type === 'error');
      const preview = assistantText.slice(0, 120)
        || (errBlock?.type === 'error' ? `⚠️ ${errBlock.text}`.slice(0, 120) : '(completed)');
      notifyUnread(session.uid, sid, preview, 'response', session.title);
    }
  } catch (err: any) {
    console.error(`[recovery] web session error ${sid.slice(0, 8)}:`, err.message);
  } finally {
    unregisterLivePartial(sid);
    if (releaseSessionLock(sid, recoveryAc)) {
      setRunStatus(sid, 'idle');
      broadcast({ type: 'session_busy', sessionId: sid, busy: false });
    }
  }
}

async function recoverInterruptedSessions() {
  const interrupted = getRunningSessions();
  if (!interrupted.length) return;
  console.log(`[recovery] Found ${interrupted.length} interrupted session(s)`);

  for (const s of interrupted) {
    // Scheduler sessions: resume in-place on the SAME conversation (symmetric with web/slack),
    // instead of marking error and letting startup catch-up spawn a fresh convo — that re-fire
    // produced duplicate side-effects (e.g. a second Slack post).
    if (s.runOrigin === 'scheduler') {
      const partialBlocks = readPartial(s.sessionId);
      clearPartial(s.sessionId);
      const partialTexts = partialBlocks?.filter(b => b.type === 'text').map(b => (b as any).text) ?? [];

      // Bail to the old mark-error path if we can't resume safely:
      // no schedule id to re-run, or we've already retried this run twice.
      const canResume = !!s.scheduleId && (s.runRetryCount ?? 0) < 2;
      if (!canResume) {
        if (partialTexts.length) {
          appendMessage(s.sessionId, {
            id: crypto.randomUUID(),
            role: 'assistant',
            blocks: [{ type: 'text', text: partialTexts.join('\n') + '\n\n[...interrupted by server restart]' }],
          });
        }
        setRunStatus(s.sessionId, 'idle');
        updateScheduledSessionStatus(s.sessionId, 'error');
        if (s.scheduleId) scheduler.clearRunningMarker(s.scheduleId);
        console.log(`[recovery] scheduler session ${s.sessionId.slice(0, 8)} (${s.scheduleId ?? '?'}) — not resumable (no schedule / retries exhausted), marked error`);
        continue;
      }

      incrementRetryCount(s.sessionId);
      // Preserve the partial response with a cutoff marker, then continue in-place.
      const cutoff = partialTexts.length
        ? partialTexts.join('\n') + '\n\n[...response interrupted by server restart]'
        : '[...response interrupted by server restart]';
      appendMessage(s.sessionId, {
        id: crypto.randomUUID(),
        role: 'assistant',
        blocks: [{ type: 'text', text: cutoff }],
      });
      const resumePrompt = 'Your previous response was cut off by a server restart. The partial response has been preserved above. Continue from where you left off, and avoid repeating any side-effects (e.g. messages already sent) that may have completed before the interruption.';
      setRunStatus(s.sessionId, 'idle');
      scheduler.resumeRun(s.scheduleId!, s.sessionId, resumePrompt);
      console.log(`[recovery] resuming scheduler session ${s.sessionId.slice(0, 8)} (${s.scheduleId}) in-place`);
      continue;
    }

    if (s.sessionId.startsWith('api-')) {
      console.log(`[recovery] Skip API session ${s.sessionId.slice(0, 12)} — no user waiting`);
      setRunStatus(s.sessionId, 'idle');
      continue;
    }

    if ((s.runRetryCount ?? 0) >= 2) {
      console.log(`[recovery] Skip ${s.sessionId.slice(0, 8)} — max retries reached`);
      const partialBlocks = readPartial(s.sessionId);
      clearPartial(s.sessionId);
      const partialTexts = partialBlocks?.filter(b => b.type === 'text').map(b => (b as any).text) ?? [];
      appendMessage(s.sessionId, {
        id: crypto.randomUUID(),
        role: 'assistant',
        blocks: [{ type: 'text', text: (partialTexts.length ? partialTexts.join('\n') + '\n\n' : '') + '[Interrupted by server restart — please send a message to continue]' }],
      });
      setRunStatus(s.sessionId, 'idle');
      continue;
    }

    const conv = loadConversation(s.sessionId);
    const lastUser = [...conv].reverse().find(m =>
      m.role === 'user' && m.blocks.some(b => b.type === 'text' && !b.text.startsWith('[Resumed'))
    );
    const originalPrompt = lastUser?.blocks.find(b => b.type === 'text')?.text;
    if (!originalPrompt) {
      setRunStatus(s.sessionId, 'idle');
      continue;
    }

    incrementRetryCount(s.sessionId);

    // Recover partial assistant response saved before crash
    const partialBlocks = readPartial(s.sessionId);
    clearPartial(s.sessionId);

    let prompt: string;
    if (partialBlocks?.length) {
      const partialTexts = partialBlocks.filter(b => b.type === 'text').map(b => (b as any).text);
      const cutoffText = partialTexts.length
        ? partialTexts.join('\n') + '\n\n[...response interrupted by server restart]'
        : '[...response interrupted by server restart]';
      appendMessage(s.sessionId, {
        id: crypto.randomUUID(),
        role: 'assistant',
        blocks: [{ type: 'text', text: cutoffText }],
      });
      prompt = 'Your previous response was cut off by a server restart. The partial response has been preserved above. Continue from where you left off.';
      console.log(`[recovery] Restored partial response (${partialBlocks.length} blocks) for ${s.sessionId.slice(0, 8)}`);
    } else {
      appendMessage(s.sessionId, {
        id: crypto.randomUUID(),
        role: 'user',
        blocks: [{ type: 'text', text: '[Resumed after server restart]' }],
      });
      prompt = originalPrompt;
    }

    if (s.runOrigin === 'slack') {
      if (!resumeFeatureSession('slack', s, prompt)) {
        console.warn(`[recovery] slack feature not available to resume ${s.sessionId.slice(0, 8)}`);
        setRunStatus(s.sessionId, 'idle');
      }
    } else {
      retryWebSession(s, prompt).catch(err => console.error(`[recovery] web retry failed:`, err.message));
    }
  }

  // Periodic sweep: clean up scheduler sessions not tracked by the engine
  const orphanSweep = setInterval(() => {
    const stillRunning = getRunningSessions().filter(s => s.runOrigin === 'scheduler');
    if (!stillRunning.length) { clearInterval(orphanSweep); return; }
    const engineRunning = new Set(scheduler.getRunningIds());
    for (const s of stillRunning) {
      if (s.scheduleId && engineRunning.has(s.scheduleId)) continue;
      console.log(`[recovery] orphaned scheduler session ${s.sessionId.slice(0, 30)}… — not in engine, marking idle/error`);
      setRunStatus(s.sessionId, 'idle');
      updateScheduledSessionStatus(s.sessionId, 'error');
    }
  }, 30_000);
}

let _draining = false;

async function gracefulShutdown(signal: string, opts: { exit?: boolean } = {}) {
  const exit = opts.exit ?? true;
  if (_draining) return;
  _draining = true;
  console.log(`[server] ${signal} — draining (up to 90s)…`);
  setShuttingDown();
  stopSidecars();

  for (const ws of activeConnections.keys()) send(ws, { type: 'server_restarting' });

  // Agent turns routinely run for minutes; give in-flight streams time to finish before we force-kill
  // their Claude Code child processes (which would otherwise surface as `exited with code 143`).
  // Keep this under the service manager's stop timeout (e.g. systemd TimeoutStopSec) so the drain wins, not SIGKILL.
  // Drain on the LIVE lock count, not the persisted index: setRunStatus freezes `running` in the
  // index at shutdown (the crash-recovery marker), so index entries can never go idle mid-drain —
  // polling the index made every restart with an active session (or a stale marker from a prior
  // crash) sit out the full 90s.
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const running = getActiveLockCount();
    if (running === 0) break;
    console.log(`[server] waiting for ${running} active stream(s)…`);
    await new Promise((r) => setTimeout(r, 2000));
  }

  console.log(`[server] drain complete — ${getActiveLockCount()} stream(s) still active, closing`);

  for (const [ws, session] of activeConnections) {
    for (const ac of session.abortControllers.values()) ac.abort();
    ws.close();
  }

  // Optional engines that hold OS resources (warm subprocesses, h2 connections) register their own
  // teardown on SIGTERM/SIGINT from the overlay — the core names none of them here.

  // Exit 0 on the fallback too: by this point we've drained and aborted cleanly, so a slow
  // server.close() is not a failure. Exiting 1 here made systemd log `status=1/FAILURE` on every
  // normal restart — a false alarm. (Restart=always brings us back regardless of code.)
  // Library embedders call stop() (exit:false): close the sockets but leave the host process alive.
  if (!exit) {
    wss.close();
    sidecarWss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return;
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000);
}

// Install process-level signal handlers for the standalone server/CLI path (default). A pure
// library embedder that owns its own lifecycle sets SHRAGA_INSTALL_SIGNALS=0 and uses handle.stop().
if (process.env.SHRAGA_INSTALL_SIGNALS !== '0') {
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM').catch((e) => { console.error('[server] shutdown error:', e); process.exit(1); }));
  process.on('SIGINT', () => gracefulShutdown('SIGINT').catch((e) => { console.error('[server] shutdown error:', e); process.exit(1); }));
}

// ── Start ─────────────────────────────────────────────────────────────────────

// Kill orphaned vendor MCP processes from a previous server crash.
// Only targets processes reparented to init (ppid=1) — safe for multi-tenant.
try {
  const out = execSync(
    "pgrep -f 'vendor/mcp-.*--stdio' | xargs -I{} sh -c 'ppid=$(ps -o ppid= -p {} 2>/dev/null | tr -d \" \"); [ \"$ppid\" = \"1\" ] && echo {}' 2>/dev/null || true",
    { encoding: 'utf-8' },
  ).trim();
  if (out) {
    const pids = out.split('\n').filter(Boolean).map(Number);
    console.log(`[server] killing ${pids.length} orphaned vendor MCP process(es): ${pids.join(',')}`);
    for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch {} }
  }
} catch {}

const PORT = Number(process.env.PORT) || 3032;
await new Promise<void>((resolve) => {
  server.listen(PORT, () => {
    console.log(`[server] Running on http://0.0.0.0:${PORT}`);
    resolve();
    if (PASSIVE) return; // no sidecars, recovery, or MCP warmers in passive mode
    startSidecars().catch(err => console.error('[sidecar] startup error:', err));
    recoverInterruptedSessions().catch(err => console.error('[recovery] failed:', err));
    // The disk MCP catalog is warmed off the turn path by whichever engine consumes it — the CE default
    // (Claude Code) hands MCP servers straight to its SDK and needs no catalog. An add-on engine that
    // uses the shared catalog registers its own boot/interval warm-up through the overlay.
  });
});

// OPT-IN post-start plug-and-play. Only extensions/webhooks/events are runtime-safe (they mount on
// the persistent extRouter / in-process bus); features & engines mount at boot and are NOT re-entrant.
const RT_FLAG = process.env.SHRAGA_RUNTIME_REGISTRATION;
const RUNTIME_REG = RT_FLAG === '1' || RT_FLAG === 'true';
const runtimeGuard = (what: string) => {
  if (!RUNTIME_REG) throw new Error(
    `[shraga] ${what}() at runtime is disabled. Enable it with createShraga({ runtimeRegistration: true }) ` +
    `(or SHRAGA_RUNTIME_REGISTRATION=1) before start().`,
  );
};

return {
  app,
  server,
  port: PORT,
  url: `http://localhost:${PORT}`,
  emitEvent,
  registerExtension: (fn) => { runtimeGuard('registerExtension'); return registerExtension(fn); },
  // A webhook is just an extension that mounts a verified route on the extension Router — reuse the seam.
  registerWebhook: (opts) => { runtimeGuard('registerWebhook'); return registerExtension((_r, ctx) => { ctx.registerWebhook(opts); }); },
  on: (source, handler) => { runtimeGuard('on'); return subscribeEvent(source, handler); },
  stop: () => gracefulShutdown('stop', { exit: false }),
};

}