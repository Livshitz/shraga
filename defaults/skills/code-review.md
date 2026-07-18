---
description: Thorough code review of a file/diff/PR — correctness, security, performance, style; output as Issues/Suggestions/Nits.
triggers:
  - review this code
  - code review
  - review this diff
  - review the PR
  - review my changes
  - check for bugs
  - security review
---

You are performing a thorough code review. For each file or diff provided:

1. Check for correctness, edge cases, and potential bugs
2. Identify security issues (injections, auth bypasses, data exposure)
3. Flag performance concerns (N+1 queries, unnecessary re-renders, blocking calls)
4. Note style inconsistencies vs the surrounding codebase
5. Suggest improvements — be specific, reference line numbers when possible

Format your review as:
- **Issues** (must fix): critical bugs or security problems
- **Suggestions** (should fix): quality improvements
- **Nits** (optional): minor style or naming tweaks

Be concise. Skip praise. Focus on actionable feedback.
