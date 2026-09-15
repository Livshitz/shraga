// Policy: principal → role → capability profile. Loads data/security/policy.json, validates, compiles
// into Maps so resolve() is a few lookups with no I/O.
//
// Trust rules:
// - Owners come ONLY from the OWNERS env (owners.ts) — never from the file, so a file edit can't mint one.
// - Hot reload is PROVENANCE-CHECKED: only content whose sha256 matches what this process wrote via
//   save() is loaded at runtime. Any other change keeps the last-good policy and fires onTamper.
//   (The file present at boot is trusted — protecting it at rest is the protected-paths step.)
// - Missing file ⇒ migration (from whitelist.json + optional hook). Empty/invalid ⇒ fail closed:
//   only owners resolve above anonymous.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { dataPath } from '../paths.ts';
import { isOwnerEmail } from '../owners.ts';
import type { Principal, PrincipalKind } from './principal.ts';

export type ReadScope = 'all' | 'own' | 'none';
export interface Profile { tools: string[]; mcps: string[]; env: string[]; outbound: boolean; readScope: ReadScope; rate: string }
export interface RoleDef { rank: number; profile: string }
export interface BindingMatch { kind?: PrincipalKind; id?: string; emailIn?: string[]; domain?: string; verified?: boolean }
export interface Binding { match: BindingMatch; role: string }
export interface BlockEntry { match: BindingMatch; until: number | null; reason?: string }
export interface PolicyFile {
  roles: Record<string, RoleDef>;
  profiles: Record<string, Profile>;
  bindings: Binding[];
  default: string;
  blocklist: BlockEntry[];
  /** principalId → epoch seconds; tokens issued before are invalid. */
  tokensValidAfter: Record<string, number>;
}
export interface Resolved { role: string; rank: number; profile: Profile; profileName: string }
export type TamperReason = 'hash-mismatch' | 'deleted';

export const OWNER_ROLE = 'owner';
const NONE_PROFILE: Profile = { tools: [], mcps: [], env: [], outbound: false, readScope: 'none', rate: '0' };
const FULL_PROFILE: Profile = { tools: ['*'], mcps: ['*'], env: ['*'], outbound: true, readScope: 'all', rate: '600/h' };

/** Defaults from the plan. Migration seeds bindings on top of this. */
export function defaultPolicy(): PolicyFile {
  return {
    roles: {
      owner: { rank: 100, profile: 'full' },
      operator: { rank: 80, profile: 'full' },
      member: { rank: 50, profile: 'standard' },
      guest: { rank: 20, profile: 'reply-only' },
      anonymous: { rank: 0, profile: 'none' },
    },
    profiles: {
      full: { ...FULL_PROFILE },
      standard: { tools: ['Read', 'Glob', 'LS', 'WebSearch'], mcps: [], env: [], outbound: true, readScope: 'own', rate: '120/h' },
      'reply-only': { tools: ['escalate'], mcps: [], env: [], outbound: true, readScope: 'own', rate: '10/h' },
      none: { ...NONE_PROFILE },
    },
    bindings: [],
    default: 'anonymous',
    blocklist: [],
    tokensValidAfter: {},
  };
}

const RATE_RE = /^\d+(\/[smhd])?$/;
const KINDS = new Set(['user', 'email', 'slack', 'apikey', 'internal', 'anonymous']);
const strArr = (v: unknown) => Array.isArray(v) && v.every(x => typeof x === 'string');

function validateMatch(m: any, where: string, errs: string[]) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return void errs.push(`${where}.match must be an object`);
  const keys = Object.keys(m);
  if (!keys.length) errs.push(`${where}.match is empty (would match everyone)`);
  for (const k of keys) if (!['kind', 'id', 'emailIn', 'domain', 'verified'].includes(k)) errs.push(`${where}.match.${k} unknown`);
  if (m.kind !== undefined && !KINDS.has(m.kind)) errs.push(`${where}.match.kind invalid`);
  if (m.emailIn !== undefined && !strArr(m.emailIn)) errs.push(`${where}.match.emailIn must be string[]`);
  if (m.id !== undefined && typeof m.id !== 'string') errs.push(`${where}.match.id must be string`);
  if (m.domain !== undefined && typeof m.domain !== 'string') errs.push(`${where}.match.domain must be string`);
  if (m.verified !== undefined && typeof m.verified !== 'boolean') errs.push(`${where}.match.verified must be boolean`);
}

/** Returns a list of errors; empty = valid. */
export function validatePolicy(p: any): string[] {
  const errs: string[] = [];
  if (!p || typeof p !== 'object' || Array.isArray(p)) return ['policy must be an object'];
  const roles = p.roles, profiles = p.profiles;
  if (!roles || typeof roles !== 'object' || !Object.keys(roles).length) errs.push('roles missing/empty');
  if (!profiles || typeof profiles !== 'object' || !Object.keys(profiles).length) errs.push('profiles missing/empty');
  if (errs.length) return errs;
  for (const [name, pr] of Object.entries<any>(profiles)) {
    for (const f of ['tools', 'mcps', 'env']) if (!strArr(pr?.[f])) errs.push(`profiles.${name}.${f} must be string[]`);
    if (typeof pr?.outbound !== 'boolean') errs.push(`profiles.${name}.outbound must be boolean`);
    if (!['all', 'own', 'none'].includes(pr?.readScope)) errs.push(`profiles.${name}.readScope invalid`);
    if (typeof pr?.rate !== 'string' || !RATE_RE.test(pr.rate)) errs.push(`profiles.${name}.rate invalid (e.g. "120/h")`);
  }
  for (const [name, r] of Object.entries<any>(roles)) {
    if (name === OWNER_ROLE) continue; // owner is env-rooted; its entry only picks rank/profile
    if (typeof r?.rank !== 'number' || !Number.isFinite(r.rank)) errs.push(`roles.${name}.rank must be a number`);
    if (!profiles[r?.profile]) errs.push(`roles.${name}.profile "${r?.profile}" not defined`);
  }
  if (roles[OWNER_ROLE] && !profiles[roles[OWNER_ROLE].profile]) errs.push(`roles.owner.profile not defined`);
  const ownerRank = roles[OWNER_ROLE]?.rank ?? 100;
  for (const [name, r] of Object.entries<any>(roles)) if (name !== OWNER_ROLE && r?.rank >= ownerRank) errs.push(`roles.${name}.rank must be below owner (${ownerRank})`);
  if (!Array.isArray(p.bindings)) errs.push('bindings must be an array');
  else p.bindings.forEach((b: any, i: number) => {
    validateMatch(b?.match, `bindings[${i}]`, errs);
    if (!roles[b?.role]) errs.push(`bindings[${i}].role "${b?.role}" not defined`);
    if (b?.role === OWNER_ROLE) errs.push(`bindings[${i}] cannot grant owner (OWNERS env only)`);
  });
  if (!roles[p.default]) errs.push(`default role "${p.default}" not defined`);
  if (p.default === OWNER_ROLE) errs.push('default cannot be owner');
  if (p.blocklist !== undefined) {
    if (!Array.isArray(p.blocklist)) errs.push('blocklist must be an array');
    else p.blocklist.forEach((b: any, i: number) => {
      validateMatch(b?.match, `blocklist[${i}]`, errs);
      if (b?.until !== null && b?.until !== undefined && typeof b.until !== 'number') errs.push(`blocklist[${i}].until must be number|null`);
    });
  }
  if (p.tokensValidAfter !== undefined && (typeof p.tokensValidAfter !== 'object' || Array.isArray(p.tokensValidAfter)
    || !Object.values(p.tokensValidAfter).every(v => typeof v === 'number'))) errs.push('tokensValidAfter must be Record<string, number>');
  return errs;
}

function matches(m: BindingMatch, p: Principal): boolean {
  if (m.kind !== undefined && m.kind !== p.kind) return false;
  if (m.id !== undefined && m.id !== p.id) return false;
  if (m.verified !== undefined && m.verified !== p.verified) return false;
  if (m.domain !== undefined && m.domain.toLowerCase() !== p.domain) return false;
  if (m.emailIn !== undefined && !(p.email && m.emailIn.some(e => e.toLowerCase() === p.email))) return false;
  return true;
}

interface Compiled {
  file: PolicyFile;
  roles: Map<string, RoleDef>;
  profiles: Map<string, Profile>;
  /** Roles sorted by rank desc — for effective(). */
  byRank: [string, RoleDef][];
  /** email → binding indexes that name it (emailIn); domain → indexes; rest = bindings keyed by neither. */
  byEmail: Map<string, number[]>;
  byDomain: Map<string, number[]>;
  generic: number[];
}

function compile(file: PolicyFile): Compiled {
  const byEmail = new Map<string, number[]>(), byDomain = new Map<string, number[]>(), generic: number[] = [];
  const push = (m: Map<string, number[]>, k: string, i: number) => { const l = m.get(k); l ? l.push(i) : m.set(k, [i]); };
  file.bindings.forEach((b, i) => {
    if (b.match.emailIn) b.match.emailIn.forEach(e => push(byEmail, e.toLowerCase(), i));
    else if (b.match.domain) push(byDomain, b.match.domain.toLowerCase(), i);
    else generic.push(i);
  });
  const roles = new Map(Object.entries(file.roles));
  if (!roles.has(OWNER_ROLE)) roles.set(OWNER_ROLE, { rank: 100, profile: 'full' });
  const profiles = new Map(Object.entries(file.profiles));
  if (!profiles.has(roles.get(OWNER_ROLE)!.profile)) profiles.set(roles.get(OWNER_ROLE)!.profile, { ...FULL_PROFILE });
  return { file, roles, profiles, byRank: [...roles].sort((a, b) => b[1].rank - a[1].rank), byEmail, byDomain, generic };
}

/** The fail-closed policy: owner (env) + anonymous, nothing else. */
function failClosed(): Compiled {
  return compile({
    roles: { owner: { rank: 100, profile: 'full' }, anonymous: { rank: 0, profile: 'none' } },
    profiles: { full: { ...FULL_PROFILE }, none: { ...NONE_PROFILE } },
    bindings: [], default: 'anonymous', blocklist: [], tokensValidAfter: {},
  });
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const serialize = (p: PolicyFile) => JSON.stringify(p, null, 2) + '\n';

export class PolicyOptions {
  /** Policy file location. */
  path: string = dataPath('security', 'policy.json');
  /** Legacy whitelist (string[] of emails) migrated into operator bindings when policy.json is missing. */
  whitelistPath: string = dataPath('whitelist.json');
  /** Consumer hook to extend the migrated policy (e.g. operators from a contacts store). */
  migrate?: (draft: PolicyFile) => PolicyFile | void;
  /** Called when an on-disk change was NOT made by save() and was rejected. */
  onTamper?: (info: { path: string; reason: TamperReason; expected: string | null; actual: string | null }) => void;
  /** Watch the file for hot reload. */
  watch: boolean = true;
  log: Pick<Console, 'info' | 'warn' | 'error'> = console;
}

export class Policy {
  public options: PolicyOptions;
  private compiled: Compiled = failClosed();
  /** sha256 of the content currently trusted (loaded at boot or written by save()). */
  private trustedHash: string | null = null;
  private watcher?: FSWatcher;
  private _valid = false;

  public constructor(options?: Partial<PolicyOptions>) {
    this.options = { ...new PolicyOptions(), ...options };
    this.load();
    if (this.options.watch) this.startWatch();
  }

  /** True when a valid policy is loaded (false = fail-closed mode). */
  public get valid(): boolean { return this._valid; }
  public get current(): PolicyFile { return structuredClone(this.compiled.file); }

  /** Initial load: migrate if missing; trust what's on disk; fail closed if invalid. */
  private load(): void {
    const { path: p, log } = this.options;
    if (!existsSync(p)) { this.save(this.migrate()); log.info(`[policy] migrated → ${p}`); return; }
    const raw = readFileSync(p, 'utf8');
    this.trustedHash = sha256(raw);
    this.apply(raw);
  }

  private apply(raw: string): boolean {
    let parsed: any;
    try { parsed = raw.trim() ? JSON.parse(raw) : null; } catch (e: any) { parsed = undefined; this.options.log.error(`[policy] parse failed: ${e.message}`); }
    const errs = parsed ? validatePolicy(parsed) : ['policy file is empty or unparseable'];
    if (errs.length) {
      this.options.log.error(`[policy] INVALID — failing closed (owners only): ${errs.join('; ')}`);
      this.compiled = failClosed(); this._valid = false;
      return false;
    }
    this.compiled = compile({ blocklist: [], tokensValidAfter: {}, ...parsed });
    this._valid = true;
    return true;
  }

  /** Build the initial policy from the legacy whitelist + consumer hook. */
  public migrate(): PolicyFile {
    let draft = defaultPolicy();
    try {
      if (existsSync(this.options.whitelistPath)) {
        const list = JSON.parse(readFileSync(this.options.whitelistPath, 'utf8'));
        const emails = Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string').map(e => e.trim().toLowerCase()).filter(Boolean) : [];
        if (emails.length) draft.bindings.push({ match: { kind: 'user', emailIn: emails }, role: 'operator' });
      }
    } catch (e: any) { this.options.log.error(`[policy] whitelist migration failed: ${e.message}`); }
    if (this.options.migrate) draft = this.options.migrate(draft) ?? draft;
    return draft;
  }

  /** The ONLY trusted writer. Validates, writes atomically, records provenance, applies. */
  public save(next: PolicyFile): void {
    const errs = validatePolicy(next);
    if (errs.length) throw new Error(`invalid policy: ${errs.join('; ')}`);
    const content = serialize(next);
    const p = this.options.path;
    mkdirSync(path.dirname(p), { recursive: true });
    this.trustedHash = sha256(content); // before the write, so the watcher sees a match
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, content, { mode: 0o600 });
    renameSync(tmp, p);
    this.apply(content);
  }

  /** Re-read disk; load only if it's content we wrote. Returns whether the disk state is trusted. */
  public reload(): boolean {
    const p = this.options.path;
    const raw = existsSync(p) ? readFileSync(p, 'utf8') : null;
    const actual = raw === null ? null : sha256(raw);
    if (actual === this.trustedHash) return true; // our own write (or no-op touch) — already applied
    const reason: TamperReason = raw === null ? 'deleted' : 'hash-mismatch';
    this.options.log.error(`[policy] TAMPER: ${p} changed outside save() (${reason}) — keeping last-good policy`);
    try { this.options.onTamper?.({ path: p, reason, expected: this.trustedHash, actual }); }
    catch (e: any) { this.options.log.error(`[policy] onTamper threw: ${e.message}`); }
    return false;
  }

  private startWatch(): void {
    const dir = path.dirname(this.options.path), base = path.basename(this.options.path);
    let t: ReturnType<typeof setTimeout> | undefined;
    try {
      this.watcher = watch(dir, (_ev, f) => {
        if (f && f.toString() !== base) return;
        clearTimeout(t);
        t = setTimeout(() => this.reload(), 50);
      });
      this.watcher.unref?.();
    } catch (e: any) { this.options.log.error(`[policy] watch failed: ${e.message}`); }
  }

  public close(): void { this.watcher?.close(); this.watcher = undefined; }

  private resolved(role: string): Resolved {
    const c = this.compiled;
    const def = c.roles.get(role) ?? c.roles.get(c.file.default) ?? { rank: 0, profile: 'none' };
    const name = c.roles.has(role) ? role : c.file.default;
    return { role: name, rank: def.rank, profileName: def.profile, profile: c.profiles.get(def.profile) ?? NONE_PROFILE };
  }

  /** principal → role/profile. Owner (env, verified email) first, then first matching binding, else default. */
  public resolve(p: Principal): Resolved {
    if (p.verified && p.email && isOwnerEmail(p.email)) return this.resolved(OWNER_ROLE);
    const c = this.compiled, b = c.file.bindings;
    let best = Infinity;
    const scan = (idx?: number[]) => { if (idx) for (const i of idx) { if (i >= best) break; if (matches(b[i].match, p)) { best = i; break; } } };
    if (p.email) scan(c.byEmail.get(p.email));
    if (p.domain) scan(c.byDomain.get(p.domain));
    scan(c.generic);
    return this.resolved(best === Infinity ? c.file.default : b[best].role);
  }

  /** Taint: a session's effective role is the lowest-ranked role that contributed. */
  public effective(floorRank: number, role: string): Resolved {
    const r = this.resolved(role);
    if (r.rank <= floorRank) return r;
    const lower = this.compiled.byRank.find(([, d]) => d.rank <= floorRank);
    return lower ? this.resolved(lower[0]) : this.resolved(this.compiled.byRank[this.compiled.byRank.length - 1][0]);
  }

  /** Active blocklist entry for this principal, if any. */
  public blocked(p: Principal, now = Date.now() / 1000): BlockEntry | undefined {
    return this.compiled.file.blocklist.find(e => (e.until === null || e.until > now) && matches(e.match, p));
  }

  public tokensValidAfter(principalId: string): number | undefined {
    return this.compiled.file.tokensValidAfter[principalId];
  }
}
