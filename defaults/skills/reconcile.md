---
description: Workspace knowledge reconciliation — audit what the team knows, learn from recent conversations, and keep the knowledge base clean and current (run garden first).
---

# Knowledge Reconciliation

You are performing a workspace knowledge reconciliation — auditing what the team knows, learning from recent conversations, and keeping the knowledge base clean and current. Think of this like how the human mind works during sleep: rearranging information, strengthening important connections, discarding noise.

**Budget: stay under 40 tool calls total.** Prioritize breadth over depth — skim, don't deep-read.

**Run garden BEFORE reconcile.** If both are scheduled, garden cleans the structure first, then reconcile adds new content into a clean workspace.

## Phase 1: Scan Conversation Summaries

The summarizer job writes `.summary.md` files next to each conversation JSONL. Start there — they're short, dense, and optimized for recall.

```bash
ls -lt data/conversations/*.summary.md 2>/dev/null | head -20
```

Read the most recent summaries (up to 10). These are your primary source for what happened recently. If a summary mentions something interesting that needs more context, peek at user and assistant text only (filter out tool calls):

```bash
tail -200 data/conversations/{sessionId}.jsonl | jq -s '.[] | select(.role == "user" or .role == "assistant") | .blocks[]? | select(.type == "text") | .text' | head -20
```

But prefer summaries — only dive into full JSONL when the summary isn't enough. Skip tool_use and tool_result blocks entirely.

## Phase 2: Extract User Learnings

For each conversation summary, extract learnings about **every person involved** — not just the `user:` in the header. A conversation between Alice and the agent might teach you about Bob's communication style, Carol's debugging approach, or Dave's priorities. Learnings about a person can come from:
- **Direct conversations** — the person is the `user:` (e.g. Bob DMing the agent on Slack)
- **Indirect mentions** — someone else discusses them, their work, their style, or corrects the agent's behavior toward them
- **Observed interactions** — Slack threads, escalations, cross-team exchanges referenced in the conversation

Think like a colleague building a mental model of everyone on the team, not just whoever you're currently talking to.

### What to look for

**Corrections & steering (highest priority):**
Scan for moments where the user redirected the agent: "no, do X instead", "don't do that", "that's wrong", "use Y not Z". These become hard rules in the user's Corrections section. Be specific — "use YAML not JSON for reports" not "prefers structured formats."

**Decision patterns:**
How did they approach problems? What did they investigate first? What did they prioritize? What tools/data sources did they reach for? Example: "Alice pulled metrics from Google Sheets, not the analytics dashboard" → learns information diet + source of truth.

**Expertise signals:**
What domain knowledge did they demonstrate? What did they teach the agent? What level of detail did they operate at?

**Taste & style:**
How much detail do they want in responses? What quality bar do they hold? How do they communicate — terse or detailed? Did they push for polish or accept "good enough"?

**Current focus:**
What are they actively working on? What keeps coming up across conversations?

### Map ALL mentioned people to directories

Use `data/contacts.json` to map names/emails to contact IDs. The contact `id` is the user directory name under `data/workspace/users/{id}/`.

```bash
cat data/contacts.json | jq -r '.[] | "\(.emails[0] // "no-email") → \(.id) (\(.name))"'
```

Build a list of **every team member** mentioned across all summaries — not just session owners. Then read each relevant user's current `user-context.md` to avoid duplicating what's already captured. Propose updates for every person you learned something new about.

### Categorize into sections

Organize proposed updates into the user-context categories: Who they are, How they operate, Corrections, Their taste, What they're working on. Not every conversation yields every category — only propose what you actually observed.

**Important:** User-learning extraction is always fresh — even if a previous reconcile report exists for today with team-scope proposals. Do NOT skip user extraction just because prior proposals exist. Prior reports may not have done user extraction at all. Always scan summaries for learnings about every mentioned person and propose user-scope updates regardless of prior passes.

## Phase 2.5: Skill Reflection (from traces)

The summarizer writes `.trace.yaml` files with structured session data (tools used, corrections, edge cases, novel patterns). Use these for skill-level analysis.

**Budget: max 8 tool calls for this phase.**

List recent traces:

```bash
find data/conversations -name "*.trace.yaml" -mtime -1 -exec ls -lt {} + 2>/dev/null | head -10
```

Read up to 5 recent traces. For each, cross-reference against existing skills in `data/skills/`:

**Check 1 — Novel workflow:** Does `novel_patterns` describe a multi-step workflow (5+ steps) not covered by any existing skill? Compare against skill filenames and their triggers. If novel, propose a new skill.

**Check 2 — Correction → skill gap:** Does any `corrections[]` entry reveal a missing rule in an existing skill? Match correction topics against skill names. Propose a Pitfall addition.

**Check 3 — Edge case → Pitfall:** Does any `edge_cases[]` entry belong in an existing skill's Pitfalls section? Match by tool name or domain.

**Check 4 — Tool misuse pattern:** Does `tool_failures[]` with `recovered: true` indicate a learnable pattern? Propose a rule in the relevant skill.

**Check 5 — Script candidate:** Does `script_candidates[]` describe a repeatable multi-tool sequence (3+ calls to the same MCP)? Cross-reference against existing scripts in `data/scripts/` and `src/scripts/` — skip if already extracted. Propose as a `/mcp-to-script` extraction task.

**Output:** Skill proposals under "Skill-Scope Changes", script candidates under "Script Candidates" in the report. For new skill proposals, use this template:
- Frontmatter: `origin: auto`, `generated: {date}`, `from_traces: [session-ids]`, `confidence: low|medium`, `reviewed: false`
- Sections: When to Use / Procedure / Pitfalls / Verification

If no traces exist or none yield findings, skip this phase silently.

## Phase 3: Audit Team-Scope Files

Read the key workspace files (context.md, tasks.md, open-questions.md) and skim knowledge/*.md filenames. Don't read every file — focus on the ones most likely stale.

A single conversation can yield both user-scope and team-scope learnings. The user-specific angle goes to user-scope, the team fact goes to team-scope.

For each file you audit, note:
- **Staleness**: dates older than 2 weeks, metrics that may have changed
- **Completeness**: tasks marked done but still listed, resolved questions still open
- **Duplication**: same fact appearing in multiple files
- **Contradictions**: conflicting info between files

## Phase 4: Classify & Report

**CRITICAL: This is your FINAL phase. Do NOT proceed to Phase 5 (Apply) unless the user explicitly replies with approval numbers.** Write the report, send the DM, and STOP. The reconcile job ends here — application happens in a separate conversation when the user responds.

Compile findings into a timestamped reconciliation report. Create the reports folder if needed:

```bash
mkdir -p data/workspace/reconcile-reports
```

Write the report to `data/workspace/reconcile-reports/{YYYY-MM-DD}.md`:

```markdown
# Reconciliation Report — {date}

## Findings
- {number} stale items, {number} new learnings, {number} issues

## Skill-Scope Changes
1. **New skill**: `{name}` — {description}
   - **Source traces**: {session IDs}
   - **Proposed sections**: {brief outline}

2. **Patch**: `{skill}.md` — add Pitfall: {description}
   - **Source**: {session title}: {what happened}

## Script Candidates
1. **{description}** — `{mcp}`, {N} tool calls/run
   - **Source**: {session title}
   - **Sequence**: {tool1} → {tool2} → {tool3}
   - **Action**: Run `/mcp-to-script {description}` to extract

## Team-Scope Changes
1. **File**: {path} | **Action**: {update/add/remove/deduplicate}
   - **Current**: {brief quote}
   - **Proposed**: {what it should say}
   - **Source**: {session title or audit finding}

## User-Scope Changes
{group by user name}

### {User Name} (`users/{id}/`)

**Corrections:**
1. {concrete rule extracted from a steering/correction moment} — Source: {session}

**Patterns:**
1. **{Category}**: {observation} — Source: {session}

## Suggestions
- {structural improvements, missing knowledge files, etc.}
```

Then send a Slack DM summary using `post_slack_message`:

```
🔄 Nightly Reconciliation — {date}

{number} findings, {number} proposed changes.
Full report: data/workspace/reconcile-reports/{date}.md

Skill-scope:
1. {1-liner — new skill or patch}
...

Script candidates:
1. {description} — `{mcp}`, {N} calls/run → `/mcp-to-script`
...

Team-scope:
1. {1-liner}
...

User-scope:
{N}. {User Name} (`users/{id}/`)
   Corrections:
   • {concrete rule}
   • {concrete rule}
   Patterns:
   • {category}: {observation}
   • {category}: {observation}

Reply with numbers to approve (e.g. "1,3,5") or "all" to apply everything.
```

**User-scope proposals must show the actual content inline with context** — for each correction or pattern, show what you'd write AND the story behind it (which session, what happened, why you think it's a durable learning). The user needs to judge: "yes, that's how I always work" vs "that was a one-off, don't generalize." Format:

```
{N}. {User Name} (`users/{id}/`)
   Corrections:
   • {concrete rule}
     → {session}: {what happened that taught you this}
   Patterns:
   • {category}: {observation}
     → {session(s)}: {evidence — what you saw them do}
```

A 1-liner like "Populate user context" is useless — show what you'd write and why.

**Use numbered lists for all proposed changes** — both in the Slack message and the report file — so the user can reply with numbers to approve specific items.

## Phase 5: Apply Approved Changes (only when asked)

When the user replies with approvals (e.g. "1,3,5" or "all"), load the specific report file from `data/workspace/reconcile-reports/` and process only the approved items.

**Mode check:** Read `selfImprovement` from `data/agent-config.json`. Map proposal types to areas: new skills → `skillCreation`, skill patches → `skillPatching`, user context → `userContext`, knowledge/context → `teamKnowledge`. If the area is `"auto"`, apply without waiting for approval and notify via Slack. If `"approval"` (default), wait for explicit approval numbers.

Create a git checkpoint first:

```bash
cd data && git add -A && git commit -m "reconcile: pre-checkpoint $(date +%Y-%m-%d)" --allow-empty
```

Apply the approved edits, then commit:

```bash
cd data && git add -A && git commit -m "reconcile: $(date +%Y-%m-%d) — <brief summary>"
```

If the user provides feedback or corrections alongside approvals, treat those as learnings — update the relevant workspace files to reflect the correction.

## Guidelines

- **Report, don't act** — never edit workspace files without explicit approval
- **Stay lean** — under 30 tool calls; skim don't deep-read
- **Summaries first** — always check `.summary.md` before touching raw JSONL
- **Be conservative** — when unsure, flag as "verify?" rather than proposing deletion
- **Preserve voice** — match the existing tone of workspace files
- **Don't fabricate** — only propose facts from conversations or existing files
- **Cite sources** — every proposed change references the session or file it came from
- **Knowledge hierarchy**: `context.md` is a discovery index (IDs, pointers, 1-liners). `knowledge/*.md` files hold detail. When deduplicating, keep detail in knowledge/ and replace the context.md copy with a pointer (`See knowledge/foo.md`).
