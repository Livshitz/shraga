---
description: Author a data-plane module — a declarative folder (module.json + skill templates + schedules + seeds) that shraga installs, configures, and toggles at runtime. Covers the manifest contract, {{key}} templating, skills-vs-seeds semantics, and the propose-then-approve workflow.
triggers:
  - create a module
  - author a module
  - new module
  - module manifest
  - module.json
  - package a skill as a module
  - data-plane module
---

A **data-plane module** is a declarative folder of skills, schedules, and seed files that shraga installs and reconciles at runtime — no server code. Use it to package a behavior (skill + cadence + state files) so it can be installed, configured, enabled/disabled, and upgraded as one unit.

Not a module: `*.ext.ts` extensions and `registerFeature` features are **server-plane code** (routes, hooks, services). If the behavior needs code, it's not a module.

## Manifest — `module.json`

```json
{
  "name": "standup-notes",
  "version": "1.0.0",
  "description": "Collects a daily standup note and keeps a rolling log.",
  "configSchema": {
    "tz":      { "type": "string", "default": "UTC",   "description": "Timezone" },
    "channel": { "type": "string", "default": "",      "description": "Where to post the note" }
  },
  "skills": ["standup-notes.md.tmpl"],
  "schedules": [
    { "def": "tick", "name": "standup-notes tick",
      "trigger": { "kind": "cron", "expr": "30 9 * * 1-5", "tz": "{{tz}}" },
      "task": { "kind": "prompt", "prompt": "Run the standup-notes skill: collect today's note, post to {{channel}}, append to the log." } }
  ],
  "seeds": ["workspace/standup-log.md"],
  "offspring": { "schedules": "standup-followup-*" },
  "defaultSkills": []
}
```

- `configSchema` — flat map of `{type, default, description}`. Values are user-editable via the modules UI / `PUT /api/modules/:name/config`; every change re-renders.
- `skills` — `.md.tmpl` files rendered into `data/skills/<name>.md` with a `managed-by: <module>@<version>` frontmatter marker.
- `schedules` — schedule defs keyed by a stable `def` (→ schedule id `mod-<module>-<def>`), using the scheduler's native `trigger`/`task` JSON (same shape as `POST /api/schedules` — see the scheduler skill), with `{{key}}` substitution in string values; created with `managedBy`, survive reboots, stay user-editable (reconcile re-overwrites trigger/task but preserves enabled/runCount). `"enabled": false` on a def ships it off on first install (a superseded fallback, say) without forcing it off later.
- `seeds` — files created data-root-relative if missing (e.g. `workspace/standup-log.md`).
- `offspring.schedules` — glob matching schedules the *agent* creates while following the module's skill (e.g. self-booked follow-ups). Disabling the module also disables them.
- `defaultSkills` — module skill names to add to the always-inject list (use sparingly; most skills are on-demand).

## `{{key}}` templating

Any string in skill templates and schedule defs may reference a config key as `{{key}}`. Plain substitution only — **no conditionals or logic**, unknown keys warn. Rendering happens at install, config change, and upgrade.

Branching on a boolean knob: since there are no template conditionals, interpolate the value into a doctrine line and let prose tell the agent how to behave for each value — e.g. `Pilot restriction active: **{{pilotMode}}**.` followed by "When `true`: … / When `false`: …" (see the `routine` builtin).

## Semantics — skills vs seeds vs offspring

| Kind | Nature | On reconcile/upgrade | On disable | On uninstall |
|---|---|---|---|---|
| skills | code | overwritten from template | deleted | deleted |
| schedules (declared) | code | upserted (enabled/runCount preserved) | disabled (snapshot restored on enable) | deleted |
| seeds | state | **never overwritten** | dormancy header stamped, removed on re-enable | **left in place** |
| offspring schedules | agent-created | untouched | disabled, never deleted | disabled, never deleted |

Seeds are memory, not status — never encode "is the module on" in a seed file; only `data/modules/state.json` answers that.

## Authoring workflow

1. Scaffold in `workspace/modules-dev/<name>/` — `module.json` + templates + seed files. Keep the skill under ~15 lines, direct-instruction tone (see the add-skill skill).
2. Validate: manifest parses, every `{{key}}` exists in `configSchema`, schedule crons are sane.
3. Install: `curl -s -X POST -H "x-internal-token: $INTERNAL_API_TOKEN" http://localhost:$PORT/api/modules/install -d '{"path":"workspace/modules-dev/<name>"}' -H 'content-type: application/json'`
4. Iterate: edit source → re-install; tune values via `PUT /api/modules/:name/config` (triggers reconcile).

## Agent rule — propose, never self-install

You may **author** a module folder and present it (folder path + one-paragraph summary of what it installs and when it fires) — but a **human installs it**. Never call the install endpoint on your own initiative; step 3 above runs only after the owner explicitly approves in-session.
