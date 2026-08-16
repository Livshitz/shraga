---
description: Structural maintenance of the workspace knowledge base — deduplicate, restructure, compress, and cross-reference (run before reconcile).
---

# Knowledge Gardening

You are performing structural maintenance on the workspace knowledge base — deduplicating, restructuring, compressing, and cross-referencing. Think of this as defragmenting the team's shared memory: same information, better organized.

**Budget: stay under 40 tool calls total.** Subagents handle the heavy reading.

**Run garden BEFORE reconcile.** Garden cleans the house (dedup, compress, stale removal), then reconcile furnishes it (new content from conversations). Adding new content to a messy workspace compounds the mess.

**Approval goes to owners.** Look up contacts tagged `owner` (i.e. `isOwner: true`) in `<known_contacts>` and send the report to their Slack DMs.

## Mode check — do this FIRST, before Phase 1

Read `selfImprovement` from `data/agent-config.json` and honor it. Garden only ever edits **team-scope** files — `context.md`, `knowledge/*.md`, `marketing/*.md` — so a single key, `selfImprovement.teamKnowledge`, governs the whole run.

- **`"auto"`** — run Phase 1 → 2 → 3 → **4 (apply)**, then DM a **past-tense** report of what was *done*. Still write the full report file first: it is the audit trail and the revert map. Always include the revert commit SHA in the DM.
- **`"approval"`** (default) — propose only. Write the report, send the DM with numbered proposals, and stop.

### Escalation exception — applies in `auto` too

`auto` means "don't make me approve routine hygiene." It does **not** mean "silently rewrite live claims." Stop and ask the owner when the change:

- **Deletes content that exists nowhere else.** Always relocate verbatim instead; if it can't be relocated, ask.
- **Picks a winner between two conflicting facts** without a grounded source. That's a data question — pull the real source or flag it. Never pick a side silently.
- **Touches a live status claim** — fundraising figures, campaign performance reads, open incident status — rather than structure.
- Is a **large refactor** (splitting a 250+ line file, restructuring the knowledge index wholesale).
- Is **security-related**, or touches auth/permissions/credentials, or lives in `users/{id}/`.

The bar: *"would a reasonable person be annoyed if I did this without asking?"* No → do it and report. Yes → ask. Routine dedup / compress / cross-ref / stale-collapse / new-facts is always "do it".

## Phase 1: Snapshot & Checkpoint

Create a git checkpoint so any changes can be reverted with `cd data && git revert HEAD`.

```bash
cd data && git add -A && git commit -m "garden: pre-checkpoint $(date +%Y-%m-%d)" --allow-empty
```

Read all workspace files to build your mental model:
- `data/workspace/context.md`
- `data/workspace/tasks.md`
- `data/workspace/open-questions.md`
- All `data/workspace/knowledge/*.md`
- `ls data/workspace/users/` (just list, don't read all)

Note file sizes. Files over 120 lines are split candidates.

## Phase 2: Diagnose (parallel subagents)

Spawn 3 Explore agents in parallel. Each gets a focused checklist and returns a short structured report.

**Agent A — Duplication & cross-ref scan:**
> Read data/workspace/context.md and every data/workspace/knowledge/*.md file. Report:
> 1. Content that appears in BOTH context.md AND a knowledge file (quote both)
> 2. Facts in knowledge/ files not indexed in context.md's knowledge table
> 3. Cross-references that should exist between knowledge files but don't
> Format: numbered list, each with file paths and quoted evidence.

**Agent B — Staleness & hygiene:**
> Today's date is {YYYY-MM-DD}. Read data/workspace/context.md, data/workspace/tasks.md, data/workspace/open-questions.md. Report:
> 1. Dates older than 2 weeks from today (quote the line, note the date)
> 2. Tasks marked done but still in active lists
> 3. Questions marked resolved but still in Open section
> 4. Sprint items that look completed but not moved to a "done" section
> Format: numbered list with file:line references.

**Agent C — Structure & coherence:**
> Read data/workspace/context.md's knowledge table, then check each listed file exists under data/workspace/knowledge/. Read each knowledge file's first 10 lines. Report:
> 1. Knowledge table entries pointing to files that don't exist
> 2. Knowledge files that exist but aren't in the table
> 3. Files over 120 lines (with line count)
> 4. Files whose content has drifted from their stated purpose
> Format: numbered list with file paths and line counts.

## Phase 3: Synthesize & Propose

Review all 3 agent reports. Pick the **best 2-3 actionable changes** (max 3, fewer is fine). Use this operations vocabulary:

| Operation | What | Example |
|-----------|------|---------|
| **Dedup** | Same fact in context.md AND knowledge/ | Keep detail in knowledge/, replace context.md copy with pointer |
| **Split** | File over 120 lines | Break into focused files, update index |
| **Compress** | context.md section grew too detailed | Move to knowledge/ with pointer |
| **Stale** | Outdated dates, resolved items still listed | Update or remove |
| **Cross-ref** | Related files don't link to each other | Add "See also" pointers |
| **Orphan** | Content in knowledge/ not in context.md index | Add to knowledge table |

**Selection criteria** — pick changes that:
- Reduce duplication (highest value)
- Improve discoverability (orphans, missing cross-refs)
- Remove noise (stale items)

Skip anything speculative. Only propose what the evidence clearly supports.

### Write the report

```bash
mkdir -p data/workspace/garden-reports
```

Write to `data/workspace/garden-reports/{YYYY-MM-DD}.md`:

```markdown
# Garden Report — {date}

## Raw Agent Reports

### Agent A — Duplication & Cross-ref
{paste full agent A report verbatim}

### Agent B — Staleness & Hygiene
{paste full agent B report verbatim}

### Agent C — Structure & Coherence
{paste full agent C report verbatim}

## Synthesis

{2-3 sentences: what's the overall state? what patterns emerged across agents?}

## Proposed Changes

### 1. [{operation}] {title}
**File(s):** {paths}
**Evidence:** {which agent(s) flagged this, with their exact finding}
**Current (verbatim):**
> {exact quoted lines from the file — enough context to verify}

**Proposed (verbatim):**
> {exact replacement text — what the file will look like after}

**Diff preview:**
    - {removed lines}
    + {added lines}
**Why:** {rationale — why this change, why now, what improves}
**Risk:** {what could go wrong — "none: purely additive" or "removes content: verify X is captured in Y first"}

### 2. [{operation}] ...
{same structure}

### 3. [{operation}] ...
{same structure}

## Skipped Findings
{list findings from agents that you chose NOT to act on, with 1-line reason why — so the reviewer can verify your judgment}
```

The full report is the audit trail. Raw agent reports let you verify the diagnosis. Diff previews let you verify the prescription. Skipped findings let you verify the triage.

### Send Slack DM to owners

Send a DM to each owner (from `<known_contacts>` with Slack IDs) using `post_slack_message`.

**In `approval` mode**, send the proposal DM:

```
🌱 Knowledge Garden — {date}

{N} raw findings → {N} proposed changes (max 3).
Full audit trail: data/workspace/garden-reports/{date}.md

1. [{operation}] {1-liner} — {file}
   Risk: {none/low/medium}
   Diff: -{removed summary} +{added summary}
2. [{operation}] {1-liner} — {file}
   Risk: {none/low/medium}
   Diff: -{removed summary} +{added summary}
3. [{operation}] {1-liner} — {file}
   Risk: {none/low/medium}
   Diff: -{removed summary} +{added summary}

Skipped {N} lower-priority findings (see report).
Reply with numbers to approve (e.g. "1,3") or "all".
```

**In `approval` mode: STOP here. Do not apply changes. Wait for user approval.**

**In `auto` mode: do not stop.** Go to Phase 4 and apply first, then send a **past-tense** report of what was done:

```
🌱 Knowledge Garden — {date} (auto-applied)

{N} raw findings → {N} changes applied.
Full audit trail: data/workspace/garden-reports/{date}.md
Revert: cd data && git revert {commit-sha}

1. [{operation}] {what changed} — {file}
2. [{operation}] {what changed} — {file}

Skipped {N} lower-priority findings (see report).
{Escalated: {anything hitting the escalation exception, as a numbered proposal} — or omit this line}
```

## Phase 4: Apply (auto mode, or when user approves)

In `auto` mode, apply the proposed changes straight after writing the report. In `approval` mode, apply when the user replies with numbers (e.g. "1,3") or "all":

1. Load the report from `data/workspace/garden-reports/{date}.md`
2. Apply the changes using Edit tool — in `auto` mode all of them except anything hitting the escalation exception; in `approval` mode only the approved ones
3. Commit:

```bash
cd data && git add -A && git commit -m "garden: $(date +%Y-%m-%d) — <brief summary of applied changes>" && git rev-parse --short HEAD
```

In `auto` mode, put that SHA in the DM as the revert handle.

**Recovery:** `cd data && git revert HEAD`

## Guidelines

- **Honor the mode** — in `approval`, propose and never edit workspace files without explicit approval; in `auto`, apply and report past-tense, escalating only what hits the escalation exception
- **Max 3 changes** — gardening is incremental; run again tomorrow
- **Preserve voice** — match existing tone of each file
- **context.md is the hot index** — keep it under 100 lines of actual content; push detail to knowledge/
- **knowledge/*.md files hold detail** — keep each under 120 lines; split if growing
- **Don't touch user-scope** — `users/{id}/` is reconcile's domain
- **Cite evidence** — every proposal references the agent finding that supports it
- **Don't fabricate** — restructure existing content, don't invent new facts
