---
description: Extract structured YAML trace from conversation transcripts. Used by the conversation summarizer for downstream analysis.
model: haiku
max-turns: 1
---

You are extracting a structured trace from a conversation transcript. Output ONLY valid YAML — no markdown fences, no explanation, no commentary before or after.

Use this exact schema:

```
session_id: (provided in metadata)
user: (provided in metadata)
date: (provided in metadata)
title: (provided in metadata)
duration_estimate: short|medium|long
summary: |
  2-3 sentence narrative of what happened.
tools_used:
  - tool.name
tool_call_count: (count of tool invocations)
tool_failures:
  - tool: tool.name
    error: "brief error description"
    recovered: true|false
corrections:
  - "Direct quote or paraphrase of user redirections"
skills_loaded:
  - skill-name
edge_cases:
  - "Non-obvious discovery about an API, system, or workflow"
novel_patterns:
  - description: "Multi-step workflow description"
    steps: (number of steps)
    tools:
      - tool.name
script_candidates:
  - description: "What the repeatable sequence does"
    mcp: mcp-server-name
    tool_sequence:
      - tool.name
    call_count: (number of sequential calls)
outcome: success|partial|failed|abandoned
```

Rules:
- `duration_estimate`: short = <10 messages, medium = 10-50, long = 50+
- `corrections`: only include moments where the user explicitly redirected ("no", "don't", "that's wrong", "use X instead"). Not questions or clarifications.
- `edge_cases`: non-obvious technical discoveries — API quirks, undocumented behavior, workarounds. Not routine findings.
- `novel_patterns`: only workflows with 5+ coherent sequential tool calls forming a reusable pattern. Most sessions have none — use an empty list.
- `script_candidates`: 3+ sequential calls to the same MCP doing a deterministic fetch→transform→output pattern. Must be repeatable (not exploratory back-and-forth). Most sessions have none — use an empty list.
- `tool_failures`: only actual errors, not expected empty results.
- `skills_loaded`: extract from context/system blocks mentioning loaded skills.
- `outcome`: success = task completed, partial = some parts done, failed = couldn't complete, abandoned = user stopped early.
- Omit empty lists — use `[]` only, never `null`.

Example output:

session_id: abc-123
user: alice@example.com
date: "2026-05-20"
title: "Stripe dispute investigation"
duration_estimate: medium
summary: |
  Investigated Stripe disputes for Q1. Found 47 chargebacks totaling $12K.
  Created filtered export and posted summary to #finance channel.
tools_used:
  - stripe.get_disputes
  - stripe.get_charges_by_id
  - mcp-slack-use.post_slack_message
tool_call_count: 15
tool_failures:
  - tool: stripe.get_disputes
    error: "timeout on unfiltered query"
    recovered: true
corrections:
  - "Don't include test-mode disputes in the report"
skills_loaded:
  - stripe
edge_cases:
  - "Stripe disputes API returns max 100 per page even with all=true when date range exceeds 90 days"
novel_patterns: []
script_candidates: []
outcome: success
