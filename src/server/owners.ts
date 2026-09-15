// The root of trust for "who owns this deployment": the OWNERS env var. Dependency-free on
// purpose — auth, notify-owners and the security policy all join on it, so it must not import any
// of them.

/** OWNERS="email1,email2" → lowercased, trimmed, de-duplicated list. Read per call (env may change in tests). */
export function getOwners(): string[] {
  return [...new Set((process.env.OWNERS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean))];
}

/** Is this email an owner? Empty/unknown is NOT an owner (fail-closed). */
export function isOwnerEmail(email: string | undefined | null): boolean {
  const e = String(email ?? '').trim().toLowerCase();
  return !!e && getOwners().includes(e);
}
