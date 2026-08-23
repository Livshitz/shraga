---
description: Create/manage scheduled jobs (cron/interval/once) and event-triggered automations via the internal API — incl. the event bus, built-in event sources (schedule.finished), per-trigger throttling, and the failure-notifier builtin.
triggers:
  - schedule a job
  - cron job
  - recurring task
  - event trigger
  - react to an event
  - event-based job
  - emit an event
  - event bus
  - schedule.finished
  - notify on failure
  - failure notifier
  - throttle
  - how do i schedule
---

You can manage scheduled jobs and event-triggered automations via the internal REST API. Requests are authenticated as the current user (your uid/email are injected into env automatically).

## Auth Header

All requests need: `-H "x-internal-token: $INTERNAL_API_TOKEN"`

This authenticates you as the current session user — you'll have the same permissions they have (can only edit/delete your own schedules, system schedules are read-only).

Base URL: `http://localhost:$PORT`

## Endpoints

### List all schedules
```bash
curl -s -H "x-internal-token: $INTERNAL_API_TOKEN" http://localhost:$PORT/api/schedules | jq .
```
Returns `{ schedules: [...], runningIds: [...] }`.

### Get one schedule
```bash
curl -s -H "x-internal-token: $INTERNAL_API_TOKEN" http://localhost:$PORT/api/schedules/{id} | jq .
```

### Create a schedule
```bash
curl -s -X POST -H "Content-Type: application/json" -H "x-internal-token: $INTERNAL_API_TOKEN" \
  http://localhost:$PORT/api/schedules \
  -d '{
    "name": "My task",
    "enabled": true,
    "trigger": { "kind": "cron", "expr": "0 9 * * 1-5", "tz": "Asia/Jerusalem" },
    "task": { "kind": "prompt", "prompt": "Do the thing" }
  }' | jq .
```

### Create an event-triggered schedule

Instead of a time, an `event` trigger fires when a matching external event arrives (a webhook, a signal from another system, an internal watcher). The event payload is injected into the run.

```bash
curl -s -X POST -H "Content-Type: application/json" -H "x-internal-token: $INTERNAL_API_TOKEN" \
  http://localhost:$PORT/api/schedules \
  -d '{
    "name": "Handle paid invoice",
    "enabled": true,
    "trigger": { "kind": "event", "source": "stripe", "match": { "type": "invoice.paid" } },
    "task": { "kind": "prompt", "prompt": "An invoice was paid — thank the customer and log it." }
  }' | jq .
```

- `source` (required) routes the event. `match` (optional) is an AND-filter of payload **dot-paths** → expected values (case-insensitive, e.g. `{"data.amount": "42"}`). No `match` → fires on any event with that source.
- The event reaches the agent: for `prompt` tasks it's appended as a framed `Event data` JSON block; for `job` tasks it's passed as the `SHRAGA_EVENT` env var (never into the command string). `bash` tasks run their command as-is (no payload injected) — use a `prompt` or `job` task when the run needs the event data.
- "Run now" works on event schedules too (fires without event data — handy for testing).

### Create a one-time future schedule
```bash
curl -s -X POST -H "Content-Type: application/json" -H "x-internal-token: $INTERNAL_API_TOKEN" \
  http://localhost:$PORT/api/schedules \
  -d '{
    "name": "Send weekly report",
    "enabled": true,
    "trigger": { "kind": "once", "at": 1748000000000 },
    "task": { "kind": "prompt", "prompt": "Compile and send the weekly report" }
  }' | jq .
```
Compute `at` as epoch milliseconds (e.g. `Date.now() + 3600000` for 1 hour from now). Must be in the future. Once-schedules auto-delete after completing.

### Update a schedule
```bash
curl -s -X PUT -H "Content-Type: application/json" -H "x-internal-token: $INTERNAL_API_TOKEN" \
  http://localhost:$PORT/api/schedules/{id} \
  -d '{ "name": "New name", "trigger": { "kind": "cron", "expr": "0 8 * * *", "tz": "UTC" } }' | jq .
```
Partial update — only include fields to change. System schedules cannot be edited.

### Delete a schedule
```bash
curl -s -X DELETE -H "x-internal-token: $INTERNAL_API_TOKEN" http://localhost:$PORT/api/schedules/{id} | jq .
```
System schedules cannot be deleted.

### Enable/disable a schedule
```bash
curl -s -X POST -H "Content-Type: application/json" -H "x-internal-token: $INTERNAL_API_TOKEN" \
  http://localhost:$PORT/api/schedules/{id}/toggle \
  -d '{ "enabled": true }' | jq .
```

### Run a schedule now
```bash
curl -s -X POST -H "Content-Type: application/json" -H "x-internal-token: $INTERNAL_API_TOKEN" \
  http://localhost:$PORT/api/schedules/{id}/run \
  -d '{ "override": "optional override prompt" }' | jq .
```

### Cancel a running schedule
```bash
curl -s -X POST -H "x-internal-token: $INTERNAL_API_TOKEN" http://localhost:$PORT/api/schedules/{id}/cancel | jq .
```

### Get run history for a schedule
```bash
curl -s -H "x-internal-token: $INTERNAL_API_TOKEN" http://localhost:$PORT/api/schedules/{id}/runs | jq .
```

## Schedule Shape

```typescript
Trigger:
  { kind: "once", at: <epoch_ms> }
  { kind: "interval", everyMs: <ms> }       // min 1000
  { kind: "cron", expr: "<cron>", tz: "<IANA_tz>" }
  { kind: "event", source: "<name>", match?: { "<dot.path>": "<value>" } }

Task:                                      // model/engine pin the runtime (see below)
  { kind: "prompt", prompt: "<text>", model?: "<model>", engine?: "<engine>" }
  { kind: "bash", command: "<cmd>", model?: "<model>", engine?: "<engine>" }

Schedule: { id, name, enabled, trigger, task, scope, createdBy, nextRun?, lastRun?, runCount,
            onMissed?, missedRun? }
```

`task.model` / `task.engine` pin what the run executes on, instead of the instance default:
`model` takes an alias (`opus`, `haiku`) or a provider-qualified id (`cursor/composer-2.5`);
`engine` names a registered runtime (`claude-code`, `agentx`, `cursor` — availability is
deployment-specific). Both are prepended to the prompt as a `[engine:…,model:…]` directive, so a
prompt that opens with its OWN model group (`[opus] …`) would out-rank the pin — drop it from the
prompt text when pinning. `job` tasks run a command, not an agent, so neither applies.

## Missed windows (`onMissed` / `missedRun`)

If a window elapses with nothing running (deploy, crash, power cut — or the host **suspending**
with the process frozen), the scheduler decides whether to replay it. `onMissed` is settable on
`POST`/`PUT`:

| `onMissed` | Behaviour |
|---|---|
| `run` (default) | Replay the missed window — the pre-existing behaviour. |
| `skip` | Never replay. The window is simply lost. |
| `offer` | Don't auto-fire, but **record** it so a human/agent can run it on demand. |

`skip`/`offer` suppress *unattended replay* generally — including the failed-run re-arm below, not
just a window missed while the process was down. A schedule set to `offer` will not retry itself
after an outage; that is the point of the setting, but it is also how a daily report goes quietly
missing for a day.

```bash
curl -s -X PUT -H "Content-Type: application/json" -H "x-internal-token: $INTERNAL_API_TOKEN" \
  http://localhost:$PORT/api/schedules/{id} -d '{ "onMissed": "offer" }' | jq .
```

- **A staleness ceiling overrides every policy, `run` included**: a window more than
  `SCHEDULER_MAX_MISSED_AGE_MS` (default **6h**) late is never replayed. Finishing an 08:00 report
  at 22:00 is not the job the schedule describes.
- One decision (`judgeMissed` in `scheduler/engine.ts`) governs **all four** paths that could
  replay a window:
  0. **Failed-run re-arm** — the run fired on time but errored *before producing anything* (no
     `tool_use`, no text, no thinking: `sideEffectFree` on the run summary). The work provably
     never started, so the window has not been spent. The engine retries the **same** window on a
     5/15/30/60m backoff — the in-process ladder in `runner.ts` is sub-second, tuned for a flaky
     engine, and an outage (a capped API key, a dead upstream) outlives it. A newer window
     supersedes a pending retry; disable/delete cancels it; success clears it. The re-arm timer is
     in-memory, so boot catch-up re-derives the same condition from `lastRun` and picks it up
     across a restart.
  1. **Boot catch-up** (cron only) — the process was down when the window passed.
  2. **In-place resume** of a run interrupted mid-flight — every trigger kind
     (`interval`/`once`/`event` have no catch-up, so resume is their only gate; their window is
     the one the interrupted run recorded when it started).
  3. **A late timer fire** — the process was *frozen*, not killed (laptop lid/standby, NTP step,
     VM pause): same pid, no restart, so catch-up never ran, and the overdue `setTimeout` fires on
     wake. The window is the schedule's `nextRun` (when it *should* have fired), not the wake time.
     A punctual fire is untouched — `onMissed` is a missed-window policy, never a mute — the gate
     engages only once the fire is past the ceiling.
- After a refusal the schedule is still re-armed normally: an `interval` job loses exactly one
  cycle and fires again next period; a `once` is retired (disabled, `nextRun` cleared) with its
  `missedRun` left for an on-demand run. Nothing is left enabled-but-never-firing.
- Whenever a window is not replayed, the schedule gets
  `missedRun: { at, reason: "skip"|"offer"|"stale", noticedAt }` — visible on
  `GET /api/schedules` and `GET /api/schedules/{id}`. **That is the `offer` affordance**: read it,
  then `POST /api/schedules/{id}/run` to run the missed work on demand. It clears the moment the
  schedule next starts a run.
- `POST /api/schedules/{id}/run` returns **409** `{ error, reason }` when a run can't start
  (`locked` — a run is already in flight, incl. one held across a restart; `already-completed` /
  `already-attempted`). A `404` there really does mean the schedule doesn't exist.

## "What did I miss?" — downtime recovery (`GET /api/downtime`)

This box is deliberately not always-on. The server heartbeats to `data/state/heartbeat.json` every
`HEARTBEAT_INTERVAL_MS` (default **60s**). A gap larger than `DOWNTIME_THRESHOLD_MS` (default
**3 intervals = 3m**) is appended to `data/state/downtime.json` as
`{ from, to, ms, cause, slackCursors? }` (last **20** kept). A clean restart records nothing.

Two `cause`s, one code path:

- **`cause: 'boot'`** — the process died (crash, power cut). The gap is measured at startup, from
  the last persisted heartbeat.
- **`cause: 'suspend'`** — the process never died: the **host slept** (lid closed, standby) and the
  process was *frozen*. Nothing restarts, so a boot check would never see it — instead the next
  heartbeat tick comes back late by more than the threshold and records the gap itself. One entry
  per outage, however long (the tick writes the heartbeat forward before the next one compares).
Two consequences of a `suspend` gap, both flagged in the report's `note`:

- **`missedSchedules[]` is INCOMPLETE, not empty** — the boot-time catch-up scan never ran (nothing
  restarted), so the only records are the ones the **late timer fire** wrote itself (see "Missed
  windows" above: a fire past the ceiling is refused and recorded as `missedRun`, at a timestamp
  *inside* the gap, which the report then joins). Windows still inside the ceiling on wake simply
  ran; anything else that elapsed in the gap left **no record at all** — check those by hand. The
  note is emitted for any suspend in the last `SUSPEND_NOTE_MAX_AGE_MS` (**24h**), not just the
  newest entry: a restart afterwards appends a `boot` entry but rescans nothing.
- **No `slackCursors` snapshot** — the snapshot is only taken on the `boot` path, where it is
  provably older than any post-recovery traffic. A suspend gap is recorded from a heartbeat tick up
  to 60s *after* the wake, by which time the reconnected socket may already have pushed the cursor
  past the whole backlog. So the entry carries none and the backfill floors at the gap's `from` —
  it may re-report a few already-seen messages, never skip unseen ones.

```bash
curl -s -H "x-internal-token: $INTERNAL_API_TOKEN" "http://localhost:$PORT/api/downtime" | jq .
curl -s -H "x-internal-token: $INTERNAL_API_TOKEN" "http://localhost:$PORT/api/downtime?slack=0" | jq .   # skip the Slack read
```

Returns `{ heartbeat, downtime[], lastDowntime, missedSchedules[], slack }`:

- **`missedSchedules[]`** — the `missedRun` records above, joined to the outage that covers them,
  each with a `proposal` string. It does **not** re-derive which windows were missed; the
  scheduler owns that.
- **`slack`** — messages that arrived during the last outage, fetched **on demand only** (never at
  boot) via `conversations.history`, deduped by `client_msg_id`. History, not event replay: Slack's
  Events API retries a dropped delivery for only ~30 minutes then discards it forever, while
  `conversations.history` stays readable for days.
  - **Where it starts:** the outage's `from`, raised only by the last-seen cursor **as
    snapshotted into the downtime entry at boot** (`slackCursors`, `cause: 'boot'` only — a
    `suspend` entry has none, so it starts at `from`). The live cursors in
    `data/state/slack-cursors.json` are a tail pointer — one message after recovery pushes them
    past the whole backlog — so they are never used as the floor.
  - **Which channels:** every channel with a cursor (at the time of the outage or since), plus
    `SLACK_AGENT_CHANNEL` — so a first deploy, or a channel quiet before the outage, is not
    invisible.
  - **`channels[].truncated: true`** means the page cap (5 × 200 per channel) was hit with more
    still waiting. `conversations.history` returns newest-first, so what's missing is the
    **start** of the outage. The report's `note` also says `INCOMPLETE` — treat it as such.

**It reports and proposes — nothing auto-fires.** Acting on an item is always an explicit second
call: `POST /api/schedules/{id}/run` (409 + `reason` if it can't start). Same data is exposed as
the MCP `get_downtime` tool when `MCP_ALL_TOOLS=true`.

## Emitting events (to fire event-triggered schedules)

Any caller that can present shraga auth can push an event onto the bus:

```bash
curl -s -X POST -H "Content-Type: application/json" -H "x-internal-token: $INTERNAL_API_TOKEN" \
  -H "X-Event-Id: optional-dedupe-key" \
  http://localhost:$PORT/api/events/stripe \
  -d '{ "type": "invoice.paid", "data": { "amount": 42 } }' | jq .
```

The `:source` path segment is the event source; the JSON body is the payload. `X-Event-Id` (optional) dedupes retried deliveries for ~5 min.

For **vendor webhooks** that can't send shraga auth (Stripe, GitHub, …), add a data-side extension (`data/extensions/<name>.ext.ts`) that verifies the vendor's own signature, then calls `ctx.emitEvent(source, payload, { id })`. See `defaults/extensions/README.md` and the `stripe-webhook.ext.ts` example.

## Built-in event sources

The system emits these onto the bus automatically — use them as the `source` of an event trigger to react to the agent's own lifecycle:

- **`schedule.finished`** — fired when any time/manual schedule run completes. Payload: `{ scheduleId, name, status, sessionId, sessionUrl?, error? }`. `status` is `ok` | `error` | `aborted` — `aborted` covers both a user cancel and a run killed by a signal (a deploy/restart SIGTERMs in-flight jobs), so alerts matching `error` don't fire on interrupted runs. Chain automations off it, e.g.:
  ```json
  { "trigger": { "kind": "event", "source": "schedule.finished", "match": { "status": "error" } },
    "task": { "kind": "prompt", "prompt": "A scheduled run failed — investigate and post a summary." } }
  ```
  Runs that were *themselves* event-triggered do NOT emit `schedule.finished` — this prevents feedback loops, so you can't chain `schedule.finished` → event run → `schedule.finished` infinitely.

  A `status: error` on a **prompt** run means it failed up to 3 times, not once: a transient failure that produced no output at all (no token, no tool call — so no side effect) is retried with a short backoff before being reported. So `error` is a real failure worth acting on, not a blip. Job (shell command) runs are never retried — a non-zero exit says nothing about what the command already did.

## Throttling event triggers

Event triggers accept an optional `throttle` that suppresses duplicate fires **before** a run is spawned:

```json
{ "trigger": { "kind": "event", "source": "schedule.finished", "match": { "status": "error" },
               "throttle": { "byFields": ["name", "error"], "windowSec": 21600 } } }
```

The dedup key is built from the named payload fields (dot-paths), string-normalized (lowercased, digits→`#`, whitespace-collapsed) so values differing only by timestamps/ids collapse together. A fire is dropped if an identical key fired within `windowSec`. State lives in `data/state/trigger-throttle.json` and self-prunes. Empty `byFields` throttles on the source alone. For throttling inside a `job`/`bash` task (no trigger), use the `data/scripts/notifier-throttle.ts` helper instead.

## Failure notification (built-in)

`builtin-failure-notifier` is a shipped, **disabled-by-default** schedule that reacts to `schedule.finished` / `status:error`, triages the error (credential-expiry / rate-limit / data-issue / generic), and DMs the deployment owner — throttled to one alert per job+error per 6h. To use it:

1. Enable it (toggle the schedule).
2. Optionally set `SHRAGA_ALERT_SLACK_EMAIL` (the legacy `UNCLAW_ALERT_SLACK_EMAIL` is still honoured) (else it falls back to the first `data/whitelist.json` entry).
3. Set `PUBLIC_ORIGIN` (or `publicOrigin` in the data-dir config) so the alert can link to the failed run's session. It is the only source of a publicly-reachable origin — a scheduled run has no request to derive one from. Unset, the `sessionUrl` payload field is absent and the alert omits the link rather than emitting an unreachable `localhost` one.
4. Optionally edit its `task.prompt` to add deployment specifics (recipients, runbook links, severity rules) — your edits to a builtin's prompt and `enabled` flag survive upgrades; only `name`/`scope`/`createdBy` reconcile from code. Because `task.prompt` is deliberately *not* reconciled, the alert's session link is supplied through the event payload (`sessionUrl`) instead, so it reaches deployments that already persisted the schedule.

## Notes

- Event triggers never fire on a timer — they have no `nextRun` and wait for the bus. Per-trigger fires serialize (queue cap 5).
- System schedules (`scope: "system"`) are read-only — you can toggle them but not edit/delete.
- User schedules are scoped to their creator.
- Schedules only execute on the instance where `DATA_SYNC_SCHEDULER_ACTIVE=true`.
- `once` schedules auto-delete after completing — they don't linger in the list.
- Always list schedules first to show the user what exists before making changes.
