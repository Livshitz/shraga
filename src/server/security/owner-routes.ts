// Owner-only admin API (`/api/owner/*`). Each route runs requireAuth + requireOwner itself — never router-wide, so
// mounting this router can't gate unrelated requests. Consumer: the Owner Console (client/components/owner/).
// Policy writes: validated by Policy's own validatePolicy, saved via policy.save() (provenance holds), audited as
// `policy.change` with the changed paths only (never values). Every write on a PASSIVE standby → 409.
import { createHash } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { requireAuth, type AuthUser } from '../auth.ts';
import { apiKeyRouter } from '../api-key-routes.ts';
import { apiKeyPrincipal } from '../api-keys.ts';
import { getOwners } from '../owners.ts';
import { deleteSession } from '../sessions.ts';
import { canonical, type AuditEventType } from './audit.ts';
import { matches, validatePolicy, type BindingMatch, type PolicyFile } from './policy.ts';
import { anonymous, fromAuthUser, fromEmailSender, fromInternal, fromSlack, type Principal } from './principal.ts';
import { requireInteractive, requireOwner } from './owner-only.ts';
import { revocablePrincipalId, revokeTokens } from './revocation.ts';
import { resolvePrincipal, security, type SecurityRuntime } from './runtime.ts';

/** Reads: owner via interactive login or uncapped owner API key (never the agent's internal token). */
const gate = [requireAuth, requireOwner()];
/** Writes: interactive login only. */
const writeGate = [...gate, requireInteractive()];
/** The raw INTERNAL_API_TOKEN's principal (auth.ts) — no issued-at, so tokensValidAfter can never reject it. */
const LEGACY_INTERNAL_ID = 'internal:agent-internal';
const userOf = (req: Request) => (req as any).user as AuthUser;
/** OWNERS as the principals a block could hit: each owner's login and verified email channel. */
const ownerPrincipals = () => getOwners().flatMap(e => [fromAuthUser({ uid: e, email: e }), fromEmailSender(e, true)]);

const fail = (res: Response, e: any, status = 400) => {
  console.warn(`[owner-routes] ${e?.message ?? e}`);
  res.status(status).json({ error: e?.message ?? String(e) });
};

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Opaque version of a policy document. A PUT carrying a stale version is refused, so a Console tab opened earlier
 *  can't silently undo a revoke/block made meanwhile. */
export const policyVersion = (p: PolicyFile) => createHash('sha256').update(canonical(p)).digest('hex').slice(0, 16);

/** Paths that differ, two levels deep (`profiles.standard`, `bindings.2`, `default`) — names only, never values. */
export function policyDiff(a: object, b: object, max = 30): string[] {
  const keys = (x: object, y: object) => [...new Set([...Object.keys(x), ...Object.keys(y)])];
  const out: string[] = [];
  for (const k of keys(a, b)) {
    const x = (a as any)[k], y = (b as any)[k];
    if (canonical(x) === canonical(y)) continue;
    if (x && y && typeof x === 'object' && typeof y === 'object') {
      for (const s of keys(x, y)) if (canonical(x[s]) !== canonical(y[s])) out.push(`${k}.${s}`);
    } else out.push(k);
  }
  return out.length > max ? [...out.slice(0, max), `+${out.length - max} more`] : out;
}

/** The runtime, or an error response: 503 when uninitialized; 409 for a write on a PASSIVE standby. */
function runtimeOr(res: Response, write = false): SecurityRuntime | undefined {
  const sec = security();
  if (!sec) return void res.status(503).json({ error: 'Security runtime not initialized' });
  if (write) {
    let active = false;
    try { active = sec.options.isActive(); } catch (e: any) { console.warn(`[owner-routes] isActive threw — treating as PASSIVE: ${e?.message ?? e}`); }
    if (!active) return void res.status(409).json({ error: 'Read-only on a PASSIVE standby — use the active instance' });
  }
  return sec;
}

/** Incremental edits (blocklist) start from the current document — refused in fail-closed mode, where saving would
 *  replace the broken-but-fixable file with the owners-only fallback. A whole-document PUT is the fix path. */
function requireValidPolicy(res: Response, sec: SecurityRuntime): boolean {
  if (sec.policy.valid) return true;
  res.status(409).json({ error: 'Policy is invalid (fail-closed) — fix it with a full policy save first' });
  return false;
}

/** validatePolicy → policy.save() → `policy.change` audit. Responds with the error itself; true on success. */
function commit(req: Request, res: Response, sec: SecurityRuntime, next: PolicyFile, op: string): boolean {
  const errors = validatePolicy(next);
  if (errors.length) {
    console.warn(`[owner-routes] ${op} refused: ${errors.join('; ')}`);
    res.status(400).json({ error: `Invalid policy: ${errors.join('; ')}`, errors });
    return false;
  }
  const prev = sec.policy.current;
  try { sec.policy.save(next); } catch (e: any) { fail(res, e, 500); return false; }
  sec.record({ type: 'policy.change', principal: userOf(req).principal.id, target: op, meta: { changed: policyDiff(prev, sec.policy.current) } });
  return true;
}

const KINDS = ['user', 'email', 'slack', 'apikey', 'internal', 'anonymous'];

/** A principal built by the SAME builders the channels use, from `{ kind, id?, email?, verified?, lane?, role?, attrs? }`.
 *  `role` (apikey only) = the key's role cap; for an apikey, `email` is the creator. */
export function principalFromDescriptor(d: any): Principal {
  const kind = d?.kind, email = str(d?.email), id = str(d?.id);
  const attrs: Record<string, unknown> = isObj(d?.attrs) ? { ...d.attrs } : {};
  const lane = str(d?.lane) ?? str(attrs.lane), who = id ?? email;
  if (!KINDS.includes(kind)) throw new Error(`kind must be one of ${KINDS.join(', ')}`);
  if (kind !== 'anonymous' && !who) throw new Error('id or email is required');
  let p: Principal;
  switch (kind) {
    case 'user': p = fromAuthUser({ uid: who!, email }); break;
    case 'email': p = fromEmailSender(who!, d?.verified === true); break;
    case 'slack': p = fromSlack(who!, { email }); break;
    case 'apikey': p = apiKeyPrincipal({ id: id ?? 'console-test', uid: str(attrs.uid) ?? who!, email: email ?? '', role: str(d?.role) ?? str(attrs.role) }); break;
    case 'internal': p = fromInternal({ uid: who!, email, lane }); break;
    default: p = anonymous();
  }
  if (typeof d?.verified === 'boolean') p.verified = d.verified;
  Object.assign(p.attrs, attrs, lane ? { lane } : {});
  return p;
}

const DENY_TYPES = new Set<string>(['auth.deny', 'tool.deny', 'guard.block', 'guard.limit']);
/** Events whose `role` is the ACTING principal's role. Others carry a different subject's role (key.create: the key's cap). */
const OWN_ROLE_TYPES = new Set<string>(['role.resolve', 'turn.start', 'turn.end', 'tool.allow', 'tool.deny', 'escalate']);
const PRINCIPAL_SCAN_CAP = 50_000;
export interface PrincipalRow { id: string; kind: string; lastRole?: string; lastSeen: string; turns: number; denies: number }

/** Principals in the audit since `sinceMs`, most recently seen first. Denies include shadow (would-deny) verdicts. */
export function recentPrincipals(sec: SecurityRuntime, sinceMs: number, limit: number): { principals: PrincipalRow[]; truncated: boolean } {
  const rows = new Map<string, PrincipalRow>();
  let cursor: string | undefined, scanned = 0;
  do {
    const page = sec.audit.query({ from: sinceMs, limit: 1000, cursor });
    for (const r of page.items) {
      scanned++;
      if (!r.principal) continue;
      let row = rows.get(r.principal);
      if (!row) rows.set(r.principal, row = { id: r.principal, kind: r.principal.split(':')[0], lastSeen: r.ts, turns: 0, denies: 0 });
      if (!row.lastRole && r.role && OWN_ROLE_TYPES.has(r.type)) row.lastRole = r.role;
      if (r.type === 'turn.start') row.turns++;
      else if (DENY_TYPES.has(r.type)) row.denies++;
    }
    cursor = page.nextCursor;
  } while (cursor && scanned < PRINCIPAL_SCAN_CAP);
  return { principals: [...rows.values()].slice(0, limit), truncated: !!cursor };
}

const clampInt = (v: unknown, def: number, min: number, max: number) => Math.max(min, Math.min(max, Math.floor(Number(v)) || def));
const when = (v: unknown): Date | undefined => {
  const s = str(v);
  if (!s) return undefined;
  const d = new Date(/^\d+$/.test(s) ? Number(s) : s);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid date "${s}"`);
  return d;
};

export const ownerRouter = Router();

// ── Tokens + API keys ─────────────────────────────────────────────────────────

/** Invalidate every token issued to a principal until now. Body: { principalId: "user:<email|uid>" | "internal:<uid>" }. */
ownerRouter.post('/api/owner/tokens/revoke', ...writeGate, (req, res) => {
  const { principalId } = (req.body ?? {}) as { principalId?: unknown };
  const id = typeof principalId === 'string' ? revocablePrincipalId(principalId) : null;
  if (!id) {
    return void res.status(400).json({
      error: 'principalId must be "user:<email|uid>" or "internal:<uid>" (the token kinds revocation checks). '
        + 'To revoke an API key, DELETE /api/owner/api-keys/:id.',
    });
  }
  if (id === LEGACY_INTERNAL_ID) {
    return void res.status(400).json({
      error: `${LEGACY_INTERNAL_ID} is the legacy shared internal token, which carries no issue time — it can only be `
        + 'rotated by changing INTERNAL_API_TOKEN and restarting.',
    });
  }
  try {
    const validAfter = revokeTokens(id, userOf(req).principal.id);
    res.json({ ok: true, principalId: id, validAfter });
  } catch (e: any) { fail(res, e, 409); }
});

ownerRouter.use(apiKeyRouter({ base: '/api/owner/api-keys', gate, writeGate: [requireInteractive()], asOwner: true }));

// ── Policy ────────────────────────────────────────────────────────────────────

ownerRouter.get('/api/owner/policy', ...gate, (_req, res) => {
  const sec = runtimeOr(res);
  if (!sec) return;
  const policy = sec.policy.current;
  // ownerIds: a UI hint (hide Block on owner rows); the block route enforces it.
  res.json({ policy, version: policyVersion(policy), valid: sec.policy.valid, ownerIds: ownerPrincipals().map(p => p.id) });
});

/** Body: { policy, version } — the whole document; `version` (from GET, required) guards against overwriting a newer
 *  save. `tokensValidAfter` and `blocklist` always come from the CURRENT policy — they change only via their own routes,
 *  so a PUT can't un-revoke or un-block. */
ownerRouter.put('/api/owner/policy', ...writeGate, (req, res) => {
  const sec = runtimeOr(res, true);
  if (!sec) return;
  const { policy, version } = (req.body ?? {}) as { policy?: unknown; version?: unknown };
  if (!isObj(policy)) return void res.status(400).json({ error: 'Body must be { policy, version }' });
  const current = sec.policy.current;
  if (version !== policyVersion(current)) {
    return void res.status(409).json({ error: version === undefined ? 'version is required — GET the policy first' : 'The policy changed since you loaded it — reload and re-apply your edit' });
  }
  const next = { ...policy, tokensValidAfter: current.tokensValidAfter, blocklist: current.blocklist } as PolicyFile;
  if (commit(req, res, sec, next, 'policy')) res.json({ ok: true, version: policyVersion(sec.policy.current), valid: sec.policy.valid });
});

/** Resolve a descriptor exactly as a turn would (resolvePrincipal — decide()'s path), without auditing `role.resolve`. */
ownerRouter.post('/api/owner/policy/test', ...gate, (req, res) => {
  const sec = runtimeOr(res);
  if (!sec) return;
  let p: Principal;
  try { p = principalFromDescriptor(req.body); } catch (e: any) { return fail(res, e); }
  const r = resolvePrincipal(sec.policy, p);
  res.json({ principal: p.id, role: r.role, rank: r.rank, profile: r.profileName, capabilities: r.profile, blocked: sec.policy.blocked(p) ?? null });
});

// ── Principals ────────────────────────────────────────────────────────────────

/** Query: days (1–90, default 7), limit (1–500, default 200). */
ownerRouter.get('/api/owner/principals', ...gate, (req, res) => {
  const sec = runtimeOr(res);
  if (!sec) return;
  const days = clampInt(req.query.days, 7, 1, 90), limit = clampInt(req.query.limit, 200, 1, 500);
  try { res.json({ days, ...recentPrincipals(sec, Date.now() - days * 86_400_000, limit) }); } catch (e: any) { fail(res, e, 500); }
});

// ── Blocklist ─────────────────────────────────────────────────────────────────

/** Manual entries (policy blocklist, `until` epoch SECONDS) + guard auto-blocks (`until` epoch MS). */
ownerRouter.get('/api/owner/blocks', ...gate, (_req, res) => {
  const sec = runtimeOr(res);
  if (!sec) return;
  res.json({ manual: sec.policy.current.blocklist.map((b, index) => ({ index, ...b })), auto: sec.guard.list() });
});

/** Body: { match, until?: epoch seconds | null, reason? } — a manual block. */
ownerRouter.post('/api/owner/blocks', ...writeGate, (req, res) => {
  const sec = runtimeOr(res, true);
  if (!sec || !requireValidPolicy(res, sec)) return;
  const { match, until = null, reason } = (req.body ?? {}) as { match?: unknown; until?: unknown; reason?: unknown };
  const owner = isObj(match) && ownerPrincipals().find(p => matches(match as BindingMatch, p));
  if (owner) return void res.status(400).json({ error: `This block would match the owner ${owner.email ?? owner.id} — owners can't be blocked (change OWNERS instead)` });
  if (until !== null && (typeof until !== 'number' || until >= 1e11)) return void res.status(400).json({ error: 'until must be epoch SECONDS or null' });
  if (typeof until === 'number' && until <= Date.now() / 1000) return void res.status(400).json({ error: 'until is in the past' });
  const next = sec.policy.current;
  next.blocklist = [...next.blocklist, { match: match as BindingMatch, until, ...(str(reason) ? { reason: str(reason) } : {}) }];
  if (commit(req, res, sec, next, 'blocklist.add')) res.json({ ok: true, index: next.blocklist.length - 1 });
});

/** Body: { source: "manual", index, match } (match must still equal the entry at index) | { source: "auto", key }. */
ownerRouter.delete('/api/owner/blocks', ...writeGate, (req, res) => {
  const sec = runtimeOr(res, true);
  if (!sec) return;
  const b = (req.body ?? {}) as { source?: unknown; index?: unknown; match?: unknown; key?: unknown };
  if (b.source === 'auto') {
    if (typeof b.key !== 'string' || !sec.guard.unblock(b.key)) return void res.status(404).json({ error: 'No such auto-block' });
    sec.record({ type: 'policy.change', principal: userOf(req).principal.id, target: `auto-block:${b.key}`, meta: { op: 'auto-block.clear' } });
    return void res.json({ ok: true });
  }
  if (b.source !== 'manual') return void res.status(400).json({ error: 'source must be "manual" or "auto"' });
  if (!requireValidPolicy(res, sec)) return;
  const next = sec.policy.current;
  const entry = typeof b.index === 'number' && Number.isInteger(b.index) ? next.blocklist[b.index] : undefined;
  if (!entry) return void res.status(404).json({ error: 'No such manual block' });
  if (canonical(entry.match) !== canonical(b.match)) return void res.status(409).json({ error: 'The blocklist changed since you loaded it — reload' });
  next.blocklist = next.blocklist.filter((_, i) => i !== b.index);
  if (commit(req, res, sec, next, 'blocklist.remove')) res.json({ ok: true });
});

// ── Sessions ──────────────────────────────────────────────────────────────────

/** Delete a conversation (index entry, conversation files, uploads). 409 while a turn runs. Audit keeps its records. */
ownerRouter.delete('/api/owner/sessions/:id', ...writeGate, (req, res) => {
  const sec = runtimeOr(res, true);
  if (!sec) return;
  const id = String(req.params.id), r = deleteSession(id);
  if (!r.ok) {
    const [status, error] = ({ invalid: [400, 'Invalid session id'], not_found: [404, 'No such session'], running: [409, 'A turn is running in this session — stop it first'] } as const)[r.reason];
    return void res.status(status).json({ error });
  }
  const user = userOf(req);
  sec.record({ type: 'session.delete', principal: user.principal.id, sessionId: id, meta: { ownerUid: user.uid, sessionUid: r.meta.uid } });
  res.json({ ok: true });
});

// ── Audit ─────────────────────────────────────────────────────────────────────

/** Query: from, to (ISO or epoch ms), type (comma list), principal, limit (1–500, default 100), cursor. Newest first. */
ownerRouter.get('/api/owner/audit', ...gate, (req, res) => {
  const sec = runtimeOr(res);
  if (!sec) return;
  try {
    const type = str(req.query.type)?.split(',').map(s => s.trim()).filter(Boolean) as AuditEventType[] | undefined;
    res.json(sec.audit.query({
      from: when(req.query.from), to: when(req.query.to), type, principal: str(req.query.principal),
      limit: clampInt(req.query.limit, 100, 1, 500), cursor: str(req.query.cursor),
    }));
  } catch (e: any) { fail(res, e, /cursor|date/.test(e?.message ?? '') ? 400 : 500); }
});

ownerRouter.get('/api/owner/audit/verify', ...gate, (_req, res) => {
  const sec = runtimeOr(res);
  if (sec) res.json(sec.audit.verify());
});
