# routine

Turns the agent into a self-driving daily operator: a rendered `routine` skill (the operating contract — hours, OKR-anchored priority function, tick logic, autonomy tiers, comms policy), two schedules, and a seeded `workspace/agenda.md` the dispatcher uses as working memory.

## What installs

- **Skill** `skills/routine.md` — rendered from the template with your config.
- **Schedule** `routine-tick` (enabled) — hourly dispatcher tick during work hours; most ticks end in a skip.
- **Schedule** `routine-work-block` (**ships disabled**) — a superseded midday fallback; enable only if you want a guaranteed daily work block instead of tick-driven cadence.
- **Seed** `workspace/agenda.md` — created only if missing; never overwritten.

## Config

| Key | Default | Meaning |
|---|---|---|
| `workingDays` | `Sun–Thu` | Working days (prose, shown in the skill) |
| `workHours` | `08:00–18:00` | Working hours (prose) |
| `tz` | `Asia/Jerusalem` | IANA timezone for schedules and hours |
| `tickCron` | `0 8-17 * * 0-4` | Dispatcher tick cron — keep inside work hours |
| `tickModel` | `haiku` | Model for the dispatcher tick — keeps ticks on a cheap model |
| `maxSelfWakesPerDay` | `4` | Max agent-booked `self-wake-*` continuations per day |
| `workBlockCron` | `0 12 * * 0-4` | Fallback work-block cron (schedule ships disabled) |
| `okrSource` | `okrs/q3-2026-draft.md` | Data-relative OKR doc anchoring the priority function |
| `channel` | `#agf-dev` | Primary comms channel once past pilot |
| `ownerName` | `Elya` | Human owner all pilot-mode comms route to |
| `pilotMode` | `true` | `true` = no team tagging, everything to the owner; `false` = channel-first threaded comms |

Changing config re-renders the skill and schedules (`PUT /api/modules/routine/config`).

Note: adopted/managed schedules become `scope: system` — their sessions are visible to all whitelisted users (team-transparency doctrine).

## Offspring

Agent-booked continuations matching `self-wake-*` are treated as the module's offspring: disabling or uninstalling the module disables them (never deletes) so they can't fire into a missing skill.

## Uninstall semantics

Rendered skill and the two module schedules are removed. **State stays**: `workspace/agenda.md` (and any board/log files the doctrine produced) are memory, not status — they remain on disk with a dormancy header. Only `data/modules/state.json` answers whether the module is on.
