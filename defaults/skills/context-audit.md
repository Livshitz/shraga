---
name: context-audit
description: "Investigate agent context path issues — trace what's hot-loaded vs cold-loaded, find knowledge gaps, test fixes via API replay. Use when an agent session shows wrong behavior due to missing context."
argument-hint: "[session URL or description of the failure]"
---

# Context Audit

Diagnose *why* the agent didn't know something it should have, and fix the right layer.

## When to Use

- Agent gave a wrong/confused answer despite the knowledge existing somewhere
- A skill or rule was ignored — need to determine if it was even loaded
- After adding new knowledge, to verify it reaches the agent at the right time
- Reviewing a prod session for context path failures

## Shraga Context Architecture

### Hot Path (always injected, every prompt)
- `data/skills/{name}.md` where name is in `skills-defaults.json` — personality, identity, self-aware, pr-review
- `<current_user>` block (uid, email, display name)
- `<known_contacts>` from `data/contacts.json`
- Workspace tree listing + `data/workspace/context.md` (full, uncapped)
- User's `data/workspace/users/{uid}/user-context.md` (capped ~3000 chars)
- MCP skill hint lines (name + resource URI, one line each)
- Trigger-matched skills (via `matchTriggeredSkillNames` — prompt text matched against `triggers:` frontmatter; sticky per session — once matched, re-injected on every later turn via `SessionMeta.triggeredSkills`)
- Skill index block (names + descriptions of all skills)

### Cold Path (agent must explicitly Read or be triggered)
- Non-default skills in `data/skills/` — loaded via trigger match, @mention, or manual Read
- `data/workspace/knowledge/*.md` — domain deep-dives
- Full MCP skill docs (`skill://name/workflow` resources)
- Workspace files beyond context.md

### Trigger Bridge (cold skill, hot injection)
Skills with `triggers:` frontmatter get auto-injected when the user's prompt text matches any trigger string. This bridges hot/cold — the skill is cold by default but becomes hot when relevant.

## Audit Process

### 1. Reproduce the failure
Read the session messages. Identify the exact moment the agent went wrong. Note:
- What did the user ask?
- What did the agent do instead?
- What knowledge would have prevented the mistake?

### 2. Trace the context path
For the missing knowledge, determine:
- **Does it exist anywhere?** (skill, workspace file, knowledge file, context.md)
- **Is it hot or cold?** Check `skills-defaults.json`, trigger frontmatter, workspace injection
- **If cold, should it have been triggered?** Check if user prompt text matches any trigger
- **If triggered, did injection fire?** Check server logs for `[skills] Trigger matched:`

### 3. Identify the gap type

| Gap | Symptom | Fix Layer |
|-----|---------|-----------|
| Knowledge doesn't exist | Agent can't know it | Add to appropriate file (skill, context.md, knowledge/) |
| Knowledge exists but is cold | Agent didn't load it | Add triggers to skill frontmatter, or move to hot path |
| Knowledge is hot but ignored | Agent saw it, acted wrong | Strengthen wording, resolve contradictions, test with different models |
| Wrong mental model | Agent misinterpreted the request | Add disambiguation rules to relevant skill |
| Seed overwrites org data | Restart wipes customizations | Remove from `defaults/skills/` (org-only skills shouldn't have a defaults counterpart) |

### 4. Apply fixes at the right layer
- **Hot path** (personality.md, context.md): Generic behavioral rules, team/product basics
- **Cold skill with triggers**: Domain-specific tool guidance (Slack, Firebase, Stripe)
- **Knowledge files**: Deep reference material the agent loads on demand
- **context.md pointers**: Keep context.md lean — point to cold files for details

### 5. Verify via API replay
Test the fix by replaying the failing prompt through `/api/chat`:
```bash
TOKEN=$(cat .tmp/.internal-token)
curl -s http://localhost:3032/api/chat \
  -H "Content-Type: application/json" \
  -H "x-internal-token: $TOKEN" \
  -d '{"prompt":"<the original failing prompt>","sessionId":"test-context-audit"}'
```
Check the response: did the agent now handle it correctly? If not, iterate.

## Key Gotchas

- **Seed overwrites**: `seedDefaults()` copies `defaults/skills/*.md` → `data/skills/` on every restart. Org-specific skills must NOT exist in `defaults/` or they'll be wiped.
- **Token rotation**: Dev server `--watch` restarts regenerate `.tmp/.internal-token`. Re-read before each API call.
- **Model sensitivity**: A fix that works on Opus may not work on Sonnet. Test on the prod model.
- **Trigger matching is substring**: `" dm "` (with spaces) avoids false positives on words containing "dm". Design triggers carefully.
- **Hot path budget**: Every hot-loaded skill consumes prompt tokens on every message. Keep hot content lean; use triggers for domain skills.
