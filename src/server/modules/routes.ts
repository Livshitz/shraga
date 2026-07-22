/** REST surface for data-plane modules. Reads: any authed user. Mutations: owner-gated
 *  (modules are system-scope, like schedule edits on records you don't own). */
import type { Express, RequestHandler, Request, Response } from 'express';
import { loadState, listAvailableModules, installModule, enableModule, disableModule, setModuleConfig, uninstallModule, readManifest } from './service.ts';
import { dataPath } from '../paths.ts';

function ownerOnly(req: Request, res: Response): boolean {
  const user = (req as any).user;
  if (user?.isOwner) return true;
  res.status(403).json({ error: 'Only an owner can manage modules' });
  return false;
}

export function registerModuleRoutes(app: Express, requireAuth: RequestHandler): void {
  app.get('/api/modules', requireAuth, (_req, res) => {
    const installed = loadState().installed.map((rec) => {
      let manifest = null;
      try { manifest = readManifest(dataPath('modules', rec.name)); } catch { /* folder missing */ }
      return { ...rec, manifest };
    });
    const installedNames = new Set(installed.map((m) => m.name));
    const available = listAvailableModules().filter((m) => !installedNames.has(m.name));
    res.json({ installed, available });
  });

  app.post('/api/modules/install', requireAuth, (req, res) => {
    if (!ownerOnly(req, res)) return;
    const { name, path: folder } = req.body ?? {};
    try {
      const rec = installModule({ name: typeof name === 'string' ? name : undefined, path: typeof folder === 'string' ? folder : undefined });
      res.json(rec);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post('/api/modules/:name/enable', requireAuth, (req, res) => {
    if (!ownerOnly(req, res)) return;
    try { res.json(enableModule(String(req.params.name))); }
    catch (err) { res.status(404).json({ error: (err as Error).message }); }
  });

  app.post('/api/modules/:name/disable', requireAuth, (req, res) => {
    if (!ownerOnly(req, res)) return;
    try { res.json(disableModule(String(req.params.name))); }
    catch (err) { res.status(404).json({ error: (err as Error).message }); }
  });

  app.put('/api/modules/:name/config', requireAuth, (req, res) => {
    if (!ownerOnly(req, res)) return;
    try { res.json(setModuleConfig(String(req.params.name), req.body ?? {})); }
    catch (err) {
      const msg = (err as Error).message;
      res.status(msg.includes('not installed') ? 404 : 400).json({ error: msg });
    }
  });

  app.delete('/api/modules/:name', requireAuth, (req, res) => {
    if (!ownerOnly(req, res)) return;
    try { uninstallModule(String(req.params.name)); res.json({ ok: true }); }
    catch (err) { res.status(404).json({ error: (err as Error).message }); }
  });
}
