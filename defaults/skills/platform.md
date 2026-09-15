---
description: Shraga platform features — directives, config, thinking/reasoning, sessions, internal API, MCP
triggers:
  - directive
  - how do i switch model
  - how do i enable thinking
  - reasoning
  - effort
  - config panel
  - platform feature
  - internal api
  - mcp tools
  - deferred tools
  - ToolSearch
  - new conversation
  - spawn conversation
---

# Shraga Platform Features

Reference for user-facing capabilities. Use this when users ask "how do I…" about the platform itself.

## Directives

Users can prefix any message with `[directives]` to override settings. Parsed server-side before the prompt reaches you. Directives stick to the session: once set, they apply to all later turns of that conversation (a new directive overrides the stored one).

**Syntax:** `[directive1, directive2, ...] rest of the message`

### Positional directives

| Position | What | Examples |
|----------|------|----------|
| 1st | Model alias | `fable`, `opus`, `sonnet`, `haiku`, `fable-5-1`, `fable-5`, `opus-5`, `opus-4-8`, `opus-4-7` |
| 2nd | Max turns (integer) | `5`, `20`, `100` |

### Named directives

| Directive | Values | Effect |
|-----------|--------|--------|
| `think` / `adaptive` | — | Enable adaptive thinking for this message |
| `nothink` | — | Disable thinking for this message |
| `thinking:VALUE` | `adaptive`, `enabled`, `disabled` | Set thinking mode explicitly |
| `effort:VALUE` | `low`, `medium`, `high`, `max` | Set reasoning effort level |
| `model:VALUE` | Any alias | Override model |
| `turns:VALUE` | Integer | Override max turns |
| `resume:VALUE` | `on`, `off` | claude-code engine: resume the SDK session across turns instead of re-sending the history (prompt-cache savings). Overrides agent-config `sdkResume` for this conversation |

### Examples

- `[opus] review this PR` — use Opus for this message
- `[opus, 5] quick answer` — Opus, max 5 turns
- `[think] explain the tradeoffs` — enable thinking
- `[opus, think, effort:max] deep analysis` — Opus + thinking + max effort
- `[nothink] just do it` — disable thinking
- `[haiku, 3] one-liner summary` — Haiku, 3 turns

## Config Panel (sliders icon)

Persistent settings that apply to all messages until changed:

| Setting | Options | Default |
|---------|---------|---------|
| Model | Fable 5, Opus 4.8, Opus 4.7, Opus 4.6, Sonnet 4.6, Haiku 4.5 | Sonnet 4.6 |
| Permission Mode | Accept Edits, Plan, Bypass All | Accept Edits |
| Max Turns | 1–200 | 50 |
| Thinking | Adaptive, Enabled, Disabled | Off |
| Effort | Low, Medium, High, Max | Default |
| Allowed Tools | Comma-separated list | All |
| Skill Discovery | On/Off | On |
| System Prompt | Free text appended to system prompt | Empty |

**SDK session resume (`sdkResume`, default off).** Not in the panel: set `"sdkResume": true` in `agent-config.json` (re-read every turn, no restart) or per conversation with `[resume:on]` / `PUT /api/sessions/:id/directives {"resume": true}`. When on, the claude-code engine sends the full context + history once (fresh query), then resumes that Claude Code session and sends only the new message, appending the current speaker's `user` section (every resume turn), changed context sections and messages other channels added AFTER the user text. It falls back to a fresh query — logged as `[claude] Cache: … path=fallback:<reason>` — on: `no-session`, `concurrent-run` (an earlier CLI process on the conversation, e.g. the run a steer took over, was still alive after 5s), `speaker-change` (a different person than the one whose turns the Claude Code session holds — keeps one user's private context out of another's turns; single-speaker conversations keep resuming), `engine-switch`, `account-change`, `reset`, `summary`, `history-diverged`, `drift`, `transcript-missing` (CLI cleanup removed it), `resume-failed` (the CLI couldn't load the session, e.g. "No conversation found" — retried fresh in the same turn; any other error, like a usage limit, surfaces as-is and keeps the mapping). Flag off logs `path=fresh`, a resumed turn `path=resume`.

Directives override config and persist for the session. On a session's first turn, the resolved engine/model/turns/thinking are pinned to the session — reopening it from history resumes the exact same shape even if config defaults change later.

## Thinking / Reasoning

When enabled (via config or `[think]` directive), the model produces extended reasoning before responding. Thinking blocks appear as collapsible violet panels in the chat UI, hidden by default behind the details toggle (eye icon).

- **Adaptive** — model decides when to think (recommended)
- **Enabled** — always produce thinking
- **Disabled** — never produce thinking

**Effort** controls reasoning depth: `low` (fast) → `max` (thorough). Can be set independently of thinking.

## Artifacts

HTML files with an `<!-- artifact: {...} -->` comment are rendered in a side panel. See the `artifacts` skill for details.

## Machine Stats

The sidebar footer (next to the version) shows a live CPU/memory sparkline of the **host machine** — a 10-minute trend so issues (swap thrash, runaway builds) are visible at a glance. A single server-side sampler (`src/server/stats.ts`) samples the host every 5s and broadcasts each point over WS; clients seed from `GET /api/stats` (cached ring buffer) and never poll the box themselves. Colors: green <75%, amber ≥75%, red ≥90%.

## Sessions

- Each conversation is a session with a unique ID
- Sessions persist as JSONL in `data/conversations/`
- Share via URL: `?session=SESSION_ID`

### Starting a New Conversation

You can spawn a new independent conversation from within a running session:

```bash
curl -X POST http://localhost:$PORT/api/chat \
  -H "x-internal-token: $INTERNAL_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "your task here"}'
```

Omit `sessionId` to create a fresh conversation. The new session runs with full agent capabilities (tools, MCP, skills).

**Default (async)**: returns `{ sessionId, status: "accepted" }` immediately; the agent runs in the background. Add `"callbackUrl": "..."` to get POSTed the result when done.

**Sync mode**: add `"sync": true` to wait for the full response: `{ sessionId, text, blocks }`.

## Internal API Auth

When your role's profile allows it, an `INTERNAL_API_TOKEN` scoped to the current session user is set in your environment. Use it to call authenticated endpoints from within a session:

```bash
curl -H "x-internal-token: $INTERNAL_API_TOKEN" http://localhost:$PORT/api/...
```

The request authenticates as the current session user automatically. It is refused (403) by owner-admin routes (`/api/owner/*`, `PUT /api/config`, `PUT /api/mcps`, skill edits) and by API-key creation — those need the human's interactive login. If the variable is missing, your role in this session doesn't get it.

## MCP Tools

MCP servers are configured per-deployment in `data/mcps/*.json` (server-owned: changed via the UI, not your file tools — like `data/audit/`, `data/conversations/`, `data/sessions/` and `data/security/`). All MCP tools are available to you, but most are **deferred** — you must call **ToolSearch** to load their schemas before invoking them. ToolSearch is always available.

Startup logs show `[claude] MCP: name:status` for each server. If a tool call fails with `InputValidationError`, you likely forgot to ToolSearch it first.

## Contextual Triggers

Skills can trigger based on conversation context, not just message keywords. The platform injects context tags before matching:

| Tag | Source | Example |
|-----|--------|---------|
| `source:slack` | All Slack messages | |
| `source:web` | Web UI messages | |
| `source:api` | API endpoint messages | |
| `channel:#name` | Slack channel name | `channel:#support` |
| `dm:true` | Slack DMs | |
| `thread:ts` | Slack thread timestamp | `thread:1780293395.005369` |
| `user:email` | User's email | `user:alice@co.com` |

Triggers use simple substring matching — any trigger string that appears in the context+message input will activate the skill.

Example skill with contextual trigger:
```yaml
---
description: Support channel guidelines
triggers:
  - "channel:#support"
---
Be empathetic. Acknowledge the issue before troubleshooting...
```

You can combine contextual and keyword triggers in the same skill. You can also create contextual skills on behalf of users — write a skill file in `data/skills/` with the appropriate trigger.

## Ephemeral Skills (TTL)

Skills can have an expiration time via the `expires` frontmatter field (ISO 8601). After expiry, the skill stops triggering, is hidden from the skill index, and is purged on server restart.

```yaml
---
description: Temporary pricing empathy for #sales
triggers:
  - "channel:#sales"
expires: 2026-06-02T18:00:00Z
---
When discussing pricing, be empathetic about budget constraints...
```

Use cases:
- Temporary tone/behavior for a specific channel or thread topic
- Time-limited campaign responses
- Short-lived instructions that shouldn't persist

To create an ephemeral skill: write a skill file with `expires` set to the desired ISO 8601 datetime. Compute from natural language (e.g. "for the next 2 hours" → now + 2h).
