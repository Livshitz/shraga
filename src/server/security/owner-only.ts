// Owner gate for admin actions. `isOwner` is set by requireAuth from the OWNERS env (owners.ts), so this
// must run AFTER requireAuth. Real enforcement (not shadow): only for system-scope mutations.
import type { Request, Response, RequestHandler } from 'express';

/** True if the caller is an owner; otherwise responds 403 with `message` and returns false. */
export function ownerOnly(req: Request, res: Response, message = 'Only an owner can do this'): boolean {
  if ((req as any).user?.isOwner) return true;
  res.status(403).json({ error: message });
  return false;
}

/** Middleware form of ownerOnly. */
export function requireOwner(message?: string): RequestHandler {
  return (req, res, next) => { if (ownerOnly(req, res, message)) next(); };
}
