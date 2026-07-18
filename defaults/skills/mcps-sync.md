---
description: Sync MCP server repos — clone new, push+pull existing, register in config, report missing env vars. Run periodically to keep MCP servers up to date.
triggers:
  - sync mcps
  - mcps sync
  - setup mcps
  - provision mcps
  - install mcp servers
  - update mcp repos
---

# MCP Sync

Sync all `mcp-*` repos from GitHub, register in shraga config, report missing env vars.
Run this periodically to keep MCP servers up to date.

## Steps

### 1. Discover repos from GitHub

```bash
gh repo list <your-org-or-user> --limit 100 --json name,sshUrl -q '.[] | select(.name | startswith("mcp-"))'
```

Include all `mcp-*` repos — the `mcp-` prefix is the convention this skill keys on. If your MCP
servers live elsewhere (a different org, or one repo per server under a monorepo), adjust the query
to match; everything downstream only needs a name and a clone URL.

### 2. For each repo: clone, push, or pull

Target directory: wherever you keep the checkouts (e.g. `~/Projects/`). Keep it consistent — the
config paths registered in step 3 point at it.

**If not cloned yet:**
```bash
git clone <sshUrl> <target>/<name>
bun install --cwd <target>/<name>
```

**If already cloned:**
```bash
# Push any committed local changes first
git -C <target>/<name> push 2>/dev/null || true
# Then pull latest
git -C <target>/<name> pull --ff-only
```

If pull fails due to divergence, report it and skip (don't force).

### 3. Symlink into vendor/

For each repo, ensure `vendor/<name>` symlinks to the cloned repo:
```bash
# Check if symlink exists and points correctly
readlink vendor/<name>
# Create/update if needed
ln -sf <target>/<name> vendor/<name>
```

### 4. Register new MCPs in shraga.config.ts

Read `data/shraga.config.ts`. For each repo not already in the `mcps` block:

1. Detect required env vars from `.env.example`:
   ```bash
   grep -E '^[A-Z_]+=.' <repo>/.env.example | cut -d= -f1
   ```

2. Detect CLI entry point (most use `src/mcp/cli.ts`, `mcp-firebase` uses `src/cli.ts`)

3. Add shorthand entry:
   ```typescript
   'mcp-name': {
     env: ['VAR1', 'VAR2'],
   },
   ```

**Never overwrite existing entries.** Only add new ones.

### 5. Report status

Print a summary table:

```
MCP Sync Results:
  mcp-slack-use      up to date
  mcp-firebase   pulled 3 commits
  mcp-pdf        cloned (NEW)
  mcp-cursor     pushed 1, pulled 2

Missing env vars (add to .env):
  mcp-stripe     STRIPE_SECRET_KEY
  mcp-gmail      GOOGLE_SERVICE_ACCOUNT, GMAIL_USER_EMAIL

All configured: mcp-slack-use, mcp-firebase, mcp-google-drive
```

## Rules

- Never write secrets or API key values — only report env var **names**
- Use SSH URLs for cloning (check remote format: `github.com-personal` or `github.com`)
- Don't modify existing entries in shraga.config.ts
- Don't force-push or force-pull — report conflicts
- After adding new MCPs, remind user to restart shraga
- Check `.env` in the shraga project root for existing env var values
