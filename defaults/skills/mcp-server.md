# MCP Server & API Keys

Shraga exposes an embedded MCP endpoint at `POST /mcp` so external Claude clients (Claude Desktop, Claude Cloud, other MCP consumers) can access workspace, skills, sessions, schedules, and run prompts remotely.

## API Keys

Keys use the `uck_` prefix and are stored in `data/api-keys.json`.

**REST endpoints** (require Firebase auth or internal token):
- `POST /api/api-keys` — create a key. Body: `{ "label": "my-key" }`. Returns full key (only shown once).
- `GET /api/api-keys` — list keys (key values masked).
- `DELETE /api/api-keys/:id` — delete a key (owner or server owner only).

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
| `post_chat` | Talk to the agent — conversational, multi-turn via sessionId |
| `get_config` | Read agent configuration |

## Source

- `src/server/mcp-server.ts` — tool definitions + Express bridge
- `src/server/api-keys.ts` — API key CRUD
- `.claude/skills/mcp-shraga/SKILL.md` — MCP skill resource
