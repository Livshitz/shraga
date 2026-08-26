# data/mcps/ — what is actually read, and when

This directory holds **per-user MCP overlays only**. One file per user:

    data/mcps/<uid>.json     →  read by getUserMcpConfig(uid)  (src/server/mcp.ts)

Nothing else in this directory is loaded. There is **no `_global.json`** — a file by that name
looks live and is not. Grep the loader before trusting any file here:

    grep -rn "mcps/" src/server/mcp.ts

## Where globals come from

Global MCPs live in **`data/shraga.config.ts`** (legacy name `data/unclaw.config.ts`), read by
`getGlobalMcpsFromConfig()`. The effective config for a user is:

    { ...global (shraga.config.ts), ...user (mcps/<uid>.json) }     — the user overlay wins

Only names present in the **global** config register as `/<name>` MCP commands
(`listMcpCommands()`), and `PUT /api/mcps` strips any global name from a user overlay before
saving — so a global MCP cannot be "added" by hand-writing a user file.

## Cached vs live

- `data/mcps/<uid>.json` — re-read on every call. Edit it and the next turn sees it.
- `data/shraga.config.ts` — re-read when its mtime/size changes (`refreshConfig()` in
  `src/server/shraga-config.ts`). Edit it and the next turn sees it too; **no restart needed**.
  If the edited file fails to load, the process keeps the **last-good** config and logs
  `[config] failed to load …` — check the server log before assuming your edit took.

## Verify at runtime, don't assume

    curl -sH "Authorization: Bearer $KEY" localhost:$PORT/api/mcps | jq 'keys'

An entry with `"readonly": true` came from the global config; anything else is this user's overlay.

## Why this file exists

An intent-bearing commit ("lock agf-prod RTDB to read-only for the agent") once edited a
`data/mcps/_global.json` that no loader has ever read. It was a silent no-op, and prod stayed
writable until the gate was re-implemented in `shraga.config.ts`. Edit only what is read.
