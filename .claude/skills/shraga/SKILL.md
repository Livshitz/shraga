---
name: shraga
description: How to consume, extend, embed, and operate a Shraga instance — the seams (features, extensions, event bus + webhooks, engines, client slots), the SHRAGA_OVERLAY contract, and the generic deploy/overlay/pin model. Load when working WITH Shraga: adding a capability, embedding it as a library, or running an instance.
triggers:
  - extend shraga
  - add a shraga feature
  - embed shraga
  - shraga overlay
  - shraga webhook
  - shraga engine
  - manage shraga instance
  - deploy shraga
---

# Working with Shraga

Shraga is a self-hostable, multi-user web UI that delegates work to an AI coding agent. This skill
is the map: WHAT each seam is and WHEN to reach for it. For HOW, follow the pointers into the code —
they are load-bearing, read them before you build. Start with [`AGENTS.md`](../../../AGENTS.md) and
[`README.md`](../../../README.md); this skill assumes you've skimmed the former.

## Mental model

- **Small core + optional seams.** The core owns conversations, sessions, skills, scheduling, auth,
  and the MCP endpoint. Everything else attaches through a seam. The core names no add-on concept —
  if you're adding an add-on's vocabulary to a core file, you're on the wrong side of a seam
  (AGENTS.md → "The core rule").
- **Library-first.** The public surface is `createShraga(options)` in
  [`src/index.ts`](../../../src/index.ts) → register against seams → `await start()` → a
  `ServerHandle`. The CLI and the run-from-source entry both dogfood `createShraga(fromEnv()).start()`.
- **The agent runtime is swappable.** Claude Code is the built-in engine; other runtimes plug in via
  the engine seam ([`src/server/engine/`](../../../src/server/engine/)).
- **No database.** All state is flat JSON/JSONL under `data/`, resolved through
  `src/server/paths.ts` (`dataPath()`), honouring `DATA_DIR`. `data/` is seeded from `defaults/` at
  boot by `src/server/seed.ts` (skills/extensions treated as code — overwritten; other files created
  only when missing).

## Consume it — two real tiers

1. **CLI / `bunx shraga`** — env-configured, zero code. `createShraga(fromEnv()).start()` under the
   hood; configure with `PORT` / `DATA_DIR` / `AUTH_PROVIDER` / `.env`. Seed a local user with
   `shraga user add <email> <password>`. This is the standard self-host.
2. **Library embed** — `import { createShraga } from 'shraga'`, register against the seams, own the
   lifecycle (`start()` → `ServerHandle`, `stop()` to shut down without exiting the process). See
   README → "Use as a library" and the `ShragaOptions` doc-comments in `src/index.ts`.

Registration (`registerFeature` / `registerEngine` / `registerExtension` / `registerWebhook` / `on`)
is meant to run **before** `start()`. Post-start plug-and-play is **opt-in**: set
`runtimeRegistration: true` (or `SHRAGA_RUNTIME_REGISTRATION=1`) and the `ServerHandle`'s
`registerExtension` / `registerWebhook` / `on` mount onto the live extension Router / event bus.
Off by default; those handle methods throw until enabled. Features and engines mount at boot and are
**never** runtime-registerable.

*(There is no cwd `shraga.config.ts` for the library tier — configure via options/env. Only the
data-dir `shraga.config.ts` below is real.)*

## Extend it — pick the seam

Each seam is reachable two ways that funnel to the SAME registry: programmatically before boot via
`createShraga(...)`, or via the file/env door. Full detail: AGENTS.md → "The extension seams".

| Seam | Where | Use it WHEN |
|------|-------|-------------|
| **Server feature** | `registerFeature(...)`, [`src/server/features.ts`](../../../src/server/features.ts) | A full multi-module capability — routes + WS + consumers, optional `flags` (turns its own UI on) and `sidecarRoutes`. |
| **Route extension** | `data/extensions/*.ext.ts`, [`src/server/extensions.ts`](../../../src/server/extensions.ts) | A thin per-deployment public route (webhook, OAuth callback) with no `src/` change. New files hot-load; editing one needs a restart. Read `defaults/extensions/selftest.ext.ts` first. |
| **Event bus + webhook** | `registerWebhook(...)` / `on(...)`, [`src/server/events/`](../../../src/server/events/) | A verified vendor webhook → typed event. Mounts PUBLIC `POST /api/webhooks/<source>`, runs the per-vendor `verify` over the raw body, emits the typed event (which fires matching `event`-trigger schedules). A webhook IS an extension. Example: `defaults/extensions/stripe-webhook.ext.ts`. |
| **Engine** | `registerEngine(...)`, [`src/server/engine/`](../../../src/server/engine/) | Swap or add the agent runtime behind the engine seam. |
| **Client slot** | [`src/client/lib/slots.tsx`](../../../src/client/lib/slots.tsx) | Inject UI (input adornments, settings sections, tool renderers, status chips…) without a core component importing add-on code. |

**Decision guide:** thin per-deployment webhook/route → `*.ext.ts`. A full multi-module capability →
a `ServerFeature`. A private / per-deployment feature you want attached without forking the public
repo → an **overlay** (below).

Generic inbound events (no vendor signature) go to the auth-gated `POST /api/events/:source`, which
publishes onto the bus the same way a verified webhook does.

## The overlay contract

The blessed pattern for attaching private / per-deployment features to a public core **without
forking**:

- `SHRAGA_OVERLAY` points at an external module. `boot.ts` does `await import(SHRAGA_OVERLAY)`
  (resolved relative to CWD) **before** `mountFeatures()`.
- The overlay module calls `registerFeature(...)` at import time (side-effect registration), sharing
  the core's singletons — it runs IN the core process, not a sandbox.
- It **must live OUTSIDE the app/release tree** so a redeploy (which replaces the tree) doesn't wipe
  it. Put it on a shared tier.
- A missing/throwing overlay is caught and logged; the core never crashes on it.

Prefer a programmatic `createShraga().registerFeature(...)` embed when you own the entry point; use
`SHRAGA_OVERLAY` when running the stock CLI/binary and only want to inject an external module.

## Manage an instance

- **`data/` layout** (flat files, no DB): conversations/sessions, `skills/`, `extensions/`,
  `whitelist.json`, `shraga.config.ts`, uploads. All via `dataPath()`.
- **Deployment config** — `DATA_DIR/shraga.config.ts` (canonical filename; `unclaw.config.ts` is a
  legacy fallback), seeded from `defaults/shraga.config.ts`. Typed `ShragaConfig` in
  [`src/server/shraga-config.ts`](../../../src/server/shraga-config.ts); today it declares global
  **MCPs** (`mcps`). Agent settings (model/engine/turns/thinking) live in the agent config written
  through the API, not this file.
- **MCPs** — global (via `shraga.config.ts` `mcps`) + per-user (UI-editable, under `data/`).
  Shorthand entries auto-resolve from `vendor/{name}`; full entries give explicit `command`/`args`/`env`.
- **Skills** — reusable procedures in `data/skills/` ([`src/server/skills.ts`](../../../src/server/skills.ts)),
  editable in the UI. Built-ins are seeded from `defaults/skills/` and treated as code (re-seeded on
  boot) — garden lasting knowledge in `defaults/`, not only in a live `data/` copy.
- **Schedules & events** — cron and `event`-trigger tasks run agent jobs unattended; event triggers
  fire off the bus (webhook / `POST /api/events/:source`).
- **Auth** — `AUTH_PROVIDER` ([`src/server/auth.ts`](../../../src/server/auth.ts)): `local`
  (default, self-hosted username/password; local login/register routes exist only in this mode) or
  `firebase` (verifies Firebase ID tokens; optional add-on). `requireAuth` is the shared guard; API
  keys use the `uck_` prefix. `passive`/`SHRAGA_PASSIVE` boots HTTP-only (no schedulers/consumers/
  writers) for standby twins.

## Deploy model (generic pattern)

The shape, not any specific box:

- **Source-tree deploy + release-symlink + atomic flip.** Ship the tree to a versioned release dir,
  repoint a `current` symlink, restart — so a rollback is a symlink flip.
- **Overlays live on a shared tier OUTSIDE releases**, referenced by `SHRAGA_OVERLAY` with a stable
  path, so redeploys (which replace the release tree) never wipe them.
- **Pin the public trunk by SHA.** A downstream/private deployment tracks a known-good public commit
  and bumps deliberately, rather than floating on `main`.
- Secrets ride in the deployment `.env`, never the repo (only `.env.example` is tracked).
