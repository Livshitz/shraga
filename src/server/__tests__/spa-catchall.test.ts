import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import express from 'express';
import { registerSpaCatchAll } from '../spa-catchall.ts';

const INDEX_MARKER = '<div id="root"></div><!-- spa-catchall-test -->';

let distDir: string;

beforeAll(() => {
  distDir = mkdtempSync(path.join(tmpdir(), 'shraga-dist-'));
  writeFileSync(path.join(distDir, 'index.html'), INDEX_MARKER);
});
afterAll(() => rmSync(distDir, { recursive: true, force: true }));

function buildApp() {
  const app = express();
  app.get('/api/version', (_req, res) => res.json({ version: 'test' }));
  app.get('/api/does-not-exist-real-route', (_req, res) => res.json({ real: true }));
  registerSpaCatchAll(app, distDir);
  return app;
}

async function req(app: express.Express, url: string): Promise<{ status: number; body: string }> {
  const server = app.listen(0);
  const port = (server.address() as import('net').AddressInfo).port;
  try {
    const r = await fetch(`http://127.0.0.1:${port}${url}`);
    return { status: r.status, body: await r.text() };
  } finally {
    server.close();
  }
}

describe('registerSpaCatchAll', () => {
  it('serves index.html for client deep-link routes', async () => {
    const app = buildApp();
    for (const url of ['/oauth/authorize', '/cli-auth', '/session/abc', '/']) {
      const r = await req(app, url);
      expect(r.status).toBe(200);
      expect(r.body).toContain(INDEX_MARKER);
    }
  });

  it('lets unmatched /api/* fall through to a real 404 (not the SPA shell)', async () => {
    const r = await req(buildApp(), '/api/nope');
    expect(r.status).toBe(404);
    expect(r.body).not.toContain(INDEX_MARKER);
  });

  it('does not shadow a real API route', async () => {
    const r = await req(buildApp(), '/api/version');
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ version: 'test' });
  });

  it('lets unmatched /mcp and /.well-known fall through, not the SPA', async () => {
    for (const url of ['/mcp/anything', '/.well-known/oauth-authorization-server']) {
      const r = await req(buildApp(), url);
      expect(r.status).toBe(404);
      expect(r.body).not.toContain(INDEX_MARKER);
    }
  });

  it('re-registration stays LAST — a route mounted after the first catch-all still wins', async () => {
    const app = express();
    registerSpaCatchAll(app, distDir); // first mount (like passive boot)
    app.get('/promoted/route', (_req, res) => res.json({ promoted: true })); // added "after" (like activation)
    registerSpaCatchAll(app, distDir); // re-place (activateConsumers) — splices the stale catch-all
    const r = await req(app, '/promoted/route');
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ promoted: true });
    // and a plain client route still gets the SPA
    const spa = await req(app, '/some/client/route');
    expect(spa.body).toContain(INDEX_MARKER);
  });

  it('is a no-op when dist does not exist (dev / Vite serves SPA)', async () => {
    const app = express();
    registerSpaCatchAll(app, path.join(distDir, 'nonexistent'));
    const r = await req(app, '/anything');
    expect(r.status).toBe(404); // no catch-all registered
  });
});
