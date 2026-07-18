# Concept: forward it to Shraga

> _Status: pre-release. This describes the model, not a frozen API. Concepts hold; details evolve._

## The name

Shraga is the colleague you forward things to. The one where the answer to "who's handling this?"
is just "send it to Shraga." That's the whole product thesis in a name: **a teammate you delegate
to**, not a tool you operate.

## The shift: operate → delegate

Coding agents today are things you **sit in front of**. You open a terminal, you drive, you watch
tokens stream, you stay in the loop because the loop is the interface. That's powerful, and it's
also a leash: the work is bound to your one machine, your one session, your attention held open.

Shraga moves the agent from something you **operate** to something you **delegate to**. The unit of
interaction isn't a keystroke; it's a **handoff**. You describe what you want, forward it, and walk
away. The work runs on a machine you own; you check back when it matters.

Four things fall out of that shift:

1. **It's reachable, not local.** You forward from your phone on the train, a browser at a client's
   desk, a second laptop. The agent doesn't live in your terminal; it lives on a host, and you
   reach it from wherever you are.
2. **It's a team surface, not a single seat.** More than one person can hand work to the same
   backend. Shraga is multi-user by construction, not a personal CLI with logins bolted on.
3. **It's asynchronous by default.** You kick something off and close the lid. Long-running work
   keeps going; results wait for you. Delegation only means something if you don't have to babysit.
4. **It has its own identity.** A real teammate doesn't borrow your laptop and your logins; they
   have their own. So does Shraga: its own machine, its own keys, its own accounts. You *onboard*
   it once (you own and provision the box, that's what self-hosted means), and from then on it
   operates as a separate identity, not by wearing your personal credentials. That's cleaner as a
   mental model **and** as security: your keys aren't sprayed across every task; Shraga's blast
   radius is Shraga's.

## What Shraga is

A **self-hosted runner** that puts a clean, multi-user surface in front of a coding agent and lets
you delegate to it from anywhere. It owns the *around-the-agent* concerns: who can talk to it,
where sessions live, how tasks get scheduled or triggered, how a shared workspace is shared, so the
agent itself stays swappable.

## What Shraga is not

- **Not a model or an agent.** It doesn't replace Claude Code, Cursor, or any runtime; it
  **drives** whichever one you bring.
- **Not a hosted SaaS you rent.** It runs on a box *you* own and provision, but as its own
  environment and identity, with its own keys, not by piping your work through someone else's
  servers.
- **Not another chat window.** Chat is one way in. The point is the handoff (via UI, schedule,
  event, or API) and what happens after you've stopped watching.

## The mental model

Think of Shraga as a **desk you drop work on**, backed by a worker that never has to be watched:

```
   you (any device)                Shraga (its own machine + keys)
   ─────────────────               ──────────────────────────────
   forward a task  ───────────▶    accept · route · run  ───▶  your runtime
   close the lid                   keep running (async)         (Claude Code, Cursor, …)
   check back later ◀───────────   results, artifacts, logs
```

The rest of the docs zoom into that middle box: the [primitives](./architecture/primitives.md) that
make "accept · route · run" work, the architecture that holds them,
and the principles that decide the trade-offs.

## Where to go next

- The north star this builds toward? → [The shared brain](./shared-brain.md)
- Want the moving parts? → [Primitives](./architecture/primitives.md)
