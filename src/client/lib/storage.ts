const LEGACY_PREFIX = 'unclaw:';
const PREFIX = 'shraga:';

// Deliberately NOT migrated: the legacy `unclaw_auth_token` key (underscore, so it falls outside
// LEGACY_PREFIX by design — not an oversight).
//   - It's a LOCAL-auth-only key on both sides (`shraga_token` here is read only in the local
//     branch of useAuth; Firebase mode uses the SDK's own persistence, which this never touches).
//   - The two token formats differ and are signed with different secrets. This app's local token
//     is `sha_<sig>.<base64url(email:exp)>` and `decodeLocalEmail` assumes that 4-char prefix,
//     while verifyLocalToken hard-rejects anything not starting with `sha_`.
// Carrying it over would seat a token this server rejects into the "I'm logged in" slot — a broken
// half-authed state until the first 401 — instead of a clean login prompt. Re-login is correct.

/**
 * One-time rename of legacy `unclaw:*` localStorage keys to `shraga:*`.
 *
 * UI prefs (sidebar, drafts, artifact panel) are keyed by prefix, so a plain rename in code would
 * silently reset every existing user. Migrating by prefix — rather than an explicit key list —
 * also covers dynamic keys like `unclaw:draft:<id>`.
 *
 * Runs before first render. Existing canonical keys always win, so this can never clobber newer
 * state, and re-running is a no-op.
 */
export function migrateLegacyStorageKeys(): void {
  try {
    const legacy = Object.keys(localStorage).filter(k => k.startsWith(LEGACY_PREFIX));
    for (const oldKey of legacy) {
      const newKey = PREFIX + oldKey.slice(LEGACY_PREFIX.length);
      if (localStorage.getItem(newKey) === null) {
        const v = localStorage.getItem(oldKey);
        if (v !== null) localStorage.setItem(newKey, v);
      }
      localStorage.removeItem(oldKey);
    }
  } catch (e) {
    // Storage can throw (disabled/full/private mode). A failed migration only costs reset prefs.
    console.warn('[storage] legacy key migration skipped:', e instanceof Error ? e.message : String(e));
  }
}
