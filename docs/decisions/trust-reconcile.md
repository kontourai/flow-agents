---
status: current
subject: Trust-reconcile and delivery reconciliation
decided: 2026-07-29
evidence:
  - kind: issue
    ref: https://github.com/kontourai/flow-agents/issues/1094
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

## Merge-readiness is an attestation, not a claim (2026-07-29, #1094)

**Decision.** Work is merge-ready when a **signed attestation exists whose subject digest matches
this commit's trust bundle and whose predicate records `reconciled`**. Not when someone says the
gate passed — when the gate's own signature says so.

The machinery for this already existed and was going to waste. `scripts/ci/mint-attestation.js`
signs an in-toto v1 statement over `delivery/trust.bundle`'s sha256 via Sigstore keyless (Fulcio +
Rekor), with predicate `{commit_sha, canonical_commands, reconciled, built_at}` — then uploads it
as a build artifact that **nothing consumes**. The unfakeable object expired while the fakeable one
(a self-asserted claim) was what travelled onward. Making the attestation the gate's *output*
rather than its byproduct closes that, and costs no new cryptography.

**Provenance tiers.** Every delivery sits at exactly one, and the tier is a fact about evidence,
never a description of intent:

| tier | means | available |
| --- | --- | --- |
| `self-asserted` | a claim with no signature and no binding to content | always, and worth little |
| `self-attested` | signed locally over the bundle digest, carrying `commit_sha` + `canonical_commands` | now, at zero cost — a local signing identity already exists |
| `independently-verified` | a second party re-ran canonical verification and signed the result | wherever CI runs |

`derive-claim-status.mjs` already refuses to trust a bundle's self-reported `claim.status` and
re-derives it from the bundle's own evidence. The tiers extend that posture from a claim's *status*
to a delivery's *provenance*: in both cases the assertion is not the evidence.

**Exemptions become the explicitly-unattested path.** `delivery/DECLARED` stays — a fail-closed
gate with no relief valve gets bypassed in worse ways — but an exemption is now understood as
recording `self-asserted`, not as an equivalent to passing. It should be countable and visible
after merge rather than invisible once merged, which is the property it lacks today.

**Rationale.** A self-asserted approval is the same defect as a fabricated receipt, one layer up:
unverifiable by anyone, indistinguishable from an earned one. The tier does not make dishonesty
impossible — anyone holding a token can still assert — but it makes an assertion unable to wear an
authority trace it did not earn.

**Repo-dependent, deliberately.** Requiring `independently-verified` everywhere would block private
repos whose CI is off for cost reasons. The tier is the design that survives both states: a repo
with free CI (public) can require the top tier today; one without sits at `self-attested` and its
records say so. Nothing about the model changes when CI resumes — the top tier simply starts being
reachable. Console renders the same tier the gate enforces, so the read surface is a view of the
gate's evidence rather than a second, softer judgement
(see [console-record-delivery](./console-record-delivery.md)).

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
