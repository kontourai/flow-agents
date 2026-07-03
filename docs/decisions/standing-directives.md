---
status: current
subject: Standing directives
decided: 2026-07-03
evidence:
  - kind: issue
    ref: https://github.com/kontourai/flow-agents/issues/348
  - kind: pr
    ref: https://github.com/kontourai/datum/pull/3
  - kind: pr
    ref: https://github.com/kontourai/flow-agents/pull/344
  - kind: issue
    ref: https://github.com/kontourai/flow-agents/issues/347
  - kind: issue
    ref: https://github.com/kontourai/surface/issues/110
  - kind: pr
    ref: https://github.com/kontourai/surface/pull/113
  - kind: doc
    ref: docs/repository-structure.md
---

# Standing directives

Ratified owner directives get a durable, quotable home at
`context/contracts/standing-directives.md` instead of living only in the
ephemeral context of whichever orchestrator session ratified them.

## Decision

- `context/contracts/standing-directives.md` holds a short, numbered list of
  owner-ratified directives, each with a one-line rationale and the date it
  was ratified.
- Every other file under `context/contracts/` carries a one-line pointer in
  its header area to `standing-directives.md`, so any agent that loads a
  phase contract also receives the standing directives regardless of which
  task in a plan it was delegated.
- A standing directive overrides default engineering conservatism (e.g.
  keeping a compatibility path reachable "just in case") wherever it applies.
  An agent that believes a directive does not fit a situation stops and
  reports the conflict rather than silently choosing a side.
- The seeded July 2026 directives: no legacy fallbacks (migrate hard, loud
  typed error naming the regeneration command); durable-vs-runtime path
  convention (`.kontourai/` is gitignored runtime state, `.<product>/` is a
  product's durable committed directory); evidence must be executable;
  standalone-first then integrate; and the regression rule for cutovers
  (large regressions are surfaced as an explicit owner decision with data,
  never papered over, but do not block the cutover by default).

## Rationale

A delegated agent working one slice of a plan only sees the task prompt it
was given. If a ratified correction — such as "no legacy fallbacks" — lives
only in the orchestrator's context from the session that ratified it, the
delegate never receives it and can reintroduce the exact behavior the owner
already corrected. Wiring a pointer into every contract header makes receipt
structural rather than dependent on the orchestrator remembering to restate
the correction in every task prompt.

The individual directives are evidenced by hard-cutover precedent
([datum#3](https://github.com/kontourai/datum/pull/3)), the fallback-removal
follow-up to [flow-agents#344](https://github.com/kontourai/flow-agents/pull/344)
tracked as [flow-agents#347](https://github.com/kontourai/flow-agents/issues/347),
and the durable-vs-runtime path convention already documented in
[docs/repository-structure.md](../repository-structure.md) and applied in
[surface#110](https://github.com/kontourai/surface/issues/110) /
[surface#113](https://github.com/kontourai/surface/pull/113).
