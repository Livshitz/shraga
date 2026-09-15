// Owner gate for admin actions. `isOwner` is set by requireAuth from the OWNERS env (owners.ts), so this
// must run AFTER requireAuth. Real enforcement (not shadow): only for system-scope mutations.
import type { Request, Response, RequestHandler } from 'express';
import { security } from './runtime.ts';

/** True if the caller is an owner; otherwise responds 403 with `message` and returns false. */
export function ownerOnly(req: Request, res: Response, message = 'Only an owner can do this'): boolean {
  if ((req as any).user?.isOwner) return true;
  res.status(403).json({ error: message });
  return false;
}

/** 403 + `auth.deny` audit unless the caller's principal kind is one of `kinds`. */
function kindGate(kinds: string[], error: string): RequestHandler {
  return (req, res, next) => {
    const kind = (req as any).user?.principal?.kind ?? 'unknown';
    if (kinds.includes(kind)) return next();
    console.warn(`[owner-only] ${req.method} ${req.path} refused: ${kind} credential`);
    security()?.authDeny(`http:${req.path}`, `non-interactive:${kind}`, req.ip);
    res.status(403).json({ error });
  };
}

/** Middleware form of ownerOnly, for policy/config/skills/MCP routes. The agent subprocess carries an owner-signed
 *  internal token (INTERNAL_API_TOKEN), so an internal principal is never owner HERE — otherwise a prompt-injected turn
 *  could rewrite its own policy. Owner = interactive login or an uncapped owner API key (CLI terminal). Inline
 *  `ownerOnly` callers (self-upgrade, schedules, modules) keep accepting the internal token. */
export function requireOwner(message?: string): RequestHandler {
  const notInternal = kindGate(['user', 'apikey'], 'Owner access requires an interactive login or an owner API key — not the agent\'s internal token');
  return (req, res, next) => { if (ownerOnly(req, res, message)) notInternal(req, res, next); };
}

/** Security-console writes: an interactive login only (no API key, no internal token) — same rule as minting a key. */
export const requireInteractive = (): RequestHandler => kindGate(['user'], 'This change requires an interactive login');
