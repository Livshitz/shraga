# Workspace Architecture

The agent workspace (`data/workspace/`) is a persistent knowledge base that grows across conversations. It has two scopes.

## Team-Scope (`data/workspace/`)

Shared knowledge visible to all users and conversations.

1. **Hot context** (`context.md`, always injected) — briefing card with team, IDs, key facts. Keep concise.
2. **Domain knowledge** (`knowledge/*.md`, loaded on demand) — deeper files per domain (product, team, infra, etc.)
3. **Tasks & questions** (`tasks.md`, `open-questions.md`) — tracked work and open items

**Loading rule:** Pull in the relevant `knowledge/` file when working on that domain. Don't load all files every session.

## User-Scope (`data/workspace/users/{id}/`)

Per-user directory created on first conversation. This is your mental model of a person — the way a colleague builds understanding of someone they work with over time. The goal: the agent should eventually operate on a user's behalf as naturally as they would themselves. "How did it know that?" is the bar.

### Structure

`user-context.md` is the index — injected every conversation (≤3000 chars, truncated with path hint for full read). Deeper files for complex per-user topics, referenced from the index.

### Categories

Organize learnings into natural categories as they emerge. Not all categories apply to every user — let the profile grow organically based on what you actually observe.

- **Who they are** — role, expertise, responsibilities, domain knowledge
- **How they operate** — decision patterns, workflow habits, information sources they reach for, how they prioritize
- **Corrections** — things they corrected you on, mistakes not to repeat, specific preferences ("use YAML not JSON"). These are hard rules — one correction should be permanent. Getting corrected twice on the same thing erodes trust fast.
- **Their taste** — aesthetic preferences, quality bar, communication style, how much detail they want
- **What they're working on** — current focus areas, active concerns, ongoing threads

### Corrections are critical

When a user steers or corrects the agent — "no, do X instead", "don't do that", redirects approach — that's the highest-signal learning. Extract it as a concrete rule, not a vague observation. Examples:
- "Use YAML not JSON for reports" (not "prefers structured formats")
- "Pull CAC from the Sheets payback tracker, not Mixpanel" (not "likes primary sources")
- "Don't narrate process — report results" (not "prefers concise communication")

These go in the **Corrections** section and should be specific enough to follow without interpretation.

## Learning Rules

**Placement rule (decide scope first):** anything personal or specific to one user goes *down* into that user's area (`users/{id}/`). Anything meta, shared, or not tied to a single user goes *up* to team scope (`context.md`, `knowledge/*.md`, `tasks/`). When unsure, ask: "would this be true/useful for a different user?" — yes → team, only-about-this-person → user.

- **User-scope**: who they are, how they operate, corrections, taste, current focus, their personal projects/tasks → user's dir
- **Team-scope**: project decisions, shared processes, product knowledge, team agreements, workspace-structure conventions → `context.md` or `knowledge/*.md`
- A single conversation can yield both — the user-specific angle goes to user-scope, the team/meta fact goes to team-scope
- Update when you learn something durable. One good update per conversation is plenty; zero is fine
- Nightly reconcile scans conversation summaries for corrections/steering moments and behavioral patterns, then proposes updates to both scopes
