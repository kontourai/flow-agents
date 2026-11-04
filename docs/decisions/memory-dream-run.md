---
status: current
subject: Memory dream run
decided: 2026-11-03
evidence:
  - kind: issue
    ref: https://github.com/kontourai/flow-agents/issues/671
  - kind: doc
    ref: kits/knowledge/docs/dream.md
  - kind: doc
    ref: docs/decisions/memory-claim-routing.md
---

# Memory dream run

## Decision

The distillation "dream" job is a callable flow that a host invokes. It is not a
scheduled job of this repository.

- **No scheduler of its own.** This repository ships no Boo job, launchd job, cron entry
  or standing daemon for the dream. A host scheduler invokes `runDream` or
  `dream/cli.js`; Station's scheduler is the hosted path
  ([station#4484](https://github.com/kontourai/station/issues/4484)). A product loop
  rides existing hooks, detached and best-effort, instead of a daemon.
- **An opt-in hook trigger.** `dream/hook-trigger.js` starts a detached run from
  `SessionEnd` or `PreCompact`. It is inert unless the operator sets
  `FLOW_AGENTS_DREAM_TRIGGER=1` and names an enabled config. The run takes a lock.
- **Disabled by default.** The config's `enabled` is false until the operator sets it,
  the library refuses a real run without it, and a dry run is read-only.
- **The run only proposes.** Distilled claims are staged as Corpus create proposals,
  recorded as `proposed` or `routed` by the #1571 policy. The run has no code path that
  applies a proposal, and a proposal the distiller approved does not count. Only a
  reviewer other than the proposer promotes a claim; routed review is how that happens.
- **Unreviewed claims are quarantined from the brief.** The brief contains applied
  claims. An operator may opt in to uncontested pending claims, which are labelled
  unreviewed. A claim routed to review waits for the review.
- **Only current, uncontested claims are ranked.** A claim a rival in its slot contradicts
  waits in the review queue, not the brief; a replaced, retracted or hypothetical claim is not
  current. The slot rules are #1571's routing rules, applied locally until Surface's accumulation
  projection ([surface#359](https://github.com/kontourai/surface/pull/359)) is published and
  consumable ([#1584](https://github.com/kontourai/flow-agents/issues/1584)).
- **The cursor is committed last.** It is the run's only progress state. Corpus
  proposals are its receipts, reconciled by claim id.
- **Model calls go through Relay.** A Datum role, routed by Dispatch, over a Relay
  `ModelRuntime`. The run imports no provider SDK.

## Consequences

- `@kontourai/monument` owns crash-safe effects (idempotency keys, dedup,
  record-before-effect, owner liveness) and is not published, so this repository keeps a
  cursor and Corpus proposals and builds no durability layer beyond them. Adopting
  Monument later makes this repository its first consumer outside Station.
- Corpus keys a create request by the sitting and the candidate's place in the batch
  (#1573) and refuses a different candidate at a taken key, and the model is not
  deterministic, so every proposal of a sitting carries the sitting's whole plan. A retry
  reads the plan back from the store and creates only what is missing, with no new model
  call. A claim already proposed is never sent again, so nothing about it (its provenance,
  its routing) can conflict. Each claim sent says where it sits in the whole plan, through
  an optional `positions` argument to `promote/store-target.js`, and the dream passes the
  plan's digest as an optional `requestScope`, so a changed plan for the same sitting takes
  its own keys. Both are additive: absent, the bridge's keys are unchanged. A receipt that
  does not verify stops the run instead of being skipped.
- Gate evaluation belongs to the host's Flow run. The dream declares the gates and calls
  `onStage` at each boundary; it does not evaluate them.
- Brief budgets (6144 bytes global, 2048 per project) and the ranking rule are defaults
  an owner may change. They are not ratified here.
