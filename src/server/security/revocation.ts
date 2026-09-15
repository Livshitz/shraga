// Token revocation: `policy.tokensValidAfter[principalId]` (epoch seconds). A token whose issued-at is BEFORE it is
// rejected. The check is one object lookup on the compiled policy — no I/O per request.
//
// Issued-at per token format (auth.ts):
// - local `sha_` / MCP `mcp_` / scoped internal tokens carry `iat` since this step. Tokens minted earlier have none:
//   local + MCP ones are treated as issued at `exp - TTL` (their TTL is fixed), scoped internal ones (no exp) at 0,
//   so ANY revocation of that principal kills them.
// - Firebase ID tokens: `auth_time` (the sign-in time — `iat` is refreshed hourly and would survive revocation).
// Granularity is one second: a token minted in the same second as, but before, the revocation still passes.
import { security } from './runtime.ts';

/** True when any of `principalIds` has `tokensValidAfter` later than `issuedAtSec`. Uninitialized runtime ⇒ false. */
export function tokenRevoked(principalIds: string | string[], issuedAtSec: number): boolean {
  const policy = security()?.policy;
  if (!policy) return false;
  for (const id of Array.isArray(principalIds) ? principalIds : [principalIds]) {
    const after = policy.tokensValidAfter(id);
    if (after !== undefined && issuedAtSec < after) return true;
  }
  return false;
}

/** Issued-at of a verified Firebase ID token payload, for revocation: sign-in time, falling back to iat, else 0. */
export function firebaseIssuedAt(payload: { auth_time?: unknown; iat?: unknown }): number {
  const t = Number(payload.auth_time ?? payload.iat ?? 0);
  return Number.isFinite(t) ? t : 0;
}

/** Invalidate every token issued to `principalId` until now. `actor` = who did it (principal id), for the audit.
 *  Throws when the runtime is missing, PASSIVE, or the policy is invalid. Returns the new epoch (seconds). */
export function revokeTokens(principalId: string, actor?: string, now = Date.now()): number {
  const sec = security();
  if (!sec) throw new Error('security runtime not initialized');
  const validAfter = Math.floor(now / 1000);
  sec.policy.setTokensValidAfter(principalId, validAfter);
  sec.record({ type: 'token.revoke', principal: actor, target: principalId, meta: { validAfter } });
  sec.options.log.info(`[revocation] tokens revoked for ${principalId} (validAfter=${validAfter}) by ${actor ?? 'system'}`);
  return validAfter;
}
