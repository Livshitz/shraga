# The shared brain: a teammate that compounds

> _Status: pre-release. This is the north-star idea behind Shraga. The mechanisms that realize it
> open in stages; the direction is stable._

Most tools are worth the same on day 1000 as on day 1. A **teammate** isn't. The longer a good
colleague is around, the more they know: your systems, your conventions, who owns what, why that
weird thing is the way it is. Shraga is built to accumulate that the same way, and then to **share
it across the whole org**.

## Onboarding, not installation

You don't "install" a teammate; you **onboard** one. Shraga is meant to start the way a new hire
does:

- It **meets the key players** (virtually): learns who owns which surface, who to ask about what.
- It **learns the context**: the systems, the repos, the conventions, the house style, the
  "we do it this way here."
- It gets **guided and corrected**, and unlike a doc that goes stale, it keeps what it learns.

Onboarding isn't a one-time setup step; it's the first deposit into something that keeps growing.

## Every interaction enriches the brain

Here's the compounding part. Each time someone works with Shraga (delegates a task, corrects an
approach, aligns it on a preference, teaches it a workflow), that interaction doesn't evaporate when
the session ends. It's **captured** into a shared, org-wide knowledge base: a mega-brain the whole
team feeds and the whole team draws from.

```
  person A guides Shraga on deploys ─┐
  person B aligns it on code style  ─┤
  person C teaches it the billing flow ─┼──▶  shared org brain  ──▶  every team benefits
  person D corrects a wrong assumption ─┘        (practices, conventions,
                                                   tribal knowledge, how-we-do-X)
```

The knowledge that normally lives in one senior engineer's head (and leaves when they do) gets
**captured once and made available to everyone**. Team B benefits from what Team A taught it last
month, without a meeting, a wiki page nobody reads, or a Slack archaeology session.

This is a **flywheel**: the more people use it, the smarter it gets; the smarter it gets, the more
worth using. Value grows with tenure, like a long-serving colleague: that's the moat.

## It's *your* brain: scoped and owned

A shared brain only works if it's trusted, so this is load-bearing: the mega-brain is **your org's**,
living on **your** infrastructure under Shraga's **own identity** (see [concept](./concept.md): own
machine, own keys). It is not a vendor harvesting your team's know-how into someone else's product.

Sharing is *within your walls*, with boundaries: knowledge is scoped, not a free-for-all where
everyone sees everything. The default is "your team's collective memory, on your terms," not
"broadcast." (The exact scoping model is part of what hardens during early access.)

## It augments, it doesn't replace

Say the quiet part plainly: **Shraga is not here to replace anyone.** It's here to kill the *waste*
around delegation: the context you re-explain for the tenth time, the handoff that stalls because
the one person who knows is asleep, the small tasks that fragment a maker's day.

The point is **leverage**: you delegate the well-understood work smartly, the shared brain makes
that delegation cheaper every week, and people spend their hours on the parts that actually need a
human. More gets done; less gets wasted. A team with Shraga isn't a smaller team; it's the same
people with a colleague who never forgets and never gatekeeps what it knows.

## How this shows up in the system

This north star is realized through the [primitives](./architecture/primitives.md), not magic:

- **Skills** capture "how we do X here" as reusable, shareable units: the deposits become durable.
- **Sessions** keep the history and context of the work, so nothing has to be re-explained.
- **The workspace** is shared ground the team and Shraga stand on together.
- **Its own identity** (own machine/keys) is what makes a *shared* org brain safe to have at all.

## Where to go next

- The core shift this rests on → [Concept](./concept.md)
- The parts that make it real → [Primitives](./architecture/primitives.md)
