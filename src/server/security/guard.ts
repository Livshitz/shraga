// Guard: abuse limits in front of every turn — BEFORE any LLM spend.
//
// Order: blocklist (policy manual blocklist + persisted auto-blocks) → rate (principal, ip, channel buckets) → proceed.
// Plus a global ceiling on concurrent agent turns for principals below `ceilingBelowRank`.
//
// SHADOW: unless `enforce()` (SECURITY_ENFORCE=true) every verdict is `{ ok: true, wouldDeny }` — computed and audited,
// never denied. Auto-blocks are still recorded (TTL-bound) so the Console shows what enforcement would do.
//
// Memory is bounded: buckets, hit windows and blocks are LRU maps capped at `maxKeys` — a spray of distinct
// principals/IPs evicts the least-recently-used entry instead of growing the heap.
//
// Persistence: auto-blocks → data/security/blocks.json (atomic tmp+rename). Only an ACTIVE instance writes; a PASSIVE
// standby keeps blocks in memory and `activate()` re-loads from disk on promotion (same model as runtime/policy).
import { BlockList, isIP } from 'node:net';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { dataPath } from '../paths.ts';
import type { AuditEvent } from './audit.ts';
import type { Principal } from './principal.ts';

export interface GuardDenial { ok: false; status: 429 | 403; retryAfter?: number; reason: string }
export type GuardVerdict = { ok: true; wouldDeny?: GuardDenial } | GuardDenial;
export interface GuardInput { principal: Principal; ip?: string; channel?: string; rank: number; rate: string }
export type TurnAdmission = { ok: true; release: () => void; wouldDeny?: GuardDenial } | GuardDenial;
export interface BlockRecord { until: number; reason: string; at: number }

const UNITS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** `"N/h"`, `"N/m"`, `"N/s"`, `"N/d"`; bare `"N"` = per hour; `"0"` = deny all. null = unparseable. */
export function parseRate(rate: string): { cap: number; periodMs: number } | null {
  const m = /^(\d+)(?:\/([smhd]))?$/.exec(String(rate ?? '').trim());
  return m ? { cap: Number(m[1]), periodMs: UNITS[m[2] ?? 'h'] } : null;
}

/** `TRUSTED_PROXIES` → BlockList. Comma/space separated IPs or CIDRs; unset/empty = trust none. */
export function parseTrustedProxies(spec: string | undefined, log: Pick<Console, 'warn'> = console): BlockList {
  const list = new BlockList();
  for (const raw of String(spec ?? '').split(/[\s,]+/).filter(Boolean)) {
    const [addr, bits] = raw.split('/');
    const ip = normalizeIp(addr), type = ip && isIP(ip) === 6 ? 'ipv6' : 'ipv4';
    if (!ip) { log.warn(`[guard] TRUSTED_PROXIES: ignoring invalid entry "${raw}"`); continue; }
    if (bits === undefined) list.addAddress(ip, type);
    else if (/^\d+$/.test(bits) && Number(bits) <= (type === 'ipv6' ? 128 : 32)) list.addSubnet(ip, Number(bits), type);
    else log.warn(`[guard] TRUSTED_PROXIES: ignoring invalid prefix "${raw}"`);
  }
  return list;
}

/** Strip `::ffff:` IPv4-mapped prefix and zone ids; undefined if not an IP. */
export function normalizeIp(v: string | undefined): string | undefined {
  let s = String(v ?? '').trim();
  if (s.startsWith('[') && s.includes(']')) s = s.slice(1, s.indexOf(']'));
  s = s.replace(/%.*$/, '');
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(s)) s = s.slice(7);
  return isIP(s) ? s : undefined;
}

const isTrusted = (list: BlockList, ip: string) => list.check(ip, isIP(ip) === 6 ? 'ipv6' : 'ipv4');
const isLoopback = (ip: string) => /^127\./.test(ip) || ip === '::1';

/**
 * Client IP: the direct peer, unless the peer is a trusted proxy — then walk `x-forwarded-for` right→left and take the
 * first hop that is NOT trusted. Headers from an untrusted peer are ignored (spoofable). A malformed hop stops the walk
 * at the last trusted hop. Returns undefined when nothing usable is known.
 */
export function clientIp(peer: string | undefined, xff: string | string[] | undefined, trusted: BlockList): string | undefined {
  let ip = normalizeIp(peer);
  if (!ip || !isTrusted(trusted, ip)) return ip;
  const hops = (Array.isArray(xff) ? xff.join(',') : String(xff ?? '')).split(',').map(h => h.trim()).filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = normalizeIp(hops[i]);
    if (!hop) return ip;
    ip = hop;
    if (!isTrusted(trusted, hop)) return hop;
  }
  return ip;
}

/** Insertion-ordered Map used as an LRU: get() refreshes, set() evicts the oldest past `max`. */
class Lru<V> {
  public readonly map = new Map<string, V>();
  public constructor(private max: () => number) {}
  public get(k: string): V | undefined {
    const v = this.map.get(k);
    if (v !== undefined) { this.map.delete(k); this.map.set(k, v); }
    return v;
  }
  public set(k: string, v: V): void {
    this.map.delete(k); this.map.set(k, v);
    while (this.map.size > this.max()) this.map.delete(this.map.keys().next().value!);
  }
  public get size(): number { return this.map.size; }
}

export class GuardLimits {
  /** Per client IP (only when an IP is known and not loopback). */
  ip: string = '600/h';
  /** Per channel name (e.g. `slack`, `api`, `ws`); channels not listed are unlimited. */
  channel: Record<string, string> = {};
  /** Max concurrent agent turns across principals ranked below `ceilingBelowRank`. */
  maxConcurrentTurns: number = 8;
  ceilingBelowRank: number = 50;
  /** Auto-block a principal/IP after this many rate-limit hits within `blockWindowMs`… */
  blockAfter: number = 20;
  blockWindowMs: number = 10 * 60_000;
  /** …for this long. */
  blockTtlMs: number = 60 * 60_000;
  /** Principals at/above this rank are rate-limited but never auto-blocked (an owner can't lock themselves out). */
  autoBlockExemptRank: number = 100;
  /** Cap per in-memory map (buckets, hit windows, blocks). */
  maxKeys: number = 10_000;
}

export class GuardOptions {
  clock: () => number = Date.now;
  log: Pick<Console, 'info' | 'warn' | 'error'> = console;
  limits: Partial<GuardLimits> = {};
  blocksPath: string = dataPath('security', 'blocks.json');
  /** Writes (blocks.json) only while true. */
  isActive: () => boolean = () => true;
  /** False = shadow: compute + audit, never deny. */
  enforce: () => boolean = () => process.env.SECURITY_ENFORCE === 'true';
  /** Audit sink; `dedupeKey` = at most once per window (SecurityRuntime.record semantics). */
  audit: (event: AuditEvent, dedupeKey?: string) => void = () => {};
  /** Manual blocklist match (Policy.blocked). */
  blocklist: (p: Principal) => { reason?: string; until: number | null } | undefined = () => undefined;
  trustedProxies: BlockList = parseTrustedProxies(process.env.TRUSTED_PROXIES);
}

interface Bucket { tokens: number; at: number; rate: string }

export class Guard {
  public options: GuardOptions;
  public readonly limits: GuardLimits;
  private buckets: Lru<Bucket>;
  /** Rate-limit hit times per key, with the authenticated principal id (undefined = anonymous) for shared-IP detection. */
  private hits: Lru<Array<{ t: number; p?: string }>>;
  private blocks: Lru<BlockRecord>;
  private activeTurns = 0;

  public constructor(options?: Partial<GuardOptions>) {
    this.options = { ...new GuardOptions(), ...options };
    this.limits = { ...new GuardLimits(), ...this.options.limits };
    const max = () => this.limits.maxKeys;
    this.buckets = new Lru(max); this.hits = new Lru(max); this.blocks = new Lru(max);
    this.load();
  }

  /** Client IP of an HTTP request / WS upgrade (see clientIp). */
  public ipOf(req: { socket?: { remoteAddress?: string }; headers: Record<string, string | string[] | undefined> }): string | undefined {
    return clientIp(req.socket?.remoteAddress, req.headers['x-forwarded-for'], this.options.trustedProxies);
  }

  public get turnsInFlight(): number { return this.activeTurns; }

  /** Active auto-blocks (for the Console). */
  public list(): Array<BlockRecord & { key: string }> {
    const now = this.options.clock();
    return [...this.blocks.map].filter(([, b]) => b.until > now).map(([key, b]) => ({ key, ...b }));
  }

  /** blocklist → auto-blocks → rate. Consumes one token from each applicable bucket only when all pass. */
  public check(input: GuardInput): GuardVerdict {
    const denial = this.evaluate(input);
    if (!denial) return { ok: true };
    return this.options.enforce() ? denial : { ok: true, wouldDeny: denial };
  }

  /** Concurrency slot for rank < ceilingBelowRank. Returns an idempotent release, or null when the ceiling is reached. */
  public acquireTurn(rank: number): (() => void) | null {
    if (rank >= this.limits.ceilingBelowRank) return () => {};
    if (this.activeTurns >= this.limits.maxConcurrentTurns) return null;
    this.activeTurns++;
    let done = false;
    return () => { if (!done) { done = true; this.activeTurns--; } };
  }

  /** Run `fn` holding a turn slot; the slot is released however `fn` exits. Throws when the ceiling is reached. */
  public async withTurn<T>(rank: number, fn: () => T | Promise<T>): Promise<T> {
    const release = this.acquireTurn(rank);
    if (!release) throw new Error('guard: concurrent turn ceiling reached');
    try { return await fn(); } finally { release(); }
  }

  /** check + acquireTurn, shadow-aware. On ok the caller MUST call `release` when the turn ends (try/finally). */
  public admit(input: GuardInput): TurnAdmission {
    const v = this.check(input);
    if (!v.ok) return v;
    const release = this.acquireTurn(input.rank);
    if (release) return v.wouldDeny ? { ok: true, release, wouldDeny: v.wouldDeny } : { ok: true, release };
    const denial: GuardDenial = { ok: false, status: 429, retryAfter: 5, reason: 'turn-ceiling' };
    const enforced = this.options.enforce();
    this.audit({ type: 'guard.limit', principal: input.principal.id, reason: 'turn-ceiling', meta: { key: 'global:turns', max: this.limits.maxConcurrentTurns, rank: input.rank, enforced } }, 'guard.limit|global:turns');
    return enforced ? denial : { ok: true, release: () => {}, wouldDeny: v.wouldDeny ?? denial };
  }

  /** Passive → active promotion: merge disk state (the previous active's blocks) and persist. */
  public activate(): void {
    const mem = [...this.blocks.map];
    this.load();
    for (const [k, b] of mem) { const d = this.blocks.get(k); if (!d || d.until < b.until) this.blocks.set(k, b); }
    this.save();
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private evaluate(input: GuardInput): GuardDenial | undefined {
    const { principal, channel, rank } = input;
    const now = this.options.clock(), enforced = this.options.enforce();
    const ip = input.ip && !isLoopback(input.ip) ? input.ip : undefined;
    const pKey = `principal:${principal.id}`, ipKey = ip ? `ip:${ip}` : undefined;
    const meta = (extra: Record<string, unknown>) => ({ ...(ip ? { ip } : {}), ...(channel ? { channel } : {}), rank, enforced, ...extra });

    const manual = this.safe(() => this.options.blocklist(principal), undefined);
    if (manual) {
      this.audit({ type: 'guard.block', principal: principal.id, reason: manual.reason ?? 'blocklist', meta: meta({ source: 'policy' }) }, `guard.block|policy|${principal.id}`);
      const retryAfter = manual.until ? Math.max(1, Math.ceil(manual.until - now / 1000)) : undefined;
      return { ok: false, status: 403, reason: 'blocked', ...(retryAfter ? { retryAfter } : {}) };
    }
    // IP-keyed state never denies an exempt rank: a shared IP (NAT, same-host proxy) blocked by a guest must not lock out the owner.
    const exempt = rank >= this.limits.autoBlockExemptRank;
    for (const key of [pKey, exempt ? undefined : ipKey]) {
      const b = key ? this.activeBlock(key, now) : undefined;
      if (!b) continue;
      this.audit({ type: 'guard.block', principal: principal.id, target: key, reason: b.reason, meta: meta({ source: 'auto' }) }, `guard.block|auto|${key}`);
      return { ok: false, status: 403, reason: 'blocked', retryAfter: Math.max(1, Math.ceil((b.until - now) / 1000)) };
    }

    const wants: Array<[key: string, rate: string, blockable: boolean]> = [[pKey, input.rate, !exempt]];
    if (ipKey && !exempt) wants.push([ipKey, this.limits.ip, true]);
    const chRate = channel ? this.limits.channel[channel] : undefined;
    if (chRate !== undefined) wants.push([`channel:${channel}`, chRate, false]);

    const pending: Array<[string, Bucket]> = [];
    for (const [key, rate, blockable] of wants) {
      const r = parseRate(rate);
      if (!r || r.cap === 0) {
        // Policy denial ("0" = no access) or a bad rate string — not an abuse signal, so no auto-block.
        if (!r) this.options.log.error(`[guard] invalid rate "${rate}" for ${key} — denying`);
        this.audit({ type: 'guard.limit', principal: principal.id, target: key, reason: r ? 'rate-zero' : 'rate-invalid', meta: meta({ rate }) }, `guard.limit|${key}|zero`);
        return { ok: false, status: 403, reason: r ? 'rate-zero' : 'rate-invalid' };
      }
      const prev = this.buckets.get(key);
      const b: Bucket = prev && prev.rate === rate
        ? { rate, at: now, tokens: Math.min(r.cap, prev.tokens + (Math.max(0, now - prev.at) * r.cap) / r.periodMs) } // clock stepped back → no refill, never a drain
        : { rate, at: now, tokens: r.cap };
      if (b.tokens < 1) {
        const retryAfter = Math.max(1, Math.ceil(((1 - b.tokens) * r.periodMs) / r.cap / 1000));
        this.buckets.set(key, b);
        this.audit({ type: 'guard.limit', principal: principal.id, target: key, reason: 'rate', meta: meta({ rate, retryAfter }) }, `guard.limit|${key}`);
        if (blockable) this.recordHit(key, principal, now, meta({}));
        return { ok: false, status: 429, retryAfter, reason: 'rate' };
      }
      pending.push([key, b]);
    }
    for (const [key, b] of pending) { b.tokens -= 1; this.buckets.set(key, b); }
    return undefined;
  }

  private recordHit(key: string, principal: Principal, now: number, meta: Record<string, unknown>): void {
    const { blockAfter, blockWindowMs, blockTtlMs } = this.limits;
    const window = (this.hits.get(key) ?? []).filter(h => now - h.t < blockWindowMs);
    window.push({ t: now, p: principal.kind === 'anonymous' ? undefined : principal.id });
    if (window.length < blockAfter) return void this.hits.set(key, window.slice(-blockAfter));
    // An IP whose hits come from >1 authenticated principal is shared (NAT/proxy): throttle, never block it.
    if (key.startsWith('ip:') && new Set(window.map(h => h.p).filter(Boolean)).size > 1) return void this.hits.set(key, window.slice(-blockAfter));
    this.hits.map.delete(key);
    const principalId = principal.id;
    const rec: BlockRecord = { until: now + blockTtlMs, reason: `auto: ${window.length} limit hits in ${Math.round(blockWindowMs / 1000)}s`, at: now };
    this.blocks.set(key, rec);
    this.options.log.warn(`[guard] auto-blocked ${key} until ${new Date(rec.until).toISOString()} (${rec.reason})`);
    this.audit({ type: 'guard.block', principal: principalId, target: key, reason: rec.reason, meta: { ...meta, source: 'auto', created: true, until: rec.until } });
    this.save();
  }

  private activeBlock(key: string, now: number): BlockRecord | undefined {
    const b = this.blocks.map.get(key);
    if (!b) return undefined;
    if (b.until > now) return b;
    this.blocks.map.delete(key);
    this.save();
    return undefined;
  }

  private audit(event: AuditEvent, dedupeKey?: string): void {
    this.safe(() => this.options.audit(event, dedupeKey), undefined);
  }

  private safe<T>(fn: () => T, fallback: T): T {
    try { return fn(); } catch (e: any) { this.options.log.error(`[guard] hook threw: ${e?.message ?? e}`); return fallback; }
  }

  private active(): boolean { return this.safe(() => this.options.isActive(), false); }

  /** Read blocks.json, dropping expired/malformed entries (persisting the prune when active). Never throws. */
  private load(): void {
    const p = this.options.blocksPath, now = this.options.clock();
    if (!existsSync(p)) return;
    let pruned = 0;
    try {
      const raw = JSON.parse(readFileSync(p, 'utf8'))?.blocks ?? {};
      for (const [key, b] of Object.entries<any>(raw)) {
        if (typeof b?.until === 'number' && b.until > now && typeof key === 'string') this.blocks.set(key, { until: b.until, reason: String(b.reason ?? 'auto'), at: Number(b.at) || now });
        else pruned++;
      }
    } catch (e: any) { this.options.log.error(`[guard] ${p} unreadable — starting with no auto-blocks: ${e.message}`); return; }
    if (pruned) { this.options.log.info(`[guard] pruned ${pruned} expired block(s) from ${p}`); this.save(); }
  }

  /** Atomic write of the active blocks. Active instance only. Never throws. */
  private save(): void {
    if (!this.active()) return;
    const p = this.options.blocksPath, now = this.options.clock();
    const blocks = Object.fromEntries([...this.blocks.map].filter(([, b]) => b.until > now));
    try {
      mkdirSync(path.dirname(p), { recursive: true });
      const tmp = `${p}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, blocks }, null, 2) + '\n', { mode: 0o600 });
      renameSync(tmp, p);
    } catch (e: any) { this.options.log.error(`[guard] persisting ${p} failed: ${e.message}`); }
  }
}

/** Write a denial to an HTTP response (status + Retry-After). */
export function writeDenial(res: { status(code: number): { json(body: unknown): unknown }; setHeader(k: string, v: string): unknown }, d: GuardDenial): void {
  if (d.retryAfter) res.setHeader('Retry-After', String(d.retryAfter));
  res.status(d.status).json({ error: d.status === 403 ? 'Forbidden' : 'Too many requests', reason: d.reason, ...(d.retryAfter ? { retryAfter: d.retryAfter } : {}) });
}
