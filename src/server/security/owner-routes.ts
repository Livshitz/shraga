// Owner-only admin API (`/api/owner/*`). Each route runs requireAuth + requireOwner itself — never router-wide, so
// mounting this router can't gate unrelated requests. The Owner Console UI (step 7) is the consumer.
import { Router, type Request, type Response } from 'express';
import { requireAuth, type AuthUser } from '../auth.ts';
import { apiKeyStore } from '../api-keys.ts';
import { requireOwner } from './owner-only.ts';
import { revokeTokens } from './revocation.ts';

const gate = [requireAuth, requireOwner()];
const userOf = (req: Request) => (req as any).user as AuthUser;
const PRINCIPAL_ID_RE = /^(user|email|slack|apikey|internal):\S+$/;

const fail = (res: Response, e: any, status = 400) => {
  console.warn(`[owner-routes] ${e?.message ?? e}`);
  res.status(status).json({ error: e?.message ?? String(e) });
};

export const ownerRouter = Router();

/** Invalidate every token issued to a principal until now. Body: { principalId }. */
ownerRouter.post('/api/owner/tokens/revoke', ...gate, (req, res) => {
  const { principalId } = (req.body ?? {}) as { principalId?: unknown };
  if (typeof principalId !== 'string' || !PRINCIPAL_ID_RE.test(principalId)) {
    return void res.status(400).json({ error: 'principalId must look like "<kind>:<id>" (e.g. "user:a@b.com")' });
  }
  try {
    const validAfter = revokeTokens(principalId, userOf(req).principal.id);
    res.json({ ok: true, principalId, validAfter });
  } catch (e: any) { fail(res, e, 409); }
});

ownerRouter.get('/api/owner/api-keys', ...gate, (req, res) => {
  res.json({ keys: apiKeyStore().list({ uid: userOf(req).uid, isOwner: true }) });
});

/** Create a key under the owner's identity. Body: { label?, role?, expiresAt? (epoch ms) }. Plaintext returned once. */
ownerRouter.post('/api/owner/api-keys', ...gate, (req, res) => {
  const user = userOf(req);
  const { label, role, expiresAt } = (req.body ?? {}) as { label?: string; role?: string; expiresAt?: number };
  try {
    res.json(apiKeyStore().create(user.uid, user.email, label || 'Unnamed', { role, expiresAt, actor: user.principal.id }));
  } catch (e: any) { fail(res, e); }
});

ownerRouter.delete('/api/owner/api-keys/:id', ...gate, (req: Request<{ id: string }>, res) => {
  const user = userOf(req);
  const r = apiKeyStore().delete(req.params.id, user.uid, true, user.principal.id);
  if (r === 'not_found') return void res.status(404).json({ error: 'Key not found' });
  res.json({ ok: true });
});
