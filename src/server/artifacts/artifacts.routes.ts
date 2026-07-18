import { Router, type Request } from 'express';
import { requireAuth } from '../auth.ts';
import { getArtifact, getArtifactHtml, listArtifacts } from './artifacts.service.ts';

export const artifactsRouter = Router();

artifactsRouter.get('/api/artifacts/:sid', requireAuth, (req: Request<{ sid: string }>, res) => {
  const artifacts = listArtifacts(req.params.sid);
  res.json(artifacts);
});

// No auth — served as iframe src (session IDs are unguessable UUIDs)
artifactsRouter.get('/api/artifacts/:sid/:id', (req: Request<{ sid: string; id: string }>, res) => {
  const html = getArtifactHtml(req.params.sid, req.params.id);
  if (!html) return res.sendStatus(404);
  res.type('html').send(html);
});

artifactsRouter.get('/api/artifacts/:sid/:id/meta', requireAuth, (req: Request<{ sid: string; id: string }>, res) => {
  const artifact = getArtifact(req.params.sid, req.params.id);
  if (!artifact) return res.sendStatus(404);
  res.json(artifact.meta);
});

// PNG export (Puppeteer) is not part of CE. An EE overlay adds the
// `POST /api/artifacts/:sid/:id/export` route and declares the `artifactPngExport` capability flag.
