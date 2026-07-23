---
status: current
subject: Survey evidence for paused Flow gates
decided: 2026-07-22
evidence:
  - kind: issue
    ref: https://github.com/kontourai/flow-agents/issues/851
  - kind: issue
    ref: https://github.com/kontourai/flow-agents/issues/821
  - kind: issue
    ref: https://github.com/kontourai/flow/issues/169
---

# Survey evidence for paused Flow gates

## Decision

Flow Agents provides a library adapter for a host that has a server-owned Survey
review session and needs to continue an already-paused Flow gate. The host
configures a review-session resolver capability separately from continuation
requests. A request carries only an opaque review-session reference; the
resolver returns the persisted record, append-only events, current server state,
and canonical Survey projection. The adapter derives the review result,
validates the projection's Flow subject and current-gate bindings, and builds
Survey's ordinary trust bundle.

The adapter does not accept caller-authored review state, events, projection, or
decision as authority. It
also does not define a new gate, evaluate a gate itself, or imply lifecycle
authority from a review result. The caller supplies an exact Flow run head and
an explicit resume authority; Flow performs the one atomic evidence
attachment, evaluation, and pass-only resume transaction.

For the reverse direction, Flow Agents discovers review work only from a
persisted blocking outcome at the current gate and an exact Flow Run head. The
host must explicitly identify which missing expectation ids are handled by a
Survey producer; the adapter does not infer human-review semantics from claim
type names. A discovery request carries the expectation selector and immutable
run, gate, and expectation correlation, but no candidates.

The configured producer creates the canonical Survey `ReviewItem`, including
its candidates and provenance. Flow Agents validates every candidate's claim
target against the persisted expectation, adds adapter-owned correlation
annotations, and can publish the result through a host-owned queue capability
using a deterministic idempotency key. It never fabricates a current or
proposed value from a gate description or `explore_hint`.

## Consequences

- A rejected, incomplete, stale, foreign, or mismatched review cannot change
  the Flow run or its evidence manifest.
- A non-passing canonical review remains inspectable through the returned
  Survey decisions and Flow outcome, while Flow keeps the paused run unchanged.
- Native or in-process hosts call the same provider-neutral library API. This
  decision does not select a model runtime or transport.
- Queue storage, ReviewItem construction, and review-session persistence remain
  host or producer capabilities. Flow Agents owns only discovery, validation,
  workflow correlation, and composition with the continuation adapter.
