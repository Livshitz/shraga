import { test, expect, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';

// The webhook lane's turn runs as the API key's principal WITH its role cap (apiKeyPrincipal), not a bare fromApiKey.
delete process.env.DATA_SYNC_ENABLE;
delete process.env.DATA_SYNC_REPO;

const CREATOR = `wl-${Date.now()}@lane.test`;
const root = mkdtempSync(path.join(tmpdir(), 'wl-principal-'));
const { initSecurity, __resetSecurityForTest } = await import('../runtime.ts');
const { registerEngine } = await import('../../engine/index.ts');
const { createWebhookLaneFeature } = await import('../../webhook-lane/feature.ts');
const { ApiKeyStore, apiKeyStore } = await import('../../api-keys.ts');
afterAll(() => { __resetSecurityForTest(); rmSync(root, { recursive: true, force: true }); });

registerEngine({
  name: 'wl-probe-engine',
  async *stream() { yield { type: 'text_delta', text: 'ok' }; yield { type: 'done', sessionId: 's' }; },
  getModels: () => [],
} as any);

test('a guest-capped key on the webhook lane runs its turn as guest (creator is operator)', async () => {
  const rt = initSecurity({
    policy: { path: path.join(root, 'security', 'policy.json'), whitelistPath: path.join(root, 'w.json'), watch: false },
    audit: { dir: path.join(root, 'audit') }, notify: () => {}, isActive: () => true,
  });
  rt.policy.save({ ...rt.policy.current, bindings: [{ match: { emailIn: [CREATOR] }, role: 'operator' } as any] });
  // The lane validates through the process-wide store; point a temp store at its own file and use it for both.
  // Restored in finally — the store is process-global and sibling files (owner-gates PASSIVE 409) read it.
  const prevStore = { ...apiKeyStore().options };
  Object.assign(apiKeyStore().options, new ApiKeyStore({ path: path.join(root, 'api-keys.json'), isActive: () => true }).options);
  const capped = apiKeyStore().create(CREATOR, CREATOR, 'lane-guest', { role: 'guest' });
  const uncapped = apiKeyStore().create(CREATOR, CREATOR, 'lane-plain');

  const cb = Bun.serve({ port: 0, fetch: () => Response.json({ ok: true }) });
  const app = express(); app.use(express.json());
  createWebhookLaneFeature({ name: `wl-${Date.now()}`, route: '/lane/turn' }).register({ app, passive: false } as any);
  const server = app.listen(0);
  const port = (server.address() as any).port;
  try {
    const turn = (key: string, convId: string) => fetch(`http://localhost:${port}/lane/turn`, {
      method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ connId: 'c', convId, msgId: 'm', prompt: '[engine:wl-probe-engine] hi', callback: { url: `http://localhost:${cb.port}/cb`, secret: 's' } }),
    });
    const sidCapped = `wl-capped-${Date.now()}`, sidPlain = `wl-plain-${Date.now()}`;
    expect((await turn(capped.key, sidCapped)).status).toBe(200);
    expect((await turn(uncapped.key, sidPlain)).status).toBe(200);
    const recs = (type: 'turn.start' | 'turn.end') => rt.audit.query({ limit: 1000, type }).items;
    for (let i = 0; i < 40 && recs('turn.end').filter(r => r.sessionId === sidCapped || r.sessionId === sidPlain).length < 2; i++) await Bun.sleep(50);
    const start = (sid: string) => recs('turn.start').find(r => r.sessionId === sid);
    expect(start(sidCapped)).toMatchObject({ principal: `apikey:${capped.id}`, role: 'guest' });
    expect(start(sidPlain)).toMatchObject({ principal: `apikey:${uncapped.id}`, role: 'operator' }); // control: no cap ⇒ creator
  } finally { server.close(); cb.stop(true); Object.assign(apiKeyStore().options, prevStore); }
});
