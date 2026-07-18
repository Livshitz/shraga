# Server extensions (`data/extensions/*.ext.ts`)

Per-deployment HTTP routes served on **this instance's own public URL** — OAuth/
manifest callbacks, inbound webhooks, public share/redirect pages — **without**
editing the shared `src/` codebase, and reachable (mounted *before* the SPA
catch-all).

- **Loader:** `src/server/extensions.ts` (generic, ships with shraga).
- **This folder** is seeded from `defaults/extensions/` and lives in the data
  subgit — durable, synced by data-sync, and excluded from the deploy rsync.

## Contract

Each `*.ext.ts` exports a default `register(app, ctx)`:

```ts
import type { Express } from 'express';
interface Ctx { dataPath: (p: string) => string; requireAuth: any; log: (...a: unknown[]) => void; app: Express; emitEvent: (source: string, payload: unknown, opts?: { id?: string }) => void; }

export default function register(app, ctx) {
  app.get('/api/my-thing', (req, res) => res.json({ ok: true }));
}
```

`app` is an Express Router (same `.get/.post/.use` surface). `ctx` gives you:
- `ctx.dataPath('foo.json')` — resolve a path in the active data dir
- `ctx.requireAuth` — auth middleware (bearer / api-key / internal token / `?token=`)
- `ctx.log` — prefixed logger
- `ctx.app` — the root app, for the rare case you need app-level middleware
- `ctx.emitEvent(source, payload, { id })` — publish an event onto the bus → fires
  matching `event`-trigger schedules. This is how a vendor webhook (verified here)
  turns into an agent run. See `stripe-webhook.ext.ts`.

## Hot-reload

- **New** `*.ext.ts` file → live immediately, **no restart** (the loader watches
  this dir and re-scans).
- **Editing** an already-loaded file → **needs a restart** (ESM module cache;
  re-importing would stack a duplicate handler).

## Two gotchas (each silently returns the SPA otherwise)

1. **Route order** — anything registered after `app.get('*')` is swallowed by the
   SPA catch-all and returns HTML. The loader mounts extensions before it for you;
   never add routes to `index.ts` after the catch-all.
2. **Browser-nav auth** — a route a human opens by URL (or that an external
   service redirects to) can't send an `Authorization: Bearer` header, so
   `ctx.requireAuth` 401s → falls through to the SPA. Make those routes **public**
   and guard them with a one-time `state`/signed nonce; reserve `ctx.requireAuth`
   for routes the SPA calls via `fetch` (those can also pass `?token=`).

## Example / health check

`selftest.ext.ts` ships enabled — it's the canonical example **and** a regression
probe for both gotchas:

```bash
curl -s https://<host>/api/extensions/selftest                         # {"ok":true,...}  (not SPA)
curl -s -o /dev/null -w '%{http_code}' https://<host>/api/extensions/selftest/whoami  # 401 (not SPA)
```

## When NOT to use an extension

- Reusable agent capability → a **skill** (`data/skills/`)
- Set of callable tools → an **MCP** (`/create-mcp`)
- Recurring job → the **scheduler**
- Vendor webhook → agent run → an extension that verifies the signature and calls
  `ctx.emitEvent(...)`, paired with an `event`-trigger schedule (see scheduler skill)
- Long-running daemon / one-shot CLI → **`scripts/`**
- Generic product feature for all shraga users → that belongs in `src/`
