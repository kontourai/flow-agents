---
status: needs-decision
subject: Trust-reconcile and delivery reconciliation
decided: 2026-07-03
evidence:
  - kind: adr
    ref: docs/adr/0020-trust-reconcile-manifest-and-claim-classification.md
  - kind: adr
    ref: docs/adr/0022-fail-closed-delivery-reconciliation-with-governed-exemptions.md
---
# Trust-reconcile and delivery reconciliation

This subject has provenance in frozen ADR history ([0020-trust-reconcile-manifest-and-claim-classification.md](../adr/0020-trust-reconcile-manifest-and-claim-classification.md), [0022-fail-closed-delivery-reconciliation-with-governed-exemptions.md](../adr/0022-fail-closed-delivery-reconciliation-with-governed-exemptions.md)) but no living
decision has been ratified yet under the topic-keyed decision registry
(`context/contracts/decision-registry-contract.md`). This stub records that the
subject is open and links the frozen ADR(s) as provenance; it is not a decision.

When a living decision is ratified for Trust-reconcile and delivery reconciliation, update this
file's `status` to `current`, add rationale, and keep the `adr` evidence
links as provenance for the history that led here.

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
