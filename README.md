<div align="center">

# 🧑‍💻 Shraga

**The teammate you delegate coding to. Just forward it to Shraga.**

[![npm](https://img.shields.io/npm/v/shraga.svg)](https://www.npmjs.com/package/shraga)
[![CI](https://github.com/Livshitz/shraga/actions/workflows/ci.yml/badge.svg)](https://github.com/Livshitz/shraga/actions/workflows/ci.yml)

</div>

Shraga is a self-hostable, multi-user agent harness that joins your team as a NHE (Non Human Employee). Claude Code
out of the box, with a pluggable engine seam for other runtimes, reachable from anywhere: your
laptop, a home server, or a VM.

Give it its own machine, its own keys, its own identity. Onboard it once, then delegate.

## Why Shraga

- ⭐ **Runs on your Claude subscription, or via an API key.** Point it at Claude Code and it
  drives the agent through your exsiting plan (`claude auth login`), or set `ANTHROPIC_API_KEY` to
  pay per token if you prefer.
- ⭐ **A real teammate, not a chat box.** It has its own machine, its own identity, and its own
  logins, so you delegate a task the way you would to a person and come back to the result.
- ⭐ **Multi-user by design.** One Shraga serves a whole team, each with their own sessions,
  tools, and permissions.
- ⭐ **A shared brain that compounds.** It onboards, learns your codebase and conventions, and
  carries that knowledge forward via skills and sessions. The full org-wide capture is the
  north star ([the shared brain](./docs/shared-brain.md)); it opens in stages.
- **Chat with an agent** that has your workspace, shell, and tools.
- **Sessions** you can fork, resume, and revisit.
- **Skills**: reusable procedures you teach it once (files in `data/skills/`).
- **MCP servers**: connect tools (GitHub, Slack, databases) per-user or globally.
- **Schedules**: run agent jobs on a cron or in response to events.
- **Programmatic API + MCP endpoint**: drive the the agent from scripts or from claude.ai.

## What's in the box

Shraga is a small core (this repo, the `shraga` npm package) plus two ways to grow it. Capabilities
fall into three groups:

- **Built-in**: ships in this repo and runs out of the box. Nothing to install; some need
  credentials configured.
- **Optional add-on**: an external module the core loads at startup when you set `SHRAGA_OVERLAY`
  to point at it. These live outside this repo and attach through the same seams the built-ins use.
- **Bring-your-own**: you extend the core yourself through its seams (MCP, engine, skills, features).

### Built-in

| Capability | What you get | Setup |
|-----------|--------------|-------|
| **Agent chat & sessions** | Chat with an agent that has your workspace, shell, and tools; fork, resume, and revisit sessions. | none |
| **Slack** | The agent is **active on Slack**: it replies in threads, manages reactions, handles uploaded files, resolves `@mentions`, and runs polls. Via the public [`mcp-slack-use`](https://github.com/Livshitz/mcp-slack-use) package. | Slack app + tokens |
| **Scheduler** | Cron schedules and event-triggered tasks that run agent jobs unattended. | none |
| **Events** | Generic event-bus ingress (`POST /api/events/:source`) that fires matching schedules. | none |
| **Push notifications** | Web and native push. | none |
| **Artifacts** | Render HTML artifacts from a session. (PNG export is an optional add-on, see below.) | none |
| **MCP (both directions)** | *Consume* external MCP servers to give the agent tools, **and** *expose* Shraga itself as an MCP endpoint (`POST /mcp`) so claude.ai and other clients can drive it. | per-server config |
| **Engine seam** | Pluggable agent runtime. Claude Code is the built-in engine. | none |
| **Auth** | Local username/password by default; Firebase optional (`AUTH_PROVIDER=firebase`). | none / Firebase config |
| **CLI** | `shraga` server bin plus `shraga user add <email> <password>` to seed a local user. | none |

### Optional add-ons (plug in an external module)

Loaded only when you point `SHRAGA_OVERLAY` at an external module. **None of these ship in
this repo**, so a bare self-host does not get them out of the box:

| Capability | Notes |
|-----------|-------|
| **Email / Gmail** | Inbound email to agent sessions. **Not built-in** (add-on only). |
| **GitHub bot** | Issues/PRs → agent sessions with GH-native trust tiers. |
| **Fleet / multi-instance** | Blue-green and multi-instance orchestration. |
| **PNG artifact export** | Puppeteer-rendered PNGs of artifacts. |

### Bring-your-own (extend it yourself)

The core is deliberately small and grows through documented seams (see
[`AGENTS.md`](./AGENTS.md#the-extension-seams)):

| Seam | Use it for |
|------|-----------|
| **MCP servers** | Give the agent new tools, per-user or globally. |
| **Skills** (`data/skills/`) | Reusable procedures you teach the agent once. |
| **Engines** (`src/server/engine/`) | Swap or add agent runtimes behind the engine seam. |
| **Server features** (`src/server/features.ts`) | Mount new server-side surfaces via `registerFeature`. |
| **Client slots** (`src/client/lib/slots.tsx`) | Inject UI into typed render slots without touching core. |
| **Route extensions** (`data/extensions/*.ext.ts`) | Drop-in public routes (webhooks, OAuth callbacks) per deployment. |
| **`SHRAGA_OVERLAY`** | Load a whole external add-on module at startup (the optional add-ons above). |

## Use as a library

Shraga's first-class surface is the `createShraga` factory (the package `main`/`exports`). You
`import` it, wire your registrations against the same seams the built-ins use, then own the
lifecycle. `start()` returns a handle you can `stop()`. The CLI and the run-from-source entry are
thin wrappers over this exact call (`createShraga(fromEnv()).start()`).

```ts
import { createShraga } from 'shraga';

const shraga = createShraga({
  port: 3032,
  dataDir: './data',
  authProvider: 'local',          // 'local' (default) | 'firebase'
});

// Pre-start registration (chainable). See "The extension seams" in AGENTS.md.
shraga
  .registerFeature(myFeature)      // server routes/WS/consumers
  .registerEngine(myEngine)        // a pluggable agent runtime
  .registerExtension(register)     // same shape as a data/extensions/*.ext.ts default export
  .registerWebhook({ source: 'stripe', verify })  // public POST /api/webhooks/stripe → typed event
  .on('stripe', (payload, evt) => { /* handle the event */ });

const handle = await shraga.start();
console.log(`listening on ${handle.url}`);   // { app, server, port, url, emitEvent, on, ... }

// later:
await handle.stop();               // drains and closes without exiting the process
```

`ShragaOptions` is typed; anything not modelled is still reachable via `env` (Shraga is heavily
env-driven), applied before boot:

```ts
createShraga({ env: { ANTHROPIC_API_KEY: '…', SHRAGA_FEAT_WORKSPACE: '1' } });
```

**`ServerHandle`** (returned by `start()`): `{ app, server, port, url, emitEvent, on,
registerExtension, registerWebhook, stop }`.

**Runtime plug-and-play is opt-in.** `registerFeature`/`registerEngine`/`registerExtension`/
`registerWebhook`/`on` are meant to run **before** `start()`. If you need to register *after* boot,
set `runtimeRegistration: true` (or `SHRAGA_RUNTIME_REGISTRATION=1`), and then the `ServerHandle`'s
`registerExtension`/`registerWebhook`/`on` mount onto the live extension Router / event bus.
Default is **off**, and those handle methods throw until you enable it. Only extensions, webhooks
and event subscriptions are runtime-registerable; features and engines mount at boot and are never
runtime-registerable, on or off.

## Spin one up with your coding agent

Hand this to Claude Code (or Cursor, Codex, any coding agent) and let it stand up your instance:

```text
Set up a self-hosted Shraga instance for me (https://github.com/Livshitz/shraga).
- Runtime is Bun. Simplest run: `bunx shraga` (serves on :3032, state in ./data).
- To customize/extend, scaffold a tiny Bun app that depends on `shraga` and does:
    import { createShraga } from 'shraga';
    await createShraga({ port: 3032, authProvider: 'local' }).start();
  Register any features/webhooks/engines before .start() (see the "Use as a library" section).
- Auth: run `claude auth login` to use my Claude subscription, or set ANTHROPIC_API_KEY.
- Create my first account (`shraga user add <email> <password>`), then tell me the URL to open.
Read the README + AGENTS.md for the seams before adding anything custom.
```

## Quickstart (CLI)

Requires [Bun](https://bun.sh) ≥ 1.0. Env-configured, no code; this is the `createShraga(fromEnv())`
tier.

**Fastest, run from npm:**

```bash
bunx shraga                   # serve on http://localhost:3032, state in ./data/
```

**From source (to develop or customize):**

```bash
# 1. Install & configure
bun install
cp .env.example .env

# 2. Run
bun run build                 # build the web UI
bun run start                 # serve on http://localhost:3032
```

Open http://localhost:3032. On first run you create your account (local username and password, no
external auth needed). Or seed one from the CLI:

```bash
shraga user add you@example.com <password>
```

Sign in and start delegating.

### Auth: subscription or API key

Shraga runs the agent through **Claude Code**, so it uses whatever Claude Code is authenticated
with:

- **Your Claude subscription (recommended).** Run `claude auth login` once and leave
  `ANTHROPIC_API_KEY` unset. The agent runs on your plan, with no metered API charges.
- **An API key.** Set `ANTHROPIC_API_KEY` in `.env` if you would rather pay per token.

## Configuration

All config is flat files under `data/` (no database). See `.env.example` for the full list. The
common ones:

| Var | Default | Purpose |
|-----|---------|---------|
| `ANTHROPIC_API_KEY` | *(unset)* | Claude API key. Leave unset to use `claude auth login`. |
| `PORT` | `3032` | Server port |
| `DATA_DIR` | `./data` | Where state lives |
| `AUTH_PROVIDER` | `local` | `local` (username/password) or `firebase` |
| `OWNERS` | *(unset)* | Comma-separated list of admin emails |

### The config file (`data/shraga.config.ts`)

Beyond env vars, a typed config module in your data dir declares **global MCP servers**: the tools
every user gets. (Per-user MCPs are added in the UI, and agent settings like model and engine live
in `agent-config.json`, editable from the UI.) Shraga seeds it from a template on first run and
gitignores it, so you just edit the seeded file:

```ts
export default defineConfig({
  mcps: {
    // Full form: an explicit command.
    'stripe': { command: 'bunx', args: ['@stripe/mcp'], env: { STRIPE_KEY: '' } },
    // Shorthand: a vendored MCP under vendor/<name>/, listing the env keys it needs.
    'mcp-example': { env: ['EXAMPLE_API_KEY'] },
  },
});
```

Values in `env` resolve from `process.env` (your `.env` or system env) at startup. The legacy
filename `unclaw.config.ts` is also accepted.

## Expose it (optional)

Running on a home machine? Set `CLOUDFLARE_TUNNEL_TOKEN` for a public URL via Cloudflare Tunnel, or
put it behind any reverse proxy.

## Architecture

- **Runtime:** Bun. **Server:** Express + WebSocket (`src/server/`)
- **Client:** React + Vite + Tailwind (`src/client/`)
- **Agent:** `@anthropic-ai/claude-agent-sdk`
- **Storage:** flat JSON/JSONL in `data/` (no database)
- **Auth:** pluggable provider (local by default; Firebase optional)

## Read the thinking

Shraga is a set of ideas before it is a binary:

- **[Concept](./docs/concept.md)**: the mental model of delegation, not another chat box.
- **[The shared brain](./docs/shared-brain.md)**: a teammate that onboards, learns, and compounds
  org knowledge.
- **[Primitives](./docs/architecture/primitives.md)**: the core nouns you build with.

## Feedback

Concepts, gaps, "why not X", use cases: [Discussions](https://github.com/Livshitz/shraga/discussions).
Bugs and concrete proposals: [Issues](https://github.com/Livshitz/shraga/issues).
