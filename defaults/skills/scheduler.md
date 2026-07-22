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

Task:
  { kind: "prompt", prompt: "<text>" }
  { kind: "bash", command: "<cmd>" }

Schedule: { id, name, enabled, trigger, task, scope, createdBy, nextRun?, lastRun?, runCount }
```

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

- **`schedule.finished`** — fired when any time/manual schedule run completes. Payload: `{ scheduleId, name, status, sessionId, sessionUrl?, error? }`. `status` is `ok` | `error` | `aborted`. Chain automations off it, e.g.:
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
