// Runnable example: consume Shraga as a Node library.
//
//   bun run examples/consume.ts
//
// Registers a trivial feature (adds a REST route), a verified webhook, and an event subscriber,
// then starts the server. Hit it:
//   curl localhost:3032/api/example/hello
//   curl -X POST localhost:3032/api/webhooks/demo -H 'content-type: application/json' -d '{"id":"1","hi":"there"}'
//
// Runs against a throwaway data dir so it never touches your real ./data.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createShraga, type ServerFeature } from '../src/index.ts';

const dataDir = path.join(mkdtempSync(path.join(tmpdir(), 'shraga-example-')), 'data');

const helloFeature: ServerFeature = {
  name: 'example',
  register(ctx) {
    ctx.app.get('/api/example/hello', (_req, res) => res.json({ ok: true, from: 'example feature' }));
    console.log('[example] mounted GET /api/example/hello');
  },
};

const app = createShraga({
  port: Number(process.env.PORT) || 3032,
  dataDir,
  authProvider: 'local',
  installSignalHandlers: true,
  runtimeRegistration: true, // opt-in: allow post-start extension/webhook/event registration below
});

app.registerFeature(helloFeature);

// A verified webhook — the only per-vendor piece is `verify`; dispatch + typing are generic.
app.registerWebhook({
  source: 'demo',
  verify: (_req, raw) => raw.length > 0, // accept any non-empty body (a real one checks an HMAC)
});

// A typed event subscriber — fires when the webhook above emits.
app.on('demo', (payload) => {
  console.log('[example] received demo event:', JSON.stringify(payload));
});

const handle = await app.start();
console.log(`[example] Shraga listening at ${handle.url}`);
console.log('[example] try:  curl ' + handle.url + '/api/example/hello');

// ── Runtime plug-and-play (opt-in) ──────────────────────────────────────────
// AFTER start(), register an extension + webhook and subscribe to an event on the LIVE server —
// they mount on the persistent extension Router (before the SPA catch-all) and the in-process bus.
await handle.registerExtension((router) => {
  router.get('/api/example/runtime', (_req, res) => res.json({ ok: true, from: 'runtime extension' }));
  console.log('[example] runtime-mounted GET /api/example/runtime');
});
await handle.registerWebhook({ source: 'demo-rt', verify: (_req, raw) => raw.length > 0 });
handle.on('demo-rt', (payload) => console.log('[example] received demo-rt event:', JSON.stringify(payload)));
console.log('[example] try:  curl ' + handle.url + '/api/example/runtime');
console.log(`[example] try:  curl -X POST ${handle.url}/api/webhooks/demo-rt -d '{"id":"r1"}'`);
