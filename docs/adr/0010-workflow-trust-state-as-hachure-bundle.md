---
title: "ADR 0010: Workflow Trust State as a Hachure Trust Bundle"
---

# ADR 0010: Workflow Trust State as a Hachure Trust Bundle

**Date:** 2026-06-23
**Status:** Accepted. Phase 1 (emit) shipped (pre-existing); **maximal enrichment** (verification-policies + capture-authoritative evidence), **Phase 2 core** (the gate enforces on the bundle's Surface-derived claim statuses), and **Phase 3 local projection** (`render-trust-panel` emits a standalone Surface Trust Panel HTML) shipped. Remaining: Phase 2 hardening (re-derive-at-gate; `DELIVERY_TYPES`/markdown removal); Phase 3 Console sink; Phase 4 (retire bespoke sidecars).
**Supersedes:** the interim markdown-de-coupling of ADR 0009 (see "Relationship to ADR 0009").

---

## Context

Flow Agents stores a task's workflow state as several bespoke JSON sidecars under
`.flow-agents/<slug>/`: `evidence.json` (verdict + checks), `acceptance.json`
(criteria), `critique.json` (review findings), `command-log.jsonl` (captured command
results), plus `state.json` (lifecycle: status/phase/next_action). The canonical hooks
(`stop-goal-fit`, `evidence-capture`) read these directly, and `stop-goal-fit` also
parses a Builder **markdown template** (`## Definition Of Done`, `## Goal Fit Gate`,
`### Verdict: PASS`).

Meanwhile **ADR 0004 already established that Flow gates expect Hachure `trust.bundle`
claims** (`builder.verify.tests`, etc.). So the platform is *half Hachure* at the gate
layer and *bespoke* at the local-sidecar layer — a duplicated representation of the same
thing: **is this work provably done?** That question is, definitionally, Hachure's: *a
claim's status recomputed from its evidence by a pure, versioned function.*

## Decision

**The workflow's *trust* state is represented as a Hachure trust bundle; the gate
evaluates that bundle; Surface projects it to the Trust Panel / Console.**

### What maps to the bundle (trust state)

- `evidence.json` checks → **claims + evidence** (status recomputed from the result).
- `acceptance.json` criteria → **claims** (each AC; status from its evidence_refs).
- `command-log.jsonl` → **evidence/traces** the claims recompute *from* (the event
  stream behind the bundle).
- `critique.json` → **claims/findings**.

### What stays out of the bundle (lifecycle ≠ trust)

`state.json` — `status` / `phase` / `next_action` — is workflow **control** state (the
*WHAT-step*, owned by Flow per ADR 0007), **not** a trust claim. It stays a Flow
workflow-state record, *referenced by* the bundle, not modeled *as* claims.

### The gate

`stop-goal-fit` stops parsing the Builder markdown template and stops reading bespoke
sidecars; it **recomputes the Hachure bundle** (Surface evaluation) and gates on claim
statuses + the capture cross-reference. This is the full realization of ADR 0009 (gate
on the canonical contract) — the gate becomes a deterministic Hachure recompute,
inherently portable and third-party-verifiable.

### Distribution: local-first, Console as optional projection

- **Local file is the source of truth.** Enforcement reads the local bundle and works
  fully offline. **The gate never depends on Console or any network sink.**
- **Console / Trust Panel is an optional Surface *projection*** over the bundle —
  Surface already defines `TrustBundle → Trust Panel | Console | API | MCP`. Flow Agents
  *produces* the local bundle; **Surface owns projection**; Console is the plane. Flow
  Agents must not grow a bespoke "push to console" path (consume-never-fork).
- This is the **existing telemetry sink config** generalized: *local always; Console
  optional*. It is also the monetization boundary made literal — **open data plane (local
  bundle, free) / paid control plane (Console)**.

## Consequences

- **One representation end-to-end** — finishes what ADR 0004 started; kills the
  bespoke/Hachure duplication.
- **Surface Trust Panel "for free"** — workflow outcomes (which checks passed/failed,
  why a stop blocked) become viewable + recomputable in the company's own panel. This is
  also a dogfood/demo: Flow Agents' own workflow trust state, in the company's trust
  format, in the company's panel.
- **Deterministic gate** — the verdict is a pure recompute, not bespoke parsing.
- **Costs (eyes open):** (1) hook weight — the Stop hook gains a Hachure recompute +
  schema validation vs. dependency-free `JSON.parse` (mitigable; `hachure` is already an
  optional dep per ADR 0004; the recompute is pure). (2) Migration touches every producer
  (`workflow-sidecar` writer), consumer (hooks, `validate-workflow-artifacts`), schema,
  and test. (3) Regression risk concentrates on the exact hook that twice broke the
  capture loop from haste — so it is phased with proofs as guardrails.

## Phased Migration (proof-gated)

Each phase must keep `prove-capture-teeth` (8/8) and conformance (L2) green before the
next begins.

- **Phase 0 (today):** gate enforces on bespoke sidecars + the hygiene fixes (`08319f4`).
- **Phase 1 — dual-write the bundle: ✅ SHIPPED.** `workflow-sidecar`'s
  `buildTrustBundle`/`writeTrustBundle` emit a validated Hachure `trust.bundle` for
  evidence/acceptance/critique, wired into `record-evidence`/`record-critique`/
  `advance-state`. **Maximal enrichment (this PR):** a `VerificationPolicy` per claimType
  and the `command-log` capture folded in as `execution` evidence — and capture is
  *authoritative* (a claimed-pass whose captured command FAILED is `disputed` in the
  bundle). *Proof: `test_workflow_sidecar_writer` AC3 + capture/conformance green.*
- **Phase 2 — gate enforces on the bundle: ◑ CORE SHIPPED (this PR).** `stop-goal-fit`
  reads the `trust.bundle` and blocks on any high-impact `disputed` claim (Surface-derived
  status; a canonical false-completion signal — HARD_BLOCK at any phase, incl. terminal).
  Additive: the capture cross-reference is preserved. *Proof: new conformance fixture
  `stop-goal-fit--block-bundle-disputed-claim` (L2 21/21); prove-capture-teeth 8/8.*
  **Remaining hardening:** (a) *re-derive at the gate* via Surface `buildTrustReport`
  (needs an async hook restructure — today the gate reads the write-time Surface-derived
  status); (b) *remove* the `DELIVERY_TYPES`/markdown parsing (subsumes ADR 0009) — the
  capture proof seeds raw evidence+log and relies on markdown detection, so this is
  reworked carefully, not ripped out.
- **Phase 3 — Surface projection: ◑ LOCAL SHIPPED (this PR).** `render-trust-panel <dir>`
  derives the report (Surface `buildTrustReport`) and emits a **standalone HTML** embedding
  Surface's dependency-free `<surface-trust-panel>` element — projection fully delegated to
  Surface (consume-never-fork). Enforcement stays local/offline. *Proof:
  `test_workflow_sidecar_writer` AC4.* **Remaining:** the **Console sink** (behind the
  existing opt-in telemetry sink — local always, Console optional).
- **Phase 4 — retire the bespoke sidecars** (keep `state.json` lifecycle only) once all
  producers/consumers/tests are on the bundle.

## Relationship to ADR 0009

ADR 0009 (apply 0008's dividing test to canonical hooks; phases canonical-core) stands.
Its *mechanical interim* — de-coupling the Builder markdown/skill-name parsing in place —
is **superseded**: do not polish the bespoke hook; Phase 2 replaces that parsing with
bundle recompute, achieving the same kit-neutrality via the canonical Hachure format.

## Alternatives Considered

- **Keep bespoke sidecars.** Rejected: duplicates ADR 0004's gate representation, no
  Trust Panel, gate stays bespoke. (Defensible only if the Trust Panel view is not wanted
  soon — in which case defer Phases 2–4, but Phase 1 dual-write still de-risks.)
- **A new bespoke "stream trust state to Console" mechanism.** Rejected: Surface already
  projects bundles to Console and telemetry already has a local/Console sink config —
  compose them, don't fork.

## References

- [ADR 0004: Gates Expect Hachure Trust Bundles](./0004-gates-expect-surface-claims.md)
- [ADR 0008: Kit Operation Boundary](./0008-kit-operation-boundary.md) — the dividing test.
- [ADR 0009: Canonical Hook Core/Kit Boundary](./0009-canonical-hook-core-kit-boundary.md) — superseded interim.
- `surface/CONTEXT.md` — `TrustBundle → Trust Panel | Console | API | MCP` projections.
- hachure `trust-bundle.schema.json`; `install.sh --telemetry-sink` (local/Console sink precedent).
- `scripts/hooks/{stop-goal-fit,evidence-capture}.js`; `src/cli/workflow-sidecar.ts`.
