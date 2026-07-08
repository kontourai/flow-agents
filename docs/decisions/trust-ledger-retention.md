---
status: needs-decision
subject: Trust-ledger retention and console-as-projection
decided: 2026-07-07
evidence:
  - kind: adr
    ref: docs/adr/0017-anti-gaming-trust-security-model.md
  - kind: adr
    ref: docs/adr/0020-trust-reconcile-manifest-and-claim-classification.md
  - kind: adr
    ref: docs/adr/0022-fail-closed-delivery-reconciliation-with-governed-exemptions.md
  - kind: doc
    ref: docs/implementing-trust-reconciliation.md
  - kind: issue
    ref: kontourai/console#118
  - kind: issue
    ref: kontourai/console#125
  - kind: issue
    ref: kontourai/flow-agents#463
  - kind: issue
    ref: kontourai/flow-agents#73
---
# Trust-ledger retention and console-as-projection

> Status: **needs-decision** (proposed direction (shaped with Brian Anderson, 2026-07-07). Not yet
> fully built. Ratify + carry forward as ADR on implementation.

**Decision.** Git is the **authoritative store** for trust bundles and delivery
records; the Console (and any hosted DB projection) is a **rebuildable, queryable
projection** over them, never the source of truth. Three rules follow:

1. **Two stores, two retention tiers.** The authoritative bundle is committed
   (`delivery/<slug>/trust.bundle` + checkpoint) and pinned to the merge commit —
   permanent, distributed, surviving any console outage. The console DB keeps a
   projection: **coarse audit records** (bundles, decisions, gate/claim outcomes)
   retained long; the **fine-grained raw telemetry firehose** kept for a short
   window and rolled up into aggregates. Retention in the projection is a **cost**
   decision, not a **correctness** one.

2. **"Needs attention" is a view-filter, never a delete-sweep.** An item leaves
   the operational attention set when it reaches a terminal state or ages past a
   recency cutoff — the underlying record is retained, it just stops surfacing as
   actionable. Deleting audit history to quiet a dashboard is a category error.

3. **The gate fires at PR time; post-merge the bundle is an audit record.** A
   bundle seals to the work-commit and tolerates lag (the ancestor check + fresh
   CI re-run absorb later commits); it is not regenerated per push. After a
   (squash) merge it rides into the merge commit as a committed file and becomes
   provenance, not enforcement. See `docs/implementing-trust-reconciliation.md`.

**Rationale.** "Console isn't the source of truth" is the *enabling* property, not
a caveat: because git holds the authority, the projection is free to be pruned,
tiered, or rebuilt for cost/perf without losing anything. This dissolves the
tension between "keep an auditable delivery history" and "don't let a dashboard
fill with days-old noise" — they are different concerns (retention vs. attention)
that were previously conflated in one store. Observed data motivates the tiering:
in one live snapshot the coarse audit table held ~38 rows while the raw
telemetry-event table held ~30,000 — bundles are not what grows; the event stream
is.

**A "stale" bundle is a presentation problem, not a data problem.** A bundle is an
immutable dated receipt ("verified this way at commit X"); it never becomes
*wrong*, only misleading if surfaced as *current* truth. The query layer answers
"true now?" from latest-state-per-subject and "true at commit X?" from the bundle.

**Consequences / what to build.**

- **Reframe the console "janitor" ([console#125]) from reaper to attention
  view-filter**: terminal-state + recency cutoff over the operating-state
  projection, with no deletion of underlying events. (Today the gap is
  structural: there is no terminal-close/expiry event type, so nothing ever
  leaves the active set — a process that stops emitting without a terminal status
  flags as "long-running / needs attention" forever.)
- **Make the projection genuinely rebuildable** ([flow-agents#463],
  [flow-agents#73]): add a backfill/import that re-hydrates the console from the
  committed `delivery/*/trust.bundle` files across repos. Until this exists, "the
  DB is just a cache of git" is false in practice — a wipe/restart loses
  queryability until producers re-push (observed 2026-07-07: a hosted-DB wipe
  required a manual service restart and had no re-hydration path).
- **Add retention + rollup for raw telemetry** (relates to the console noise
  cleanup, [flow-agents#7-equivalent]): keep raw events N days, keep aggregates
  long.
- **Trust-bundle registry** ([console#118]) is the research home for org-scoped
  retention, sharing, and third-party verification of the ledger.

**Non-goals.** This decision does not change the layered-defense posture of ADR
0017/0020/0022, the PR-time gate semantics, or claim classification. It adds the
retention/projection design layer on top.
