// Security runtime: the ONE process-wide Policy + Audit, and the per-turn decision.
//
// SHADOW MODE: decide() computes and audits; nothing here denies. Callers never branch on it yet.
// Uninitialized (tests, embedders that never call initSecurity) ⇒ security() is undefined and every
// call site no-ops — the audit trail is additive, never a precondition for a turn or a request.
//
// Writes are gated on `isActive` (a PASSIVE standby shares DATA_DIR and must not append to data/audit, nor let the
// Policy migrate/save/mark or judge tamper; `activate()` re-loads the policy on promotion), and noisy events are
// deduped per key per window, so a busy client isn't one line per request.
import { OWNER_ROLE, Policy, type PolicyOptions, type Resolved, type TamperReason } from './policy.ts';
import { Audit, type AuditEvent, type AuditOptions } from './audit.ts';
import { Guard, type GuardOptions, type TurnAdmission } from './guard.ts';
import { fromAuthUser, type Principal } from './principal.ts';

/** principal → role. An API key acts for its creator, re-resolved per call (so an OWNERS removal applies at once):
 *  - no `attrs.role` (a delegated login credential) ⇒ the creator's role, owner included;
 *  - `attrs.role` set ⇒ min(creator's role, that role, the highest role below owner) — never above the creator, never owner. */
export function resolvePrincipal(policy: Policy, p: Principal): Resolved {
  if (p.kind !== 'apikey') return policy.resolve(p);
  const creator = policy.resolve(fromAuthUser({ uid: String(p.attrs.uid ?? ''), email: p.email }));
  if (typeof p.attrs.role !== 'string') return creator;
  const r = creator.role === OWNER_ROLE ? policy.belowOwner() : creator;
  const cap = policy.effective(Infinity, p.attrs.role); // the named role (unknown ⇒ the policy default)
  return cap.rank < r.rank ? cap : r;
}

export interface Decision {
  role: string;
  rank: number;
  profile: string;
  /** The profile would NOT allow today's behavior (every tool, every MCP, full env, outbound). */
  wouldDeny: boolean;
}

export class SecurityRuntimeOptions {
  policy: Partial<PolicyOptions> = {};
  audit: Partial<AuditOptions> = {};
  guard: Partial<GuardOptions> = {};
  /** Audit writes (and tamper notices) only while this is true. */
  isActive: () => boolean = () => true;
  /** A deduped event with the same key is written at most once per window. */
  dedupeMs: number = 60_000;
  clock: () => number = Date.now;
  /** Owner notice. Default: notify-owners (lazy import — keeps this module free of the event bus). */
  notify: (text: string) => void = (text) => {
    import('../notify-owners.ts')
      .then(m => m.notifyOwners('security', text))
      .catch((e: any) => console.error('[security] owner notice failed:', e?.message ?? e));
  };
  log: Pick<Console, 'info' | 'warn' | 'error'> = console;
}

const MAX_DEDUPE_KEYS = 5000;

export class SecurityRuntime {
  public options: SecurityRuntimeOptions;
  public readonly policy: Policy;
  public readonly audit: Audit;
  public readonly guard: Guard;
  private seen = new Map<string, number>();

  public constructor(options?: Partial<SecurityRuntimeOptions>) {
    this.options = { ...new SecurityRuntimeOptions(), ...options };
    const { policy, audit, guard, log, clock } = this.options;
    this.audit = new Audit({
      log, ...audit,
      // Standby instances share DATA_DIR: only the active one alerts (false = ask again after promotion).
      onAnomaly: (info) => {
        if (audit.onAnomaly?.(info) === false || !this.active()) return false;
        this.options.notify(`Audit log entry ${info.file} in ${info.dir} is a ${info.kind}, not a regular file — possibly planted to divert or disable auditing. Appends to that month are refused until root removes it (chattr -a the audit dir, rm the entry, re-run harden-audit.sh).`);
      },
    });
    this.policy = new Policy({ log, isActive: () => this.active(), ...policy, onTamper: (info) => { policy.onTamper?.(info); this.onTamper(info); } });
    this.guard = new Guard({
      log, clock, isActive: () => this.active(),
      audit: (e, k) => this.record(e, k),
      blocklist: (p) => this.policy.blocked(p, this.options.clock() / 1000),
      ...guard,
    });
  }

  /** Passive → active promotion (after `isActive` turns true): re-load the policy and auto-blocks from disk with boot trust. */
  public activate(): void {
    this.options.log.info('[security] activated — reloading policy from disk');
    this.policy.activate();
    this.guard.activate();
  }

  /** Guard a turn start: principal → rank/rate → blocklist, rate, concurrency. Call BEFORE any LLM spend and
   *  `release()` when the turn ends (try/finally). Shadow unless SECURITY_ENFORCE=true. */
  public admitTurn(principal: Principal, ctx: { ip?: string; channel?: string } = {}): TurnAdmission {
    const r = resolvePrincipal(this.policy, principal); // same resolution as decide(): an API key's role cap applies to guard rank/rate
    return this.guard.admit({ principal, ...ctx, rank: r.rank, rate: r.profile.rate });
  }

  private active(): boolean {
    try { return this.options.isActive(); }
    catch (e: any) { this.options.log.error(`[security] isActive threw — not writing audit: ${e.message}`); return false; }
  }

  /** Append (active instance only). With `dedupeKey`, at most once per `dedupeMs`. Never throws. */
  public record(event: AuditEvent, dedupeKey?: string): void {
    if (!this.active()) return;
    if (dedupeKey) {
      const now = this.options.clock(), last = this.seen.get(dedupeKey);
      if (last !== undefined && now - last < this.options.dedupeMs) return;
      if (this.seen.size >= MAX_DEDUPE_KEYS) {
        for (const [k, t] of this.seen) if (now - t >= this.options.dedupeMs) this.seen.delete(k);
        if (this.seen.size >= MAX_DEDUPE_KEYS) this.seen.clear();
      }
      this.seen.set(dedupeKey, now);
    }
    this.audit.append(event);
  }

  /** principal → role/profile, audited as `role.resolve` (deduped per principal+role per window). */
  public decide(principal: Principal, sessionId?: string): Decision {
    const r = resolvePrincipal(this.policy, principal);
    const p = r.profile;
    const wouldDeny = !(p.tools.includes('*') && p.mcps.includes('*') && p.env.includes('*') && p.outbound);
    this.record({
      type: 'role.resolve', principal: principal.id, role: r.role, sessionId,
      meta: { kind: principal.kind, verified: principal.verified, profile: r.profileName, rank: r.rank, policyValid: this.policy.valid },
    }, `role.resolve|${principal.id}|${r.role}`);
    return { role: r.role, rank: r.rank, profile: r.profileName, wouldDeny };
  }

  /** `via` = the auth branch (e.g. `http:apikey`, `mcp:oauth`, `ws:bearer`). */
  public authAllow(principal: Principal, via: string): void {
    this.record({ type: 'auth.allow', principal: principal.id, target: via, meta: { kind: principal.kind } }, `auth.allow|${principal.id}|${via}`);
  }

  public authDeny(via: string, reason: string, ip?: string): void {
    this.record({ type: 'auth.deny', target: via, reason, meta: ip ? { ip } : undefined }, `auth.deny|${via}|${reason}|${ip ?? ''}`);
  }

  private onTamper(info: { path: string; reason: TamperReason; expected: string | null; actual: string | null }): void {
    if (!this.active()) return;
    this.audit.append({ type: 'policy.tamper', target: info.path, reason: info.reason, meta: { expected: info.expected, actual: info.actual } });
    this.options.notify(`Security policy file changed outside the server (${info.reason}): ${info.path}. The last good policy is still in force.`);
  }

  public close(): void { this.policy.close(); }
}

let current: SecurityRuntime | undefined;

/** Construct the process-wide runtime (replaces a previous one). Call once at boot, after config load. */
export function initSecurity(options?: Partial<SecurityRuntimeOptions>): SecurityRuntime {
  current?.close();
  current = new SecurityRuntime(options);
  return current;
}

/** The process-wide runtime, or undefined when never initialized (call sites then skip auditing). */
export function security(): SecurityRuntime | undefined { return current; }

/**
 * Turn-start gate for the core lanes AND add-ons (e.g. a Gmail lane): `admitTurn(principal, { ip, channel })`.
 * `{ ok: false, status, retryAfter?, reason }` only when enforcing; on ok, call `release()` when the turn ends.
 * No runtime, or a guard bug ⇒ admitted (logged): the guard limits spend, it is not the auth layer.
 */
export function admitTurn(principal: Principal, ctx?: { ip?: string; channel?: string }): TurnAdmission {
  try { return current ? current.admitTurn(principal, ctx) : { ok: true, release: () => {} }; }
  catch (e: any) { console.error(`[security] admitTurn threw — admitting: ${e?.message ?? e}`); return { ok: true, release: () => {} }; }
}

/** Client IP of a request/upgrade, honoring TRUSTED_PROXIES. */
export function requestIp(req: Parameters<Guard['ipOf']>[0]): string | undefined {
  return current?.guard.ipOf(req);
}

/** Test-only: drop the process-wide runtime. */
export function __resetSecurityForTest(): void { current?.close(); current = undefined; }
