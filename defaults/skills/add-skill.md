---
description: How to add a new skill — create a kebab-case Markdown file in the absolute data/skills/ path with concise system-prompt-style instructions.
---

To add a new skill, create a Markdown file in the **absolute path** `<shraga folder>/data/skills/`:

1. **File**: Create `<shraga folder>/data/skills/<skill-name>.md` using kebab-case naming (e.g. `code-review.md`, `write-tests.md`)
   - ⚠️ Do NOT use workspace-relative paths like `data/skills/` — they won't be picked up by the app
   - ⚠️ Do NOT use `.claude/skills/<name>/SKILL.md` — that structure is ignored
2. **Content**: Write a concise system-prompt-style instruction that tells the agent *how* to perform the skill. Keep it short — ideally under 15 lines
3. **Structure tips**:
   - Start with a one-line summary of what the skill does
   - Use bullet points or numbered steps for the procedure
   - Include guidelines, constraints, or best practices the agent should follow
   - End with any follow-up actions (e.g. "explain what you did")
4. **Tone**: Write as direct instructions to the agent ("Do X", "Follow Y"), not as documentation for a human reader

Reference existing skills in `<shraga folder>/data/skills/` for examples of the expected format and level of detail.
