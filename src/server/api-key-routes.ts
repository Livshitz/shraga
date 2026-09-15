// API key list/create/delete, ONE implementation for both mounts: `/api/api-keys` (self) and `/api/owner/api-keys`
// (owner console). Gates run per route, so mounting the router never gates unrelated requests.
// Audit actor is always the caller's principal id. Store refusals (validation 400, PASSIVE 409) map to their status.
import { Router, type Request, type RequestHandler, type Response } from 'express';
import type { AuthUser } from './auth.ts';
import { apiKeyStore, ApiKeyStoreError } from './api-keys.ts';

export class ApiKeyRoutesOptions {
  base: string = '/api/api-keys';
  gate: RequestHandler[] = [];
  /** Owner console: sees/deletes every key and may set `role`/`expiresAt`. Self: own keys (all when the caller is an
   *  owner, as before) and label only. */
  asOwner: boolean = false;
}

const userOf = (req: Request) => (req as any).user as AuthUser;

function fail(res: Response, e: any): void {
  const status = e instanceof ApiKeyStoreError ? e.status : 400;
  console.warn(`[api-keys] ${e?.message ?? e}`);
  res.status(status).json({ error: e?.message ?? String(e) });
}

export function apiKeyRouter(options?: Partial<ApiKeyRoutesOptions>): Router {
  const { base, gate, asOwner } = { ...new ApiKeyRoutesOptions(), ...options };
  const router = Router();
  const isOwner = (u: AuthUser) => asOwner || u.isOwner;

  router.get(base, ...gate, (req, res) => {
    const user = userOf(req);
    res.json({ keys: apiKeyStore().list({ uid: user.uid, isOwner: isOwner(user) }) });
  });

  /** Body: { label?, role?, expiresAt? (epoch ms) } — role/expiresAt honored on the owner mount only. Plaintext returned once. */
  router.post(base, ...gate, (req, res) => {
    const user = userOf(req);
    const { label, role, expiresAt } = (req.body ?? {}) as { label?: string; role?: string; expiresAt?: number };
    try {
      const opts = asOwner ? { role, expiresAt } : {};
      res.json(apiKeyStore().create(user.uid, user.email, label || 'Unnamed', { ...opts, actor: user.principal.id }));
    } catch (e: any) { fail(res, e); }
  });

  router.delete(`${base}/:id`, ...gate, (req: Request<{ id: string }>, res) => {
    const user = userOf(req);
    try {
      const r = apiKeyStore().delete(req.params.id, user.uid, isOwner(user), user.principal.id);
      if (r === 'not_found') return void res.status(404).json({ error: 'Key not found' });
      if (r === 'forbidden') return void res.status(403).json({ error: 'Cannot delete another user\'s key' });
      res.json({ ok: true });
    } catch (e: any) { fail(res, e); }
  });

  return router;
}
