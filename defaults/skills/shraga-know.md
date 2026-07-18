---
description: "Audit shraga agent knowledge health. Default: session-scoped (check what this session touched). Pass 'full' or 'all' for exhaustive audit across all knowledge layers."
argument-hint: "[full|all|freshness|skills|users|reconcile]"
---

# Shraga Knowledge Audit

Diagnose the health of the shraga agent's runtime knowledge layer.

**Scope: agent runtime only.** Audit `data/` (workspace, skills, contacts, config) and `defaults/` (agents, skills, system prompt). NEVER inspect `.claude/`, `CLAUDE.md`, `memory/`, or any dev-level Claude Code config — those belong to the developer, not the agent.

## Modes

- **Default (no args / "this session")**: Session-scoped audit. Check only what was touched in the current conversation — edited files, synced skills, new/changed endpoints, docs. Fast and focused.
- **`full` or `all`**: Exhaustive audit across all knowledge layers (sections 1-8 below).
- **Named section** (e.g. `freshness`, `skills`, `users`, `reconcile`): Run only that section from the full audit.

## Session-Scoped Audit (default)

Review your conversation history to identify files you created, edited, or synced. Then check:

### A. Defaults→Data Sync

For every file in `defaults/skills/` or `defaults/agents/` that was edited this session, verify the `data/` copy matches:

```bash
# For each edited defaults/ file, check its data/ counterpart
for f in {list of edited defaults/skills/*.md files}; do
  name=$(basename "$f")
  data="data/skills/$name"
  if [ -f "$data" ]; then
    if ! diff -q "$f" "$data" > /dev/null 2>&1; then
      echo "DRIFT: $name"
    fi
  else
    echo "MISSING in data/: $name"
  fi
done
```

If drifted, sync immediately: `cp defaults/skills/X.md data/skills/X.md`

### B. Docs Consistency

For every behavioral change (new params, changed defaults, new endpoints):
- Check that `defaults/skills/platform.md` (or relevant skill) documents the change
- Check that `CLAUDE.md` key endpoints section is still accurate if endpoints changed
- Check that any skill referencing the changed code is updated

### C. Related Skills Impact

If the session changed agent-facing behavior:
- Grep `defaults/skills/` and `data/skills/` for references to the changed function/endpoint/param
- Flag any skill that references old behavior

```bash
# Example: check for references to changed endpoint behavior
grep -rn "api/chat" defaults/skills/ data/skills/ 2>/dev/null
```

### D. Scope Placement

For every knowledge file written or edited this session, verify it landed in the right layer. Apply the test from `workspace.md`: *"would this be true/useful for a different user?"*

- **User-scope content** (`users/{id}/user-context.md`, `users/{id}/...`) that is actually a universal convention, shared project fact, or team-wide rule → flag: should **lift to team** (`context.md` / `knowledge/`).
- **Team-scope content** (`context.md`, `knowledge/*.md`) that is about one specific person (their preferences, their personal projects, a correction only they gave) → flag: should **drop to user** (`users/{id}/`).

A single lesson can legitimately live in both (e.g. a correction you gave that is also a universal rule). The flag is for content sitting in the *wrong* or *only* layer. When in doubt, surface it rather than silently pass.

### E. Quick Health Checks

Run only on files touched this session:

```bash
# Check edited skills have valid frontmatter
for f in {list of edited skill files}; do
  head -5 "$f" | grep -q "description:" || echo "MISSING description: $f"
done
```

### Output Format (session)

```
## Session Audit — {date}

### Files Changed
- {list from conversation history}

### Sync Status
- {file}: {in sync | DRIFTED → fixed | not applicable}

### Docs
- {endpoint/behavior}: {documented | MISSING docs | STALE docs}

### Scope Placement
- {file/lesson}: {correct layer | should LIFT to team | should DROP to user}

### Action Items
1. {fix}
```

---

## Full Audit (pass `full` or `all`)

Run each check section below. Report findings as a table per section. Skip sections not relevant to the focus argument.

### 1. Freshness Check

Check last-modified dates on critical files. Flag anything older than the threshold.

```bash
# Core workspace files (threshold: 3 days)
stat -f "%Sm %N" -t "%Y-%m-%d" data/workspace/context.md data/workspace/open-questions.md data/workspace/tasks/tasks.md 2>/dev/null

# Knowledge files (threshold: 7 days)
find data/workspace/knowledge -name "*.md" -exec stat -f "%Sm %N" -t "%Y-%m-%d" {} \; 2>/dev/null | sort

# User contexts (threshold: 7 days)
find data/workspace/users -name "user-context.md" -exec stat -f "%Sm %N" -t "%Y-%m-%d" {} \; 2>/dev/null | sort
```

Report: file, last modified, days stale, status (fresh/stale/critical).

### 2. Knowledge Index Completeness

Every file in `data/workspace/knowledge/*.md` should be referenced in `data/workspace/context.md`'s knowledge table. Check for:
- **Unindexed files**: exist in knowledge/ but not mentioned in context.md
- **Dead references**: mentioned in context.md but file doesn't exist
- **Status markers**: check if any files still say "DRAFT" or "not yet implemented" in their first 5 lines

```bash
# List all knowledge files
ls data/workspace/knowledge/*.md 2>/dev/null | xargs -I{} basename {}

# Check context.md references
grep -o 'knowledge/[a-z0-9_-]*\.md' data/workspace/context.md 2>/dev/null
```

### 3. User Context Completeness

For each user in `data/contacts.json`, check their context file exists and has substance.

```bash
# Map contacts to user dirs
bun -e "
const c = JSON.parse(require('fs').readFileSync('data/contacts.json','utf-8'));
const { statSync, existsSync, readFileSync } = require('fs');
for (const u of c) {
  const p = 'data/workspace/users/' + u.id + '/user-context.md';
  const exists = existsSync(p);
  const lines = exists ? readFileSync(p,'utf-8').split('\n').length : 0;
  const size = exists ? statSync(p).size : 0;
  const mod = exists ? new Date(statSync(p).mtimeMs).toISOString().slice(0,10) : '-';
  console.log([u.name || u.id, exists?'yes':'NO', lines+'L', size+'B', mod].join(' | '));
}
"
```

Flag: missing files, files <10 lines (sparse), files >7 days stale.

### 4. Reconcile Sync Gap

Compare the latest reconcile report against source files to find proposed-but-unapplied changes.

```bash
# Find latest reconcile report
ls -t data/workspace/reconcile-reports/*.md 2>/dev/null | head -1
```

Read the latest report. For each proposed change:
- Check if the target file was modified AFTER the report date
- If not modified → flag as "pending sync"
- Count: applied vs pending vs unknown

### 5. Skills Health

```bash
# All skills with line counts and frontmatter presence
for f in data/skills/*.md; do
  name=$(basename "$f" .md)
  lines=$(wc -l < "$f")
  has_desc=$(head -10 "$f" | grep -c "description:")
  has_triggers=$(head -20 "$f" | grep -c "triggers")
  echo "$name | ${lines}L | desc:$has_desc | trig:$has_triggers"
done
```

Check:
- **Large skills (>200 lines) without triggers**: should be trigger-loaded, not always-injected
- **Missing descriptions**: limits discoverability in skill index
- **Defaults.json sanity**: check for duplicates, missing files

```bash
# Check defaults for duplicates and missing files
bun -e "
const d = JSON.parse(require('fs').readFileSync('data/skills-defaults.json','utf-8'));
const names = d.map(e => typeof e === 'string' ? e : e.name);
const dupes = names.filter((n,i) => names.indexOf(n) !== i);
if (dupes.length) console.log('DUPLICATES:', dupes);
const { existsSync } = require('fs');
for (const n of [...new Set(names)]) {
  if (!existsSync('data/skills/' + n + '.md')) console.log('MISSING:', n);
}
console.log('Total defaults:', names.length, '| Unique:', new Set(names).size);
"
```

### 6. Defaults→Data Sync

Check that canonical `defaults/skills/` and `defaults/agents/` are in sync with their `data/` copies.

```bash
# Skills: compare defaults that also exist in data/
for f in defaults/skills/*.md; do
  name=$(basename "$f")
  data="data/skills/$name"
  if [ -f "$data" ]; then
    if ! diff -q "$f" "$data" > /dev/null 2>&1; then
      echo "DRIFT: $name (defaults differs from data)"
    fi
  fi
done

# Agents: verify all defaults/agents/ are loadable
for f in defaults/agents/*.md; do
  name=$(basename "$f" .md)
  echo "agent: $name"
done
```

Flag any drifted skills — usually means `defaults/` was edited but not synced to `data/`.

### 7. Scope Placement Audit

Scan knowledge content for layer misplacement. Apply the test: *"would this be true/useful for a different user?"* — yes → team, only-about-this-person → user.

- **Team files** (`context.md`, `knowledge/*.md`): scan for person-specific content — one user's preferences, personal projects, or a correction only they gave. Flag → should drop to that user's area.
- **User files** (`users/{id}/user-context.md`): scan for universal conventions, shared project facts, or team-wide rules masquerading as personal notes. Flag → should lift to team scope.

```bash
# Heuristic: flag named-person references in team-scope knowledge
grep -rniE "(my |i prefer|personal project|don't |never )" data/workspace/knowledge/*.md data/workspace/context.md 2>/dev/null | head -20
```

Treat hits as candidates, not verdicts — judge each by the test above. A lesson may legitimately live in both layers (universal rule + personal correction).

### 8. Hot Context Size Estimate

Estimate the total bytes injected into every conversation (hot context).

```bash
bun -e "
const { readFileSync, existsSync } = require('fs');
const defaults = JSON.parse(readFileSync('data/skills-defaults.json','utf-8'));
let total = 0;
const items = [];
for (const entry of defaults) {
  const name = typeof entry === 'string' ? entry : entry.name;
  const capped = typeof entry === 'object' && entry.capped;
  const cap = typeof entry === 'object' && entry.cap || 600;
  const p = 'data/skills/' + name + '.md';
  if (!existsSync(p)) { items.push([name, 'MISSING', 0]); continue; }
  const size = readFileSync(p,'utf-8').length;
  const effective = capped ? Math.min(size, cap) : size;
  total += effective;
  items.push([name, capped ? 'capped@'+cap : 'full', effective]);
}
for (const [n,mode,s] of items) console.log(n + ' | ' + mode + ' | ' + s + ' chars');
console.log('---');
console.log('Total hot skills: ~' + (total/1024).toFixed(1) + ' KB');
// Add system prompt estimate
const sp = existsSync('defaults/system-prompt.md') ? readFileSync('defaults/system-prompt.md','utf-8').length : 0;
console.log('System prompt: ~' + (sp/1024).toFixed(1) + ' KB');
console.log('Estimated hot total: ~' + ((total+sp+2000)/1024).toFixed(1) + ' KB (skills+prompt+roster+index)');
"
```

Warn if hot total exceeds 15 KB.

### Output Format (full)

```
## Knowledge Audit — {date}

### Freshness
| File | Modified | Days | Status |
| ... | ... | ... | ... |

### Index Coverage
- Indexed: {N}/{total} knowledge files
- Unindexed: {list}
- Dead refs: {list}
- Draft files: {list}

### User Contexts
| User | Exists | Lines | Size | Modified | Status |
| ... | ... | ... | ... | ... | ... |

### Reconcile Sync
- Latest report: {date}
- Proposed: {N} changes
- Applied: {N} | Pending: {N}

### Skills Health
- Total: {N} | With description: {N} | With triggers: {N}
- Large without triggers: {list}
- Defaults duplicates: {list}

### Defaults→Data Sync
- Drifted: {list or "all in sync"}
- Agents: {list}

### Scope Placement
- Misplaced (team→user): {list or "none"}
- Misplaced (user→team): {list or "none"}

### Hot Context
- Total injected: ~{N} KB
- Status: {OK | WARNING: exceeds 15KB}

### Action Items
1. {prioritized fix}
2. {prioritized fix}
...
```

## Pitfalls

- `stat` flags differ on macOS vs Linux — the commands above use macOS format (`-f "%Sm"`). On Linux use `stat -c "%y %n"`.
- Don't read full knowledge files for freshness — `stat` is enough.
- Reconcile sync detection is heuristic (file mtime vs report date) — not a guaranteed "applied" check.
- Some skills intentionally have no triggers (manual-only like `/reconcile`). Don't flag those.
