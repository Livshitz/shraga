# Team context

Hot briefing card for the agent — the first thing it reads about *your* team. Keep it concise: this
file is for the handful of facts worth loading on every turn. Detail belongs in `knowledge/*.md`.

This file is **yours**. It is seeded once and never rewritten, so edit it freely — the agent gardens
it as it learns (see the `garden` and `context-audit` skills).

## Knowledge index

Add a row per knowledge file so the agent knows when to load it (see `defaults/workspace.md`). Keep
the "when to read" column concrete — it's all the agent sees before deciding whether to open a file.

| File | When to read |
|------|--------------|
| _(example)_ `knowledge/billing.md` | Anything touching plans, invoices, or the payment provider |

## What to put here

- **Who you are** — what the team or product does, in a sentence or two.
- **Where things live** — the repos, dashboards, and services that come up constantly.
- **House rules** — conventions you don't want to repeat every session.

## What not to put here

- **Secrets.** No API keys, tokens, or credentials: this file is read on every agent turn and lands
  in transcripts. Keep secrets in the environment and reference them by *name* only.
- Anything the agent can already read from the code or git history.
