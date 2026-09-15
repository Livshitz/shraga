---
description: The embedded MCP endpoint (POST /mcp) and uck_ API keys that let external Claude clients access workspace, skills, sessions, schedules, and remote prompts.
---

# MCP Server & API Keys

Shraga exposes an embedded MCP endpoint at `POST /mcp` so external Claude clients (Claude Desktop, Claude Cloud, other MCP consumers) can access workspace, skills, sessions, schedules, and run prompts remotely.

## API Keys

Keys use the `uck_` prefix. `data/api-keys.json` holds only a sha256 hash + a short preview per key — the plaintext is returned once, at create, and can't be recovered (an old plaintext file is hashed on first load, original kept at `api-keys.json.bak`).

A key acts for its creator. Optional `role` caps it (effective role = the lower of the creator's role and the key's role — then never owner, never above the creator). Optional `expiresAt` (epoch ms) rejects it from then on.

**REST endpoints** (require auth; writes return 409 on a passive standby):
- `POST /api/api-keys` — create your own key. Body: `{ "label": "my-key" }`.
- `GET /api/api-keys` — list your keys (an owner sees all). Never includes the secret.
- `DELETE /api/api-keys/:id` — delete a key (its creator or an owner). Takes effect immediately.
- Owner only: `GET|POST /api/owner/api-keys`, `DELETE /api/owner/api-keys/:id` — same, but POST also takes `role` and `expiresAt`.

**Revoking sessions/tokens** (owner only): `POST /api/owner/tokens/revoke` with `{ "principalId": "user:<email|uid>" }` or `"internal:<uid>"` invalidates every login, MCP OAuth token/code and scoped internal token issued to that principal before now. It does not touch API keys — delete the key instead — nor the legacy shared `INTERNAL_API_TOKEN` (`internal:agent-internal` is refused; rotate the env var).

Owner and keys: a key WITHOUT `role` is a delegated login credential (e.g. the one `shraga term` gets via browser consent) — it keeps its creator's owner status and role, re-checked on every request, so removing the creator from `OWNERS` takes effect immediately. A key WITH `role` is never owner: owner-only routes answer 403 and its role stays below owner. No key can create keys or approve MCP OAuth consent — both require an interactive login.

**Generating a key via curl** (from an agent session):
```bash
curl -X POST "$SHRAGA_BASE_URL/api/api-keys" \
  -H "Content-Type: application/json" \
  -H "x-internal-token: $INTERNAL_API_TOKEN" \
  -d '{"label":"claude-desktop"}'
```

## Connecting Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (uses stdio bridge — Claude Desktop doesn't support HTTP URL transport):
```json
{
  "mcpServers": {
    "shraga": {
      "command": "bun",
      "args": ["run", "/path/to/shraga/src/mcp-stdio-bridge.ts"],
      "env": {
        "MCP_URL": "https://your-host",
        "MCP_API_KEY": "uck_..."
      }
    }
  }
}
```

Optional bridge env: `MCP_BRIDGE_TIMEOUT_MS` (protocol calls, default 60s) and `MCP_BRIDGE_TOOL_TIMEOUT_MS` (`tools/call`, default 30min). Past the bound the bridge answers with a JSON-RPC error instead of hanging.

## Available MCP Tools

| Tool | Description |
|------|-------------|
| `get_sessions` | List conversations with pagination |
| `get_sessions_messages` | Read conversation history |
| `get_workspace` | List workspace file tree |
| `get_workspace_file` | Read a workspace file |
| `put_workspace_file` | Write/update a workspace file |
| `get_workspace_search` | Search file contents for text (case-insensitive) |
| `get_skills` | List agent skills with metadata |
| `get_skills_read` | Read full skill content |
| `put_skills_write` | Create/update a skill |
| `get_schedules` | List scheduled jobs |
| `post_schedules_run` | Trigger a schedule run |
| `get_downtime` | "What did I miss?" — outage ranges + missed schedule windows + Slack backfill (reports/proposes only, fires nothing) |
| `post_chat` | Talk to the agent — conversational, multi-turn via sessionId |
| `get_config` | Read agent configuration |

## Source

- `src/server/mcp-server.ts` — tool definitions + Express bridge
- `src/server/api-keys.ts` — API key CRUD
- `.claude/skills/mcp-shraga/SKILL.md` — MCP skill resource
