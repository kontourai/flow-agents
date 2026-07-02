# Veritas Governance Kit

Turns a repo's **Veritas-governed Repo Standards** into deterministic, agentless **gate
evidence**. Slice 1 ships the thinnest useful surface: one flow, one gate, that gates a real
`veritas readiness` verdict.

This kit **wraps** [`@kontourai/veritas`](https://www.npmjs.com/package/@kontourai/veritas) via
CLI invocation plus a small kit-local trust.bundle adapter. It does **not** fork, vendor, or
reimplement Veritas's Repo Standards / evidence-check evaluation — Veritas evaluates; the kit
only projects Veritas's own recorded verdict into the Flow trust.bundle vocabulary.

## What it contains

| Asset | Path | Purpose |
| --- | --- | --- |
| Flow | `flows/readiness-check.flow.json` | Single-gate agentless flow `readiness -> gate-check`. The gate requires a **verified** `software-readiness-verdict` trust.bundle claim. |
| Adapter | `adapter/readiness-to-trust-bundle.mjs` | Projects a `veritas readiness --check evidence --working-tree` evidence report into a Hachure `trust.bundle` (via `@kontourai/surface`), deriving the claim status from Veritas's own blocking-failure signal. |
| Fixtures | `fixtures/readiness/*.readiness-report.json` | Captured **real** Veritas readiness reports (a ready clean tree, and a not-ready tree with a required CLI artifact deleted) used by the eval. |

The gate uses provider-neutral Flow vocabulary (`kind: "trust.bundle"`, `bundle_claim`) — the
same vocabulary `kits/builder/flows/build.flow.json` uses. Veritas is simply the producer that
satisfies it. `claimType: "software-readiness-verdict"` is taken directly from Veritas's own
Surface projection (`veritas/src/surface/projected-claims.mjs`, surface `veritas.readiness`).

## How to run the gate

```bash
# 1. Produce a real Veritas readiness report for your change.
veritas readiness --check evidence --working-tree
#    -> writes .kontourai/veritas/evidence/veritas-<runId>.json

# 2. Project that report into a trust.bundle.
node kits/veritas-governance/adapter/readiness-to-trust-bundle.mjs \
  --report .kontourai/veritas/evidence/veritas-<runId>.json \
  --out readiness.bundle

# 3. Gate it (agentless, CI-callable — @kontourai/flow >= 1.3).
flow init
flow start kits/veritas-governance/flows/readiness-check.flow.json --run-id readiness
flow attach-evidence readiness --gate gate-check-gate --file readiness.bundle --bundle
flow evaluate readiness --gate gate-check-gate --exit-code
#    exit 0 when readiness is ready (claim verified); exit 1 (block) otherwise.
```

## Semantics

**Settled** (owner-ratified + investigation-confirmed; see
`.kontourai/flow-agents/ws5-governance-kit-slice1` session findings). The adapter derives the
readiness gate verdict from **blocking failures** in Veritas's own recorded results: a
`Require`-enforcement policy failure, an uncovered-path `fail`, a failed selected evidence check,
or a blocking external-tool `fail`/`missing` makes the verdict **not-ready** → the
`software-readiness-verdict` claim derives a non-`verified` status → the gate **blocks**. A ready
verdict derives `verified` → the gate **passes**.

This matches Veritas's own `readinessHasBlockingFailure` helper (`veritas/src/surface/readiness.mjs`)
and Surface's weakest-link claim derivation (`buildTrustReport` downgrades a readiness claim to
`rejected` on any rejected Require). The adapter intentionally does **not** apply Veritas's
`promotion_allowed` short-circuit — `promotion_allowed` is a workstream-routing hint (set by
file-pattern lane resolution in `src/repo/routing.mjs`), not a safety signal, and applying it as
one lets a record with blocking Require failures read as ready. That short-circuit is a filed
Veritas bug, [kontourai/veritas#106](https://github.com/kontourai/veritas/issues/106), not a
legitimate alternate reading. Investigation conclusion: the adapter's stricter blocking-failure
derivation is correct today and will agree with Veritas's own exported functions once #106 lands.

## Trust status

Slice 1 ships **unverified** (like `kits/release-evidence`); it is not on the first-party
allowlist (`src/flow-kit/validate.ts` `FIRST_PARTY_KIT_IDS`). First-party promotion is an owner
decision deferred to a later slice (see the WS5 shaping's open decisions).

## Not in slice 1

Skills (`consult-standards`, `governance-evidence`), the fuller `merge-readiness` flow, the
`standards-authoring` flow, and the `knowledge` dependency are later slices — see the WS5
backlog.
