# Primitives

> _Status: pre-release. These are the durable nouns of the system. Names and shapes may refine as
> the source opens; the roles they play are stable._

Shraga is a small set of primitives that compose. Learn these seven and you understand the system.
Everything else is a detail hanging off one of them.

---

## 1. Session

A **session** is one line of work with the agent: a conversation and its history. It's the thing
you forward a task *into*, and the thing you come back *to*.

- **Durable & addressable.** A session has an id; you can leave it and return, on any device.
- **Forkable.** Branch a session to explore an alternative without losing the trunk.
- **Portable, not machine-bound.** The session lives on the host, not in your terminal; that's
  what makes "close the lid and check back" work.

Sessions are the delegation unit from [the concept](../concept.md): a handoff creates or continues
one.

## 2. Skill

A **skill** is a packaged capability the agent can reach for: a named, documented unit of "how to
do X here." Skills are how you teach Shraga the shape of *your* work without hardcoding it.

- **Progressive disclosure.** A skill leads with a short description of *what* it does and *when* to
  use it; the agent pulls in the detail only when it commits to using it. Cheap to scan, deep on
  demand.
- **Composable.** Skills reference each other; the agent assembles them per task.

## 3. Runtime

The **runtime** is the actual coding agent underneath: Claude Code, Cursor, or another. Shraga
treats it as a swappable engine behind a stable surface. You **bring your own**; Shraga drives it.

This is a first-class primitive precisely because it's *not* baked in: the abstraction keeps a
stable surface over the runtime, though it's leaky in places today.

## 4. MCP connection

**MCP** (Model Context Protocol) is how Shraga gives a runtime hands: tools and data sources it can
call: your services, APIs, files, integrations. An MCP connection is a typed capability wired into
a session's runtime.

- **Two directions.** Shraga can *consume* MCP servers (giving the agent tools) and *expose* one
  (letting other clients drive Shraga as a tool).
- **Scoped.** Connections resolve globally and per-user, so a shared backend can still give
  different people different reach.

## 5. Extension

An **extension** is a drop-in unit of custom server behavior (a route, a webhook receiver, an
integration callback) added per deployment **without forking the core**. It's the sanctioned seam
for "make this instance do a thing the base doesn't."

- **Additive.** Extensions load alongside the core, not into it; your customizations survive
  upgrades.
- **The escape hatch that keeps the core clean.** Instead of patching Shraga, you extend it.

## 6. Schedule & Event

Delegation isn't only "a human forwards a task." Work can also be **triggered**:

- A **schedule** runs a task on a cadence (cron-style): the standing instructions your teammate
  handles without being asked.
- An **event** fires a task in response to something happening: an inbound webhook, a signal, a
  message. External sources publish onto an event bus; matching subscriptions run.

Both funnel into the *same* task execution as a manual handoff. A scheduled run, an event-triggered
run, and a "forward it" run are the same machinery with different front doors; that uniformity is
the point.

## 7. Workspace

The **workspace** is the shared environment the agent works in, including a real shared terminal
(PTY) that the web surface and a physically attached shell both see. It's the ground the agent
stands on: files, processes, a live shell, shared across the people and devices pointed at one
Shraga.

- **Shared, not per-request.** Multiple viewers observe the same live workspace/terminal.
- **Real, not simulated.** It's an actual shell and filesystem, so the agent's work is inspectable
  and joinable, not a black box.

---

## How they compose

A typical delegation touches most of them:

```
  handoff ─▶ Session ─▶ (Skills guide) ─▶ Runtime ─▶ MCP tools
     ▲                                      │
  Schedule / Event                          ▼
  (non-human front doors)              Workspace (shared shell + files)
                                            │
  Extensions add new front doors ───────────┘  (routes / webhooks per deployment)
```

- A **handoff** (human, **schedule**, or **event**) opens/continues a **session**.
- **Skills** shape how the **runtime** approaches the task.
- The runtime reaches out through **MCP** connections and acts inside the **workspace**.
- **Extensions** let a given deployment add front doors and integrations without touching the core.

## Where to go next

- The core shift these serve → [Concept](../concept.md)
- What they build toward → [The shared brain](../shared-brain.md)
