import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Application, Request, Response } from 'express';
import type { McpConfig, McpServerConfig } from './mcp.ts';
import { DATA_DIR } from './paths.ts';
import { offloadEnv } from './offload.ts';

/**
 * Shared stdio-MCP pool.
 *
 * Without it every agent turn makes the Claude Code CLI spawn its own copy of every stdio MCP server
 * (dozens of bun processes per turn). Concurrent turns multiply that, and a server that loses the CPU
 * race misses the CLI's 30s connect timeout and is simply absent for the turn.
 *
 * With it, each distinct stdio config runs as ONE long-lived child owned by the server, started lazily
 * on the first real call and reaped when idle. Turns reach it over loopback streamable-HTTP
 * (`/mcp-pool/:key`). `initialize` and the list methods are answered from a disk cache, so a turn's
 * connect handshake costs no process at all; only a `tools/call` (or uncached request) spawns.
 *
 * Keyed by a hash of the fully-resolved config (command, args, cwd, env), so per-user overlays that
 * resolve differently get their own instance and nothing is shared across differing credentials.
 * Children inherit the server's env plus their own `env` block (what a full-access turn's CLI hands
 * them today, minus the per-session SHRAGA_* vars, which no stdio MCP reads).
 */

type Json = any;
interface StdioCfg { command: string; args?: string[]; env?: Record<string, string>; cwd?: string }

const PROTOCOL_VERSION = '2025-06-18';
const LIST_METHODS = new Set(['tools/list', 'resources/list', 'resources/templates/list', 'prompts/list']);
const CACHE_TTL_MS = 24 * 60 * 60_000;
const START_TIMEOUT_MS = 60_000;
const DEFAULT_EXCLUDE = ['para-pty']; // holds per-session terminal state in-process

const idleMs = () => Number(process.env.SHRAGA_MCP_POOL_IDLE_MS) || 10 * 60_000;
export const poolEnabled = () => !/^(0|false|off)$/i.test(process.env.SHRAGA_MCP_POOL ?? '');
const excluded = () => new Set([
  ...DEFAULT_EXCLUDE,
  ...(process.env.SHRAGA_MCP_POOL_EXCLUDE ?? '').split(',').map((s) => s.trim()).filter(Boolean),
]);

const TOKEN = randomBytes(24).toString('hex');
const TOKEN_HEADER = 'x-shraga-pool-token';

// ── disk cache: initialize result + list results, per key ────────────────────────────────────────
interface CacheEntry { exp: number; results: Record<string, Json> }
const CACHE_FILE = path.join(DATA_DIR, '.mcp-pool-cache.json');
let cache: Record<string, CacheEntry> = {};
try { if (existsSync(CACHE_FILE)) cache = JSON.parse(readFileSync(CACHE_FILE, 'utf-8')); } catch { cache = {}; }
let flushTimer: ReturnType<typeof setTimeout> | null = null;
function writeCache() {
  try { mkdirSync(DATA_DIR, { recursive: true }); writeFileSync(CACHE_FILE, JSON.stringify(cache)); }
  catch (e) { console.warn('[mcp-pool] cache flush failed:', (e as Error).message); }
}
function flushCache() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = null; writeCache(); }, 200);
  flushTimer.unref?.();
}
function cacheGet(key: string, method: string): Json | undefined {
  const e = cache[key];
  if (!e || e.exp < Date.now()) return undefined;
  return e.results[method];
}
function cacheSet(key: string, method: string, result: Json) {
  const e = cache[key] && cache[key].exp >= Date.now() ? cache[key] : { exp: Date.now() + CACHE_TTL_MS, results: {} };
  e.results[method] = result;
  cache[key] = e;
  flushCache();
}
function cacheDrop(key: string, method?: string) {
  if (!cache[key]) return;
  if (method) delete cache[key].results[method]; else delete cache[key];
  flushCache();
}

// ── one pooled child ─────────────────────────────────────────────────────────────────────────────
interface Pending { resolve: (msg: Json) => void; onNotify?: (msg: Json) => void; progressToken?: Json }

export class PooledServer {
  private proc: ChildProcess | null = null;
  private starting: Promise<void> | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private buf = '';
  private inflight = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  initResult: Json = null;

  constructor(readonly key: string, readonly name: string, private cfg: StdioCfg) {}

  get running() { return !!this.proc; }

  private ensure(): Promise<void> {
    if (this.proc && !this.starting) return Promise.resolve();
    if (!this.starting) this.starting = this.start().finally(() => { this.starting = null; });
    return this.starting;
  }

  private async start() {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    Object.assign(env, offloadEnv(), this.cfg.env ?? {});
    const proc = spawn(this.cfg.command, this.cfg.args ?? [], {
      cwd: this.cfg.cwd, env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = proc;
    this.buf = '';
    const t0 = Date.now();
    proc.stdout!.setEncoding('utf-8');
    proc.stdout!.on('data', (d: string) => this.onData(d));
    proc.stderr!.on('data', (d: Buffer) => {
      for (const line of d.toString().trim().split('\n')) if (line) console.log(`[mcp-pool:${this.name}] ${line}`);
    });
    proc.on('error', (err) => console.warn(`[mcp-pool:${this.name}] spawn error: ${err.message}`));
    proc.on('exit', (code, signal) => {
      if (this.proc !== proc) return;
      console.log(`[mcp-pool:${this.name}] exited code=${code} signal=${signal}`);
      this.proc = null;
      for (const [id, p] of this.pending) {
        p.resolve({ jsonrpc: '2.0', id, error: { code: -32000, message: `MCP server ${this.name} exited (code=${code} signal=${signal})` } });
      }
      this.pending.clear();
      this.inflight = 0;
    });

    const init = await this.raw('initialize', {
      protocolVersion: PROTOCOL_VERSION, capabilities: { roots: { listChanged: false } },
      clientInfo: { name: 'shraga-mcp-pool', version: '1' },
    }, START_TIMEOUT_MS);
    if (init.error) { this.kill(); throw new Error(`initialize failed: ${init.error.message}`); }
    this.write({ jsonrpc: '2.0', method: 'notifications/initialized' });
    this.initResult = init.result;
    cacheSet(this.key, 'initialize', init.result);
    console.log(`[mcp-pool] started ${this.name} pid=${proc.pid} in ${Date.now() - t0}ms`);
    this.refreshLists();
  }

  /** Re-read list methods the server advertises, so the cache tracks the live server. */
  private refreshLists() {
    const caps = this.initResult?.capabilities ?? {};
    const methods = [
      caps.tools && 'tools/list', caps.resources && 'resources/list',
      caps.resources && 'resources/templates/list', caps.prompts && 'prompts/list',
    ].filter(Boolean) as string[];
    for (const m of methods) {
      this.raw(m, {}).then((r) => { if (r.result) cacheSet(this.key, m, r.result); }).catch(() => {});
    }
  }

  private write(msg: Json) { this.proc?.stdin?.write(JSON.stringify(msg) + '\n'); }

  private raw(method: string, params: Json, timeoutMs?: number, onNotify?: (m: Json) => void): Promise<Json> {
    const id = this.nextId++;
    let progressToken: Json;
    if (params?._meta?.progressToken !== undefined) {
      progressToken = params._meta.progressToken;
      params = { ...params, _meta: { ...params._meta, progressToken: `p${id}` } };
    }
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (msg: Json) => { if (timer) clearTimeout(timer); this.pending.delete(id); resolve(msg); };
      this.pending.set(id, { resolve: done, onNotify, progressToken });
      if (timeoutMs) timer = setTimeout(() => done({ jsonrpc: '2.0', id, error: { code: -32001, message: `${method} timed out after ${timeoutMs}ms` } }), timeoutMs);
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  private onData(chunk: string) {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg: Json;
      try { msg = JSON.parse(line); } catch { console.log(`[mcp-pool:${this.name}] ${line}`); continue; }
      this.onMessage(msg);
    }
  }

  private onMessage(msg: Json) {
    if (msg.id !== undefined && msg.method) { // server → client request
      const result = msg.method === 'ping' ? {} : msg.method === 'roots/list' ? { roots: [] } : undefined;
      this.write(result ? { jsonrpc: '2.0', id: msg.id, result }
        : { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `${msg.method} not supported by shraga-mcp-pool` } });
      return;
    }
    if (msg.id !== undefined) { this.pending.get(msg.id)?.resolve(msg); return; }
    if (msg.method === 'notifications/progress') {
      const m = /^p(\d+)$/.exec(String(msg.params?.progressToken));
      const p = m && this.pending.get(Number(m[1]));
      if (p?.onNotify) p.onNotify({ ...msg, params: { ...msg.params, progressToken: p.progressToken } });
      return;
    }
    const listChanged = /^notifications\/(tools|resources|prompts)\/list_changed$/.exec(msg.method ?? '');
    if (listChanged) {
      const kind = listChanged[1];
      for (const m of LIST_METHODS) if (m.startsWith(kind)) cacheDrop(this.key, m);
      this.refreshLists();
    }
  }

  /** Forward a client request; returns the JSON-RPC response with the client's id restored. */
  async request(msg: Json, onNotify?: (m: Json) => void, signal?: AbortSignal): Promise<Json> {
    this.inflight++;
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    try {
      try { await this.ensure(); }
      catch (e) { return { jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: `MCP server ${this.name} failed to start: ${(e as Error).message}` } }; }
      const id = this.nextId; // raw() assigns this id
      const onAbort = () => this.write({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'client disconnected' } });
      signal?.addEventListener('abort', onAbort, { once: true });
      const res = await this.raw(msg.method, msg.params, undefined, onNotify);
      signal?.removeEventListener('abort', onAbort);
      if (res.result && LIST_METHODS.has(msg.method) && !msg.params?.cursor) cacheSet(this.key, msg.method, res.result);
      return { ...res, id: msg.id };
    } finally {
      this.inflight = Math.max(0, this.inflight - 1);
      this.armIdle();
    }
  }

  async initialize(): Promise<Json> {
    const cached = this.initResult ?? cacheGet(this.key, 'initialize');
    if (cached) return cached;
    this.inflight++;
    try { await this.ensure(); return this.initResult; }
    finally { this.inflight = Math.max(0, this.inflight - 1); this.armIdle(); }
  }

  private armIdle() {
    if (this.inflight > 0 || !this.proc) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.inflight === 0 && this.proc) { console.log(`[mcp-pool] reaping idle ${this.name}`); this.kill(); }
    }, idleMs());
    this.idleTimer.unref?.();
  }

  kill() {
    const p = this.proc;
    this.proc = null;
    if (p && p.exitCode === null) { try { p.kill('SIGTERM'); } catch { /* gone */ } }
  }
}

// ── registry + config rewrite ────────────────────────────────────────────────────────────────────
const servers = new Map<string, PooledServer>();

function isStdio(s: McpServerConfig): s is McpServerConfig & StdioCfg {
  if (!s) return false;
  const t = (s as { type?: string }).type;
  return (!t || t === 'stdio') && typeof (s as StdioCfg).command === 'string';
}

export function poolKey(name: string, s: StdioCfg): string {
  return createHash('sha256').update(JSON.stringify([name, s.command, s.args ?? [], s.cwd ?? '', s.env ?? {}])).digest('hex').slice(0, 32);
}

const baseUrl = () => `http://127.0.0.1:${Number(process.env.PORT) || 3032}`;

/** Replace each poolable stdio entry with a loopback-HTTP entry backed by the shared pool. */
export function poolMcpServers(config: McpConfig): McpConfig {
  if (!poolEnabled()) return config;
  const skip = excluded();
  const out: McpConfig = {};
  for (const [name, s] of Object.entries(config)) {
    if (!isStdio(s) || skip.has(name)) { out[name] = s; continue; }
    const key = poolKey(name, s);
    if (!servers.has(key)) servers.set(key, new PooledServer(key, name, { command: s.command, args: s.args, env: s.env, cwd: s.cwd }));
    out[name] = { type: 'http', url: `${baseUrl()}/mcp-pool/${key}`, headers: { [TOKEN_HEADER]: TOKEN } } as McpServerConfig;
  }
  return out;
}

export function getPooledServer(key: string) { return servers.get(key); }

export function poolStatus() {
  return [...servers.values()].map((s) => ({ name: s.name, key: s.key, running: s.running }));
}

export function stopMcpPool() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; writeCache(); }
  for (const s of servers.values()) s.kill();
}

// ── HTTP surface ─────────────────────────────────────────────────────────────────────────────────
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function authorized(req: Request): boolean {
  if (!LOOPBACK.has(req.socket.remoteAddress ?? '')) return false;
  const got = Buffer.from(String(req.headers[TOKEN_HEADER] ?? ''));
  const want = Buffer.from(TOKEN);
  return got.length === want.length && timingSafeEqual(got, want);
}

export async function handlePoolMessage(srv: PooledServer, msg: Json, onNotify?: (m: Json) => void, signal?: AbortSignal): Promise<Json | null> {
  if (msg.id === undefined) return null; // client notifications (initialized/cancelled) — nothing to relay
  const ok = (result: Json) => ({ jsonrpc: '2.0', id: msg.id, result });
  if (msg.method === 'initialize') {
    try { return ok(await srv.initialize()); }
    catch (e) { return { jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: (e as Error).message } }; }
  }
  if (msg.method === 'ping') return ok({});
  if (LIST_METHODS.has(msg.method) && !msg.params?.cursor) {
    const cached = cacheGet(srv.key, msg.method);
    if (cached) return ok(cached);
  }
  return srv.request(msg, onNotify, signal);
}

export function mountMcpPool(app: Application) {
  app.post('/mcp-pool/:key', async (req: Request, res: Response) => {
    if (!authorized(req)) return res.status(403).json({ error: 'forbidden' });
    const srv = servers.get(req.params.key);
    if (!srv) return res.status(404).json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'unknown pool key (server restarted?)' } });
    const body = req.body;
    const batch = Array.isArray(body);
    const msgs: Json[] = batch ? body : [body];
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });

    const wantsSse = String(req.headers.accept ?? '').includes('text/event-stream');
    const single = !batch && msgs[0]?.id !== undefined && msgs[0]?.method === 'tools/call';
    if (wantsSse && single) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      const send = (m: Json) => res.write(`event: message\ndata: ${JSON.stringify(m)}\n\n`);
      const out = await handlePoolMessage(srv, msgs[0], send, ac.signal);
      if (out) send(out);
      return res.end();
    }
    const results = (await Promise.all(msgs.map((m) => handlePoolMessage(srv, m, undefined, ac.signal)))).filter(Boolean);
    if (results.length === 0) return res.status(202).end();
    res.json(batch ? results : results[0]);
  });
  // Stateless server: no standalone SSE stream, no session to delete.
  app.get('/mcp-pool/:key', (_req: Request, res: Response) => res.status(405).set('Allow', 'POST').end());
  app.delete('/mcp-pool/:key', (_req: Request, res: Response) => res.status(200).end());
}
