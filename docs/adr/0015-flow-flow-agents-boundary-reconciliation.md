---
title: "ADR 0015: Flow / Flow Agents Boundary Reconciliation"
---

# ADR 0015: Flow / Flow Agents Boundary Reconciliation

**Date:** 2026-06-25
**Status:** Accepted. Tier 0 (#175) shipped; Tiers 1 (#176) & 2 (#177) closed-by-evaluation (not engine forks — see Reassessment); #178/#179 are deferred cross-package work.
**Parent issue:** #174 (umbrella)

---

## Context

ADR 0001 established that Flow Agents *consumes* Flow for generic workflow enforcement
rather than owning the enforcement kernel. The boundary is owned by ADR 0001. During
Phase 4 of ADR 0010 (trust.bundle as sole verification artifact), a drift was found:
`src/cli/workflow-sidecar.ts` contained a bespoke trust-bundle schema validator
(`tryLoadHachureValidator` / `getHachureValidator` / local `validateTrustBundle`) that
duplicated logic already owned canonically by `@kontourai/surface`.

Surface's `validateTrustBundle` is the canonical owner at the lowest code layer:
hachure owns the schemas, surface owns the trust computation (including validation),
flow owns the workflow engine, flow-agents owns product adapters. The bespoke validator
was a THREE-WAY duplication of that ownership:

1. Hachure's `trust-bundle.schema.json` (the schema source of truth)
2. Surface's `validateTrustBundle` (the canonical validator, using those schemas)
3. Flow Agents' bespoke AJV + hachure-schema-loading validator (the drift)

A survey of flow-agents found that flow-agents uses approximately 1 of ~95 flow exports
(the workflow engine / gate-expectation / run-state kernel). A parallel run-state / gate
model is being reconciled through a tiered program (see below).

## Decision

### Layered ownership

```
hachure         — schemas (trust-bundle.schema.json, claim, evidence, policy, event)
surface         — trust computation: validateTrustBundle, deriveClaimStatus, resolveInquiry
flow            — workflow engine: Flow Definitions, Runs, steps, gates, transitions
flow-agents     — product/adapters: skills, hooks, sidecar writers, runtime adapters
```

Flow-agents does not own trust-bundle schema validation. Surface owns it.

### Tier 0 (this PR): consume surface's validateTrustBundle

Replaced the bespoke `tryLoadHachureValidator` / `getHachureValidator` / local
`validateTrustBundle` in `src/cli/workflow-sidecar.ts` with consumption of
`@kontourai/surface`'s canonical `validateTrustBundle`.

**Equivalence verified before swap:** surface's validator is equivalent-or-stronger than
the bespoke one — it validates the same structural constraints (required fields,
enum values, schema shape) plus cross-reference integrity (evidence → claim, event →
claim, event → evidence) that the hachure JSON schema did not enforce. All nine
test cases agreed; surface rejected two additional invalid bundles (dangling references)
that the bespoke validator accepted.

**Return shape preserved:** the public export `validateTrustBundle(bundle) →
{ valid, errors, available }` is preserved. `available` reflects surface presence (surface
is required per ADR 0010 Phase 4c; fail-open is maintained for diagnostic use). The
function became `async` because surface is ESM-only and loaded via `import()`; the call
site in `writeTrustBundle` is already async; the test inline script uses top-level await
in ES module mode.

**AJV decision:** AJV and hachure schema loading are retained for `validateInquiryRecord`
(which validates inquiry-record.schema.json — a separate schema not covered by surface's
`validateTrustBundle`). Only the trust-bundle AJV duplication was removed.

**normalizeSurfaceRefs advisory validation:** the inline advisory validation in
`normalizeSurfaceRefs` (which validates referenced trust.bundle files) was updated to use
the cached `_surfaceModule` instead of the bespoke `getHachureValidator`. Fail-open
behavior is preserved: if surface is not yet loaded when `normalizeSurfaceRefs` runs,
validation is skipped.

### Tiered reconciliation program (post Tier 0)

The broader boundary reconciliation (issue #174) is phased:

| Tier | Issue | Scope | Outcome |
| --- | --- | --- | --- |
| Tier 0 | #175 | consume surface's `validateTrustBundle`; delete bespoke validator | **DONE** — the one genuine fork removed |
| Tier 1 | #176 | gate-expectation engine: consume flow's gate evaluation kernel | **CLOSED by evaluation** — the gate already consumes Surface (`deriveClaimStatus`) for re-derivation; residual logic is product-specific gate policy. Scoping it found+fixed a real anti-gaming regression (PR #196). |
| Tier 2 | #177 | run-state kernel: consume flow's run-state transition semantics | **CLOSED by evaluation** — `state.json` is a product-specific lifecycle (11-phase builder enum, 13 statuses, no FlowDefinition), not a fork of flow's definition-driven run engine. Adoption = pure churn, zero engine logic removed. |
| promotes | #178 | promote liveness / InquiryRecord / run-hook upstream | **Deferred — cross-package** (requires `flow`/`surface` source changes; not doable from this repo). |
| contracts | #179 | extract generic vocabulary to flow contracts | **Deferred — cross-package.** |

### Reassessment (post Tiers 1–2)

Evaluating Tiers 1 and 2 with the same rigor as Tier 0 showed the original audit **overstated the "drift."** flow-agents already consumes the canonical engines where it matters — Surface for trust computation (`deriveClaimStatus`/`validateTrustBundle`), flow for kit-container validation (`validateKitContainer`). What looked like "parallel forks" (the gate-expectation logic, the run-state model) are **legitimate product-specific layers**: builder-kit gate policy and builder lifecycle, which flow has no opinion about and which adopting flow's definition-driven primitives would only reshape (churn), not simplify. The one real duplication (the trust-bundle validator, Tier 0) is removed. The remaining tiers (#178/#179) are upstream `flow`/`surface` work. From flow-agents' side, the boundary program is therefore essentially **resolved** — with a removed duplication, a restored anti-gaming property, and an honest, evidence-based boundary picture as the net result.

## Consequences

- **No bespoke trust-bundle schema validator in flow-agents.** Surface is the canonical
  owner; flow-agents delegates.
- **Stronger validation.** Surface also validates cross-reference integrity (dangling
  evidence/event references) that the hachure JSON schema did not. Bundles produced by
  `buildTrustBundle` are already reference-consistent, so no regression is possible in
  normal operation — only malformed external inputs are now additionally rejected.
- **async API.** `validateTrustBundle` is now async (returns `Promise<{valid,errors,available}>`).
  All existing call sites are in async contexts. External consumers of the library export
  must `await` the result.
- **Surface availability:** surface was already REQUIRED for bundle writes per ADR 0010 4c.
  `available: false` (fail-open) is only reachable in degraded diagnostic environments
  (e.g. `FLOW_AGENTS_SURFACE_UNAVAILABLE=1` test seam) or if surface fails to load.

## References

- [ADR 0001](./0001-flow-agents-consumes-flow.md) — Flow Agents consumes Flow; boundary ownership.
- [ADR 0010](./0010-workflow-trust-state-as-hachure-bundle.md) — trust bundle as workflow trust state; Phase 4c.
- GitHub issue #174 (umbrella: flow/flow-agents boundary reconciliation)
- GitHub issue #175 (Tier 0: this PR)
