---
status: current
subject: Trust-reconcile and delivery reconciliation
decided: 2026-07-04
evidence:
  - kind: adr
    ref: docs/adr/0020-trust-reconcile-manifest-and-claim-classification.md
  - kind: adr
    ref: docs/adr/0022-fail-closed-delivery-reconciliation-with-governed-exemptions.md
  - kind: doc
    ref: docs/coordination-guide.md
---
# Trust-reconcile and delivery reconciliation

**Decision.** Delivery is **fail-closed with governed exemptions**. `publishDelivery()` passes a
bundle through three distinct, type-discriminated tiers — fail-soft (absent bundle tolerated) →
shape gate (`InvalidBundleShapeError`, #356) → hold gate (`NotFreshHolderError`, #293) — and CI's
reconcile is fail-closed by default (`onUnderivable: 'fail'`). A local `reconcile-preflight`
mirrors CI's shape check via the *shared* `scripts/lib/reconcile-shape.js` so the two cannot
drift. Concurrent deliveries are isolated by **per-session paths** (`delivery/<slug>/`, #379), and
a checkpoint's `commit_sha` must be an ancestor of HEAD (seal-at-parent) so a stale bundle can't be
replayed onto a moved branch. See the [coordination guide](../coordination-guide.md#how-delivery-itself-is-made-tamper-resistant).

**Rationale.** The default must be safe: an underivable status fails the run rather than passing
it, and a hard block on the shared publish path is applied only on high-confidence signals so it
never false-blocks legitimate work. The frozen ADRs ([0020](../adr/0020-trust-reconcile-manifest-and-claim-classification.md),
[0022](../adr/0022-fail-closed-delivery-reconciliation-with-governed-exemptions.md)) hold the
immutable rationale.

## Implementation note (#356, iteration 1)

A local, pre-push `reconcile-preflight` now exists (`workflow-sidecar reconcile-preflight
<artifact-dir>`), reusing — never forking — the shape-classification logic CI's
`scripts/ci/trust-reconcile.js` enforces via the shared `scripts/lib/reconcile-shape.js`
module. `publishDelivery()` is itself fail-closed on shape-invalidity: it calls the same
preflight before copying anything into `delivery/`, and refuses to publish a bundle that
fails the shape check.

The reduced-coverage degradation (trusting a session-local claim's self-reported status when
CI-side re-derivation is unavailable) is a **LOCAL-preflight-only** opt-in
(`sessionLocalShapeIssues(..., { onUnderivable: 'reduce' })`). CI's `trust-reconcile.js`
always calls the shared function with `{ onUnderivable: 'fail' }` (also the function's
default when no mode is given) and remains fail-closed: when status re-derivation is
unavailable, every session-local pass-asserting claim becomes a `status-underivable`
divergence and the run fails, exactly as before the shape logic was extracted.

## Implementation note (#379, per-session delivery paths)

Concurrent deliveries no longer contend on a shared `delivery/trust.bundle`. Each session writes
its bundle under `delivery/<slug>/`; CI selects prefer-newest. Publishing must **restore sibling
`delivery/<slug>/` directories** from `origin/main` before committing — after a soft-reset,
`git add -A` would otherwise stage the deletion of other sessions' delivery dirs that the branch
predates. This is the standard step in the publish sequence documented in the coordination guide.
