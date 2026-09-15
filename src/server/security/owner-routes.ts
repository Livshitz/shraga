// Owner-only admin API (`/api/owner/*`). Each route runs requireAuth + requireOwner itself — never router-wide, so
// mounting this router can't gate unrelated requests. The Owner Console UI (step 7) is the consumer.
import { Router, type Request, type Response } from 'express';
import { requireAuth, type AuthUser } from '../auth.ts';
import { apiKeyRouter } from '../api-key-routes.ts';
import { requireOwner } from './owner-only.ts';
import { revocablePrincipalId, revokeTokens } from './revocation.ts';

const gate = [requireAuth, requireOwner()];
const userOf = (req: Request) => (req as any).user as AuthUser;

const fail = (res: Response, e: any, status = 400) => {
  console.warn(`[owner-routes] ${e?.message ?? e}`);
  res.status(status).json({ error: e?.message ?? String(e) });
};

export const ownerRouter = Router();

/** Invalidate every token issued to a principal until now. Body: { principalId: "user:<email|uid>" | "internal:<uid>" }. */
ownerRouter.post('/api/owner/tokens/revoke', ...gate, (req, res) => {
  const { principalId } = (req.body ?? {}) as { principalId?: unknown };
  const id = typeof principalId === 'string' ? revocablePrincipalId(principalId) : null;
  if (!id) {
    return void res.status(400).json({
      error: 'principalId must be "user:<email|uid>" or "internal:<uid>" (the token kinds revocation checks). '
        + 'To revoke an API key, DELETE /api/owner/api-keys/:id.',
    });
  }
  try {
    const validAfter = revokeTokens(id, userOf(req).principal.id);
    res.json({ ok: true, principalId: id, validAfter });
  } catch (e: any) { fail(res, e, 409); }
});

ownerRouter.use(apiKeyRouter({ base: '/api/owner/api-keys', gate, asOwner: true }));
