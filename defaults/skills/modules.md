---
description: Know which data-plane modules are installed/enabled and manage their lifecycle (enable/disable/configure) via the internal REST API — with the doctrine gate on when you may act vs propose.
triggers:
  - what modules are enabled
  - what modules are installed
  - module status
  - enable module
  - disable module
  - configure module
  - list modules
---

Data-plane modules bundle skills + schedules + seed files, installed and reconciled at runtime. Here's how to know what's on and how to change it.

## Knowing what's installed / enabled

- **Source of truth**: read `data/modules/state.json` — installed modules with `enabled`, `version`, `config`. Only this file answers "is the module on."
- **API**: `curl -s -H "x-internal-token: $INTERNAL_API_TOKEN" http://localhost:$PORT/api/modules | jq .` — installed + available built-ins (shipped in `defaults/modules/`, e.g. `routine`; install by `{"name":"routine"}`).
- **Skill index**: module-rendered skills carry `managed-by: <module>@<version>` frontmatter — if you see it on a skill, a module owns that file.

## How lifecycle changes surface

- Enable/disable/install/uninstall appends a line to the workspace journal — trust it as a signal, verify in `state.json`.
- A disabled module's seed files get a dormancy header (`> [<module> disabled <date> — retained as state; no proactive cadence active]`). **Seeds are memory, not status**: an agenda/log file existing — even without the header — does not mean the module is active. Check `state.json` before acting on any cadence a seed implies.
- Disabling also disables the module's declared schedules *and* offspring schedules you created under its doctrine — don't re-create them while it's off.

## Managing modules

```bash
H='-H "x-internal-token: $INTERNAL_API_TOKEN"'  # all calls need this header
# NOTE: mutations are owner-gated — use a SCOPED internal token (carries the owner session).
# The legacy global token maps to a non-owner identity and gets 403 on everything but GET.
POST /api/modules/:name/enable | disable
PUT  /api/modules/:name/config     # JSON body validated vs configSchema, then reconciled
POST /api/modules/install          # {"name":"<builtin>"} or {"path":"<folder>"}
DELETE /api/modules/:name          # uninstall — seeds stay
```

**Doctrine gate:**
- enable / disable / config change — **tier-b**: propose to the owner and wait, *unless* the owner explicitly asked for this change in the current session (then do it and report).
- install / uninstall — **always** propose-then-approve. Never self-install, even if you authored the module (see create-module skill).
