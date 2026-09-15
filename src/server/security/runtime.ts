// Security runtime: the ONE process-wide Policy + Audit, and the per-turn decision.
//
// SHADOW MODE: decide() computes and audits; nothing here denies. Callers never branch on it yet.
// Uninitialized (tests, embedders that never call initSecurity) ⇒ security() is undefined and every
// call site no-ops — the audit trail is additive, never a precondition for a turn or a request.
//
// Writes are gated on `isActive` (a PASSIVE standby shares DATA_DIR and must not append to data/audit)
// and noisy events are deduped per key per window, so a busy client isn't one line per request.
import { Policy, type PolicyOptions, type TamperReason } from './policy.ts';
import { Audit, type AuditEvent, type AuditOptions } from './audit.ts';
import type { Principal } from './principal.ts';

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
  private seen = new Map<string, number>();

  public constructor(options?: Partial<SecurityRuntimeOptions>) {
    this.options = { ...new SecurityRuntimeOptions(), ...options };
    const { policy, audit, log } = this.options;
    this.audit = new Audit({ log, ...audit });
    this.policy = new Policy({ log, ...policy, onTamper: (info) => { policy.onTamper?.(info); this.onTamper(info); } });
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
    const r = this.policy.resolve(principal);
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

/** Test-only: drop the process-wide runtime. */
export function __resetSecurityForTest(): void { current?.close(); current = undefined; }
