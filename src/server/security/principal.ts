// Principal = WHO is calling, normalized across channels. Pure + sync: no I/O, no imports of auth
// (auth.ts has boot side effects). Adapters take the structural shapes the channels already hold.

export type PrincipalKind = 'user' | 'email' | 'slack' | 'apikey' | 'internal' | 'anonymous';

export interface Principal {
  /** Stable key, `<kind>:<identifier>` — used for rate buckets, audit, tokensValidAfter. */
  id: string;
  kind: PrincipalKind;
  email?: string;
  domain?: string;
  /** Identity proven by the channel (signed token, DKIM+DMARC, Slack signature…). */
  verified: boolean;
  attrs: Record<string, unknown>;
}

export function normalizeEmail(email?: string | null): string | undefined {
  const e = String(email ?? '').trim().toLowerCase();
  return e.includes('@') ? e : undefined;
}

export function emailDomain(email?: string | null): string | undefined {
  const e = normalizeEmail(email);
  return e ? e.slice(e.lastIndexOf('@') + 1) : undefined;
}

function make(kind: PrincipalKind, key: string, verified: boolean, email?: string | null, attrs: Record<string, unknown> = {}): Principal {
  const e = normalizeEmail(email);
  return { id: `${kind}:${key}`, kind, email: e, domain: emailDomain(e), verified, attrs };
}

/** Authenticated web/MCP/local user (AuthUser shape). The token was verified upstream. */
export function fromAuthUser(u: { uid: string; email?: string | null }): Principal {
  const e = normalizeEmail(u.email);
  return make('user', e ?? u.uid, true, e, { uid: u.uid });
}

/** Inbound email sender. `verified` = DKIM+DMARC aligned to the From domain (computed by the channel). */
export function fromEmailSender(from: string, verified: boolean, attrs: Record<string, unknown> = {}): Principal {
  const e = normalizeEmail(from) ?? String(from).trim().toLowerCase();
  return make('email', e, verified, e, attrs);
}

/** Slack sender (signature-verified event). Email optional (from contacts / users.info). */
export function fromSlack(slackUserId: string, opts: { email?: string | null; teamId?: string } = {}): Principal {
  return make('slack', slackUserId, true, opts.email, { slackUserId, ...(opts.teamId ? { teamId: opts.teamId } : {}) });
}

/** API key holder (validateApiKey shape). */
export function fromApiKey(k: { id?: string; uid: string; email?: string | null }): Principal {
  return make('apikey', k.id ?? k.uid, true, k.email, { uid: k.uid });
}

/** Scoped internal token (agent subprocess acting for a user), or a no-human run (`lane`: wake, scheduler, retry…). */
export function fromInternal(t: { uid: string; email?: string | null; lane?: string }): Principal {
  return make('internal', t.uid, true, t.email, { uid: t.uid, ...(t.lane ? { lane: t.lane } : {}) });
}

export function anonymous(attrs: Record<string, unknown> = {}): Principal {
  return { id: 'anonymous', kind: 'anonymous', verified: false, attrs };
}
