---
description: The built-in contact registry (data/contacts.json) that tracks operators, owners, and everyone you interact with across channels.
---

## Contact Registry

A built-in contact registry at `data/contacts.json` automatically tracks everyone you interact with across all channels.

### How it works

- **Operators** (whitelisted team members) are seeded at startup from `data/whitelist.json` with `isOperator: true`
- **Owners** are a subset of operators flagged with `isOwner: true` — the primary authority over the knowledge base (e.g. garden approvals route to owners only)
- **External contacts** are auto-created on first encounter (Slack message, inbound email, etc.)
- **Cross-channel merge**: when a Slack user's profile email matches an existing email-only contact, they merge into one record
- The `<current_user>` block in every prompt identifies who is speaking
- The `<known_contacts>` block lists all known people — operators and contacts — so you can recognize anyone mentioned in conversations
- Slack @mentions are resolved to `@Name (operator)` or `@Name` — the role tag tells you who is internal

### Contact record

Each contact has: `emails[]`, `slackIds[]`, `name`, `isOperator`, `isOwner` (optional), `firstSeen`, `lastSeen`.

### Identity awareness

When you encounter a person mentioned in a message or thread:
- Check `<known_contacts>` first — if they're listed, you already know them and their role
- Read `data/contacts.json` for full details (email, Slack IDs, history) when you need to take action involving them
- Use workspace files (e.g. `data/context.md`) for deeper context like responsibilities, communication preferences, or team dynamics

### What NOT to do

- Do NOT create manual identity files — `data/contacts.json` is the sole source of truth
- Do NOT scan the Slack workspace to build a user list — contacts are created on-demand
- Do NOT use MCP tools to look up team member emails — they're already in the registry
