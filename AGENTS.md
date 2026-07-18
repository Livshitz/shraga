# AGENTS.md

Guidance for coding agents (Claude Code, Cursor, and others) working in this repository.

## What Shraga is

Shraga is a self-hostable, multi-user web UI for delegating work to AI coding agents. The server
owns conversations, sessions, skills, scheduling and an MCP endpoint; the browser is a thin React
client. It runs anywhere Bun runs: a laptop, a home server, a VM.

**Library-first.** The public surface is `createShraga(options)` in `src/index.ts` (the package
`main`/`exports`/`types`). You configure it with typed `ShragaOptions`, register against the seams
(`registerFeature` / `registerEngine` / `registerExtension` / `registerWebhook` / `on`), then
`await start()` → a `ServerHandle` (`{ app, server, port, url, emitEvent, on, registerExtension,
registerWebhook, stop }`). Everything else dogfoods this: `src/server/index.ts` (run-from-source)
and `src/cli.ts` (the bin) are both `createShraga(fromEnv()).start()`. `src/index.ts` only
type-imports the server graph and dynamic-imports `bootServer()` inside `start()`, so importing the
package does not eagerly resolve `DATA_DIR`.

Two consumption tiers exist today: (1) **CLI** — `bunx shraga`, env-configured, zero code; (2)
**library embed** — `import { createShraga } from 'shraga'`, wire it, own the lifecycle. *(A
cwd-based `shraga.config.ts` for the library tier is not built — configure via options/env.)*

## Layout

| Path | What it is |
| --- | --- |
| `src/index.ts` | Public library entry: `createShraga`, `fromEnv`, `ShragaOptions`, exported types |
| `src/server/boot.ts` | `bootServer(registrations)` — the actual HTTP/WS bootstrap; returns the `ServerHandle` |
| `src/server/index.ts` | Run-from-source entry (`bun run src/server/index.ts`) = `createShraga(fromEnv()).start()` |
| `src/server/` | Express + WebSocket server |
| `src/client/` | React 19 + Vite + Tailwind + shadcn/ui SPA |
| `src/cli.ts` | The `shraga` bin — dogfoods `createShraga(fromEnv()).start()` |
| `defaults/` | Canonical source for runtime-seeded content (skills, extensions, config template) |
| `data/` | Runtime state. Created at boot, seeded from `defaults/`. Not tracked |
| `docs/` | Architecture and concept notes |

- **Runtime**: Bun. **No database**: all persistence is flat JSON/JSONL files under `data/`.
- All data paths go through `src/server/paths.ts` (`dataPath()`), which honours `DATA_DIR`.
- `defaults/` → `data/` seeding happens in `src/server/seed.ts` at startup. Skills and extensions
  are treated as code (overwritten on boot); other files are only created when missing.

## The extension seams

Shraga's core is deliberately small. Optional functionality attaches through these seams. Read
them before adding a feature: most things belong in a seam, not in core. Each seam is reachable two
ways that funnel to the SAME registry — programmatically before boot (`createShraga(...)
.registerFeature/.registerExtension/.on(...)`, collected into `bootServer(registrations)`), or via
the file/env doors below. `boot.ts` flushes the programmatic registrations at the same point their
file-based equivalents mount.

**1. Server features: `src/server/features.ts`**
An add-on calls `registerFeature({ name, register(ctx), flags?, sidecarRoutes? })` before startup;
the single `mountFeatures(ctx)` call in `index.ts` mounts them all. `register` receives a
`FeatureContext` (`app`, `requireAuth`, `broadcast`, `passive`). A feature can also contribute:
- `flags`: capability flags merged into `GET /api/features`, so an add-on turns its own UI on.
- `sidecarRoutes`: url-prefix → localhost port, folded into the core WebSocket proxy table.

The core registers nothing here. A throwing feature is contained (logged; others still mount).

**2. Client slots: `src/client/lib/slots.tsx`**
A typed set of render slots (`inputAdornments`, `settingsSections`, `toolRenderers`,
`extensionBlocks`, `conversationController`, `statusChips`, `sidebarExtras`, …). The core ships an
empty slot set, so no core component statically imports add-on code and the core bundle contains
none. Slot argument types stay minimal and local; never import an add-on type into the seam.

**3. Route extensions: `data/extensions/*.ext.ts`**
Drop-in route modules, each a `export default register(router, ctx)`. Loaded by
`src/server/extensions.ts` into a Router mounted **before** the SPA catch-all. `ctx` gives
`dataPath`, `requireAuth`, `emitEvent` and `registerWebhook`. Use these for per-deployment public
routes (webhooks, OAuth callbacks) without touching `src/`. New files hot-load; editing an existing
one needs a restart. `defaults/extensions/selftest.ext.ts` is the canonical example; read it first.

**4. Typed event bus + webhooks: `src/server/events/`**
An in-process bus (`bus.ts`) with typed sources (`types.ts`). Subscribe with `on(source, handler)`
(pre-boot via `createShraga`, or via `ServerHandle.on` when runtime registration is enabled) and
publish with `emitEvent`. A verified vendor webhook is declared with `registerWebhook({ source,
verify })` (`events/webhook.ts`): it mounts a PUBLIC `POST /api/webhooks/<source>`, runs the
per-vendor `verify` over the raw body, and on success emits the typed event — which in turn fires
matching `event`-trigger schedules. A webhook IS an extension (it mounts on the same Router before
the SPA catch-all); the factory sugar reuses that seam rather than inventing a parallel one.

### The overlay contract

`SHRAGA_OVERLAY` points at an external module **outside the core release tree**. `boot.ts` does
`await import(SHRAGA_OVERLAY)` (resolved relative to CWD) **before** `mountFeatures()`; the overlay
module calls `registerFeature(...)` at import time (side-effect registration, importing the core's
`features.ts`). It runs IN the core process and shares the core's singletons, so it is not a
sandbox — it is the sanctioned way private / per-deployment features (e.g. a Gmail add-on)
attach without forking the repo. A missing or throwing overlay is caught and logged; the
core never crashes on it. The overlay module **must live outside the release tree** so redeploys
(which replace the tree) don't wipe it. Prefer a programmatic `createShraga().registerFeature(...)`
embed when you own the entry point; use `SHRAGA_OVERLAY` when you're running the stock CLI/binary
and only want to inject an external module.

### The core rule

**Core must never name add-on concepts.** Seams stay generic: the core declares no add-on flags,
imports no add-on types, and hardcodes no add-on vocabulary. An add-on declares itself through
`flags` / `sidecarRoutes` / slots. If you find yourself adding an add-on's name to a core file,
that is the signal you're on the wrong side of the seam.

*(Known gap: a few core call-sites still carry legacy add-on vocabulary. Don't add more, and
prefer the seam when you touch that code.)*

## Auth

Pluggable via `AUTH_PROVIDER` (`src/server/auth.ts`):
- `local` (default): self-hosted accounts, no external dependency. Local login/register routes
  exist only in this mode.
- `firebase`: verifies Firebase ID tokens. Requires the Firebase config; an optional add-on.

Keep new routes gated like their siblings. `requireAuth` is the shared guard; API keys use the
`uck_` prefix (`src/server/api-keys.ts`).

## Conventions

- **Keep files lean** (~250 lines). Split into modules rather than growing a file.
- **Reuse existing primitives**: shadcn components live in `src/client/components/ui/`. Check for
  an existing pattern before adding a dependency or inventing a mechanism.
- **DRY**: reuse the shared types (`WsEvent`, `ConvBlock`, `ChatMessage`).
- **Log with a bracketed prefix**: `[ws]`, `[http]`, `[sessions]`, `[seed]`, `[config]`,
  `[features]`. Match the surrounding module.
- **Never swallow an error silently.** With `.catch(() => fallback)`, log the error first.
- **Never let an ambiguous failure drive a destructive write.** If a read failure collapses to
  `null`/`[]`/`{}` and that value can reach a path that overwrites persisted state, make failure
  distinct from empty (throw on error; reserve the empty value for a genuine absence).
- **No secrets in the repo.** Only `.env.example` is tracked. `VITE_*` vars are baked into the
  client bundle at build time; never put anything project-specific in one for a default build.
- Prefer simple, direct solutions. Touch only what the task needs.

## Dev loop

```bash
bun install
cp .env.example .env      # fill in ANTHROPIC_API_KEY
bun run dev               # server (:3033) + Vite (:3032, HTTPS self-signed by default)
bun run dev:http          # same, plain HTTP (DEV_HTTPS=0)
```

Verify before you call it done:

```bash
bun run typecheck         # tsc --noEmit, must be 0 errors
bun test                  # bun test src/
bun run build             # vite build → dist/client
bun run start             # serve the built app
```

`bun run build` bakes `VITE_*` from your environment into the bundle. Build in a clean environment
when producing anything you intend to distribute.
