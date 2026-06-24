# Plan — ADR 0010 Phase 2: gate recomputes the trust bundle (+ maximal enrichment)

**Status:** Workstream A (maximal enrichment) + B-core (gate enforces on the bundle) **shipped** in this PR; see [ADR 0010](../adr/0010-workflow-trust-state-as-hachure-bundle.md) for the authoritative phase status. **Remaining (the careful follow-on):** B's hardening — re-derive-at-gate via Surface `buildTrustReport` (async hook restructure) and removal of the `DELIVERY_TYPES`/markdown parsing (completes [ADR 0009](../adr/0009-canonical-hook-core-kit-boundary.md)) — plus Phases 3–4. The constraint that blocks a naive markdown rip-out is in Workstream B below: `prove-capture-teeth` seeds raw evidence+log and relies on markdown detection.

## Baseline (already shipped — do NOT rebuild)

- **Phase 1 emit is done + wired.** `src/cli/workflow-sidecar.ts` → `buildTrustBundle()` maps `evidence.checks` / `acceptance.criteria` / `critique` → claims+evidence+events, **recomputes status via `@kontourai/surface`'s `deriveClaimStatus`**, and `writeTrustBundle()` validates + writes `.flow-agents/<slug>/trust.bundle`. Wired into `record-evidence` / `record-critique` / `advance-state` (lines 688/743/832/897). Fail-open; `@kontourai/surface` is an **optional** dep, loaded via dynamic `import()` (`tryLoadSurface`).
- Gates already expect `trust.bundle` claims (ADR 0004 / #97). Surface exports `deriveClaimStatus`, `buildTrustReport(bundle) → TrustReport` (the recompute), `validateTrustBundle`. ESM-only.
- `stop-goal-fit.js` currently enforces off **bespoke `evidence.json` + Builder markdown** (`## Definition Of Done` / `## Goal Fit Gate`, `DELIVERY_TYPES` skill-names) + the capture cross-reference (`command-log.jsonl`). It already has: `current.json` active-task scoping, pre-execution/terminal gating, escape hatch, `FLOW_AGENTS_GOAL_FIT_MODE`.

## Goal

1. **Gate recomputes the bundle** (`buildTrustReport`) and enforces on the *report's* claim statuses — replacing bespoke `evidence.json` + Builder-markdown parsing.
2. **Maximal enrichment** of the emit: add verification-**policies** (currently `policies: []`) and fold **`command-log` capture** into the bundle's evidence.
3. Correct ADR 0010's "implementation not started" line.

## Workstream A — Maximal enrichment of the emit (do FIRST)

File: `src/cli/workflow-sidecar.ts` → `buildTrustBundle()`.

- **A1 — policies.** Emit a `VerificationPolicy` per claimType (`workflow.check.*`, `workflow.acceptance.criterion`, `workflow.critique.review`) and pass them into `deriveClaimStatus` + the bundle's `policies[]` (today `[]` → status derives without policy). Required fields (from `surface/src/types.ts` `VerificationPolicy`): `id, claimType, requiredEvidence, acceptanceCriteria, reviewAuthority, validityRule, stalenessTriggers, conflictRules, impactLevel`.
- **A2 — capture as evidence.** Read `.flow-agents/<slug>/command-log.jsonl`; for checks whose command was captured, add `Evidence` with `execution { runner:"bash", exitCode, isError, label }` + `passing`/`blocking` from the real captured result (the deterministic capture, now first-class bundle evidence).
- **Proof:** `validateTrustBundle` stays valid; extend `evals/integration/test_workflow_sidecar_writer.sh` to assert policies + capture evidence are present and statuses derive correctly.

## Workstream B — Phase 2: gate recomputes the bundle

File: `scripts/hooks/stop-goal-fit.js`.

- **B1** Resolve the active task dir (already done via `current.json` / state scoping) and read its `trust.bundle`.
- **B2** Recompute via Surface `buildTrustReport(bundle)` — dynamic `import()`, **fail-open** (mirror `workflow-sidecar`'s `tryLoadSurface`).
- **B3** Block on the **report's** statuses: any blocking-impact claim with `fail`/`disputed` (and per-policy `unknown`) → block. This **replaces** the bespoke `evidence.verdict`/`checks` parsing and the markdown DOD/Goal-Fit parsing. **Preserve:** the false-completion catch (a failed capture must surface as a `disputed` claim → block), pre-exec/terminal gating, escape hatch, `MODE`.
- **B4** Remove the Builder-markdown coupling (`## Definition Of Done` / `## Goal Fit Gate` parsing, `DELIVERY_TYPES`/`--deliver` skill-name detection) → realizes ADR 0009's de-coupling. Detect the artifact by the kit-neutral signal (`state.json` presence), not skill names.
- **Fallback:** when Surface/bundle is unavailable → fall back to bespoke `state.json`/`evidence.json` status checks (NEVER markdown). Bundle-recompute when available; schema-status fallback otherwise.
- **Proof:** `prove-capture-teeth` **8/8** (the catch now via report), conformance **L2** (add bundle-based fixtures), goal-fit + escape-hatch + steering integration green.

## Workstream C — Docs

- Correct `docs/adr/0010` : Phase 1 shipped (`buildTrustBundle`/`writeTrustBundle`); remainder = Phase 2 (this) + maximal + Phase 3.
- **Phase 3 (separate, later):** Surface **Trust Panel** projection (`@kontourai/surface/trust-panel/element`) over the local bundle; optional Console sink per ADR 0010's local-first distribution model.

## Sequencing, proof gates, hygiene

- Order: **A → B → C.** After *every* edit to `stop-goal-fit.js`, re-run `prove-capture-teeth` + the goal-fit suite (this hook broke twice from haste — change incrementally).
- Per-gate green required: `tsc` build, static+integration evals, conformance L2, `prove-capture-teeth` 8/8.
- Work in an **isolated git worktree off latest `origin/main`** (this is a busy multi-agent repo — 5+ active worktrees). **Before starting, check `feat/gate-review` and `chore/gate-vocabulary-migration` aren't colliding.** Surgical commits, one PR, shepherd CI (the `pre-push` source-validation needs `node_modules/.bin` on `PATH`; never `--no-verify`).

## Guardrails (don't violate)

- **Consume, never fork:** use Surface's `buildTrustReport`/`deriveClaimStatus`; do not reimplement status logic in flow-agents.
- **Boundary (ADR 0009):** the gate reads the canonical bundle (core), not Builder markdown (kit).
- **Determinism preserved:** the proven "claimed-pass but capture shows fail → block" must still hold via the report (failed capture event → `disputed` claim).

## Key files

`src/cli/workflow-sidecar.ts` (`buildTrustBundle`), `scripts/hooks/stop-goal-fit.js`, `surface/src/types.ts` (Policy/Event/Claim shapes), `schemas/workflow-evidence.schema.json`, `evals/integration/test_workflow_sidecar_writer.sh`, `evals/acceptance/prove-capture-teeth.sh`, `packaging/conformance/fixtures/`, `docs/adr/0009`+`0010`.
