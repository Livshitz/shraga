---
name: shraga
description: How to consume, extend, embed, and operate a Shraga instance — the seams (features, extensions, event bus + webhooks, engines, client slots), the SHRAGA_OVERLAY contract, the security model (principal → role → profile, Owner Console, SECURITY_ENFORCE), and the generic deploy/overlay/pin model. Load when working WITH Shraga: adding a capability, embedding it as a library, or running an instance.
triggers:
  - extend shraga
  - add a shraga feature
  - embed shraga
  - shraga overlay
  - shraga webhook
  - shraga engine
  - manage shraga instance
  - deploy shraga
  - shraga security
  - shraga policy
  - owner console
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
   `shraga user add <email> <password>`. This is the standard self-host. Security env
   (`OWNERS`, `SECURITY_ENFORCE`, `TRUSTED_PROXIES`) → [Security model](#security-model).
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
  `shraga.config.ts`, uploads, `security/` + `audit/` (see Security model), and the legacy
  `whitelist.json` (operator contacts seed; read once into the first `policy.json` — no longer a login gate). All via `dataPath()`.
- **`quarantine/`** — untrusted inbound content held for operator review; not synced, and neither writable nor
  readable by agent tools (see Tamper protection).
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
  keys use the `uck_` prefix. Who may do what after authentication → Security model.
- `passive`/`SHRAGA_PASSIVE` boots HTTP-only (no schedulers/consumers/writers) for standby twins.

## Security model

Code: [`src/server/security/`](../../../src/server/security/). State: `DATA_DIR/security/`
(`policy.json`, `.migrated`, `blocks.json`) and `DATA_DIR/audit/YYYY-MM.jsonl` (append-only, hash-chained).
Example policy: [`defaults/security/policy.example.json`](../../../defaults/security/policy.example.json).

### Resolution: principal → role → profile
- **One path.** `resolvePrincipal` (`runtime.ts`) decides for turn start, the guard, the per-call tool gate,
  Slack ingestion and taint — never resolve a role any other way.
- **Principal** = who is calling, per channel: `user` (login), `apikey`, `internal` (agent subprocess or a
  lane acting for a user), `slack`, `email` (add-on inbound mail, `verified` = DKIM+DMARC), `anonymous`.
- **Owner** comes only from the `OWNERS` env — never the file (the validator refuses an owner binding or
  default). Owner applies to an interactive login, a lane acting for that login, or an **uncapped** API key
  of an owner. A Slack sender or email carrying an owner address is not owner.
- **Bindings are first-match** in file order, on `kind` / `id` / `emailIn` / `domain` / `verified`; no match ⇒
  `default`. Slack senders and lanes with an email also match as that email's login would.
- **Login gate (Firebase):** a login is admitted iff `OWNERS` or it resolves at/above `member` rank
  (`loginAllowed`, `runtime.ts`; re-checked on MCP OAuth refresh); otherwise 403 `User not in whitelist`. Fails closed: invalid policy or no runtime ⇒
  owners only. **Breaking (replaced `whitelist.json`):** an install with no whitelist used to admit every Firebase
  user; with no binding it now admits owners only — add a `kind:user` + emails binding (member/operator) in
  Owner Console → Bindings. Local auth is unaffected.
- **API keys** act for their creator, re-resolved per request. A key `role` caps it: never above the creator,
  never owner. `expiresAt` retires it. Only an interactive login can mint a key.
- **No-human principals:** built-in/module schedules and the legacy raw `INTERNAL_API_TOKEN` → `operator`.
  Wake, retries and user schedules re-resolve as their creator NOW (a downgraded creator runs downgraded).
- **Profile** = `tools` (availability; `Bash`/`Grep` only with `*`), `mcps`, `env` allowlist (server secrets
  are stripped even for `*`), `outbound`, `readScope`, `rate`.
- **The file:** missing ⇒ generated once (legacy `whitelist.json` → operator binding, then
  `ShragaOptions.security.migrate`); invalid, or deleted after generation ⇒ fail closed (owners only). Only
  content the server wrote is hot-reloaded; any other edit is ignored, audited `policy.tamper`, owners alerted.
  Change it through the Owner Console.

### Session taint floor
A session's effective role is the lowest-ranked role that ever contributed to it. The gate re-reads it on
every tool call, so a lower-rank message mid-turn restricts the running turn. It only lowers; forks inherit
it. Slack context/thread history only ingests authors ranked ≥ the invoker.

### Escalation
`escalate` exists only in profiles that list it (`reply-only`). It notifies owners with principal, channel,
session link and excerpt — per-principal cooldown with digest batching, plus a global cap. The owner opens
the link and continues as themselves; the escalated session never upgrades.

### Sharing files (`share_file`)
In-process tool `mcp__shraga-share__share_file` (`src/server/share-file.ts`), attached to full-access turns
only (every turn when `SECURITY_ENFORCE` is off; `*`-tools profiles when on). It copies a file from the data
dir / workspace / tmp into `<data>/uploads/shared/<random-hex>-<name>` (served public, no auth) and returns
`<publicOrigin>/uploads/shared/…`. Refuses secrets, dotfiles/hidden dirs, server-owned data, and paths outside
those roots (by realpath). No public origin ⇒ error telling the agent to attach the file. The agent must never
build share URLs by hand.

### Untrusted replies
A turn's prompt carries roster/skill/workspace context, so a channel that mails the model's text back to an
unverified sender is a disclosure path. `allowUntrustedReplies` (agent-config.json, owner-only, **default off**;
Settings → "Reply to untrusted senders") gates the AUTOMATIC outbound reply to a principal that is
**unverified** OR resolves below `member` rank. Verified matters on its own: a `domain`/`emailIn` binding
matches the *claimed* `From:`, so without it `{ match: { domain: 'x' }, role: 'member' }` would let a spoofed
sender earn a reply. Kinds proven by construction (user, apikey, internal, slack) set `verified: true` in
their builder, so this never silences a logged-in user or an internal lane. Off, the turn still runs and
`escalate` still reaches owners — only the reply is suppressed (audited `guard.limit`, reason
`untrusted-reply`, once per turn). Channels/add-ons call
`mayReplyTo(principal, { sessionId, turnId, channel })` (`runtime.ts`); `turnId` is a per-MESSAGE id (a Gmail
`messageId`) and is what makes the row once per turn — `sessionId` alone is per-thread and permanent, so a
campaign down one thread would collapse to a single row. Omitting it keeps the old per-session behavior.
No runtime or an invalid policy ⇒ no reply.
Independent of `SECURITY_ENFORCE`: it gates outbound replies, not tools, so it applies in shadow mode too.

### Guard
Before any LLM spend: blocklist (policy + auto-blocks) → rate buckets (per principal from the profile `rate`,
per IP, per channel) → concurrent-turn ceiling for rank < 50. Repeated hits auto-block (TTL, persisted to
`blocks.json`); owner/operator ranks are never auto-blocked or denied by IP state. `TRUSTED_PROXIES` =
IPs/CIDRs whose `X-Forwarded-For` is trusted; without it a same-host proxy's traffic is loopback and IP
limits/blocks don't apply — set `127.0.0.1,::1` when that proxy is the only ingress.

### Revocation
- `POST /api/owner/tokens/revoke` (`principalId` `user:<email|uid>` or `internal:<uid>`) invalidates every
  login, MCP OAuth token/code and scoped internal token issued before now.
- API keys: delete the key. Legacy shared `INTERNAL_API_TOKEN`: rotate the env var.
- Removing a binding or an `OWNERS` entry applies on the next request (roles are never baked into tokens).

### Owner Console
Owner-only UI (sidebar) over [`owner-routes.ts`](../../../src/server/security/owner-routes.ts):
- `GET|PUT /api/owner/policy` (PUT needs `version` from GET; 409 if missing/stale), `POST /api/owner/policy/test`
- `GET /api/owner/principals`, `GET|POST|DELETE /api/owner/blocks` (blocking an owner → 400)
- `POST /api/owner/tokens/revoke`, `GET|POST /api/owner/api-keys`, `DELETE /api/owner/api-keys/:id`
- `GET /api/owner/audit`, `GET /api/owner/audit/verify`

**No conversation delete.** The console deliberately offers no way to delete a conversation — the audit log is
append-only, and removing a conversation is a manual, on-box operation. (`session.delete` remains a valid audit
event type so such an out-of-band removal can still be recorded.)

**Who:** reads = interactive login or uncapped owner API key. **Writes** (policy, blocks, revoke, keys)
= interactive login only. The agent's internal token is always refused here and on
`PUT /api/config`, `PUT /api/mcps` and skill mutations. Any write on a passive standby → 409.

### Tamper protection
- **Guaranteed, every profile, flag on or off:** agent file tools (Write/Edit/MultiEdit/NotebookEdit) can't
  write server-owned data — `audit/`, `conversations/`, `sessions/`, `sessions.json`, `security/`,
  `api-keys.json(.bak)`, `oauth-clients.json`, `mcps/`, server secret files, `quarantine/`, data-sync's
  `.git/` and `.gitignore` (`PROTECTED_DATA_WRITE`, realpath-resolved).
- **Guaranteed for restricted profiles:** no secret-file reads (no Bash/Grep, path-checked file tools, no
  `/proc`/`/sys`, Glob inside the workspace).
- **Quarantined content is also unreadable** (`PROTECTED_DATA_READ`, enforcement only — with `SECURITY_ENFORCE`
  unset nothing changes). Reading attacker-controlled inbound text into a turn IS the prompt-injection vector the
  quarantine exists to prevent, so Read/Glob/Grep on `quarantine/` are denied for **every profile, owner included**.
  The guarantee is the same shape as for secret paths: **restricted profiles cannot reach it** (no Bash/Grep,
  path-checked file tools); for **full profiles it is best-effort** — Bash is auto-approved by the SDK and never
  reaches `canUseTool`, so `cat` is not stopped, and the deny prevents accidental ingestion, not a determined turn.
  Server-side code is unaffected: the lane that writes quarantine and the owner route that reads it use fs/HTTP,
  not agent tools.
- **Best-effort for full profiles (owner/operator):** they have Bash, which can read secrets and write data.
  The audit log's backstop is the OS: as root on Linux run `src/scripts/harden-audit.sh <DATA_DIR>` hourly
  from cron (`chattr +a`; new month files need the next run). A planted month entry (symlink/dir) is
  detected, not prevented: appends to it are refused, `verify` reports it, owners are alerted, the script
  exits non-zero. No app route deletes audit; retention is a root op.
- **data-sync:** `audit/` is committed on every sync (commit body carries `audit-head`); a pull whose remote
  commits change `audit/` is refused. `security/` is NOT synced — the active instance's Console is its single
  writer. One data repo on two hosts is unsupported.

### `SECURITY_ENFORCE`
- **Unset = shadow:** everything resolves and is audited (`turn.start` carries `wouldDeny`; guard events
  carry `enforced:false`); nothing is denied.
- **`true`/`1` = enforce:** the guard denies, the engine applies the profile, taint and `escalate` are live,
  and a turn is refused when resolution fails or the effective profile has `outbound:false`. Unset to roll back.

**Pre-flip checklist:**
1. Shadow audit (Console → Audit) shows no unexpected `wouldDeny` for internal lanes (wake, retries), schedules,
   owners/operators on Slack, and API keys (incl. the webhook lane).
2. Bindings exist for every API-key creator, Slack sender and Gmail/email sender that must keep working — the
   default `anonymous` (profile `none`, rate `0`) refuses them. Check each with the Bindings test box.
3. `role.resolve` events show `policyValid: true` on every instance (false = owners only).
4. Legacy sessions have no floor: sessions touched by lower-rank input before the flip start at their next
   caller's rank.
5. Engines other than claude-code don't enforce profiles and refuse restricted turns — only unrestricted roles
   can use them.
6. `TRUSTED_PROXIES` is set if a same-host proxy fronts the server.

## Deploy model (generic pattern)

The shape, not any specific box:

- **Source-tree deploy + release-symlink + atomic flip.** Ship the tree to a versioned release dir,
  repoint a `current` symlink, restart — so a rollback is a symlink flip.
- **Overlays live on a shared tier OUTSIDE releases**, referenced by `SHRAGA_OVERLAY` with a stable
  path, so redeploys (which replace the release tree) never wipe them.
- **Pin the public trunk by SHA.** A downstream/private deployment tracks a known-good public commit
  and bumps deliberately, rather than floating on `main`.
- Secrets ride in the deployment `.env`, never the repo (only `.env.example` is tracked).
