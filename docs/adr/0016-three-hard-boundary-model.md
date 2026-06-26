---
title: "ADR 0016: The Three-Hard-Boundary Model — a FlowDefinition-Driven, Kit-Agnostic Core"
---

# ADR 0016: The Three-Hard-Boundary Model — a FlowDefinition-Driven, Kit-Agnostic Core

**Date:** 2026-06-26
**Status:** Accepted
**Supersedes (in part):** ADR 0014's finding that the bespoke `workflow-sidecar` FSM is the legitimate core engine.
**Builds on:** ADR 0001 (Flow Agents consumes Flow), 0004 (gates expect trust claims), 0005 (Resource Contract), 0007 (Flow/Skill/Kit/Tool), 0009 (canonical hook core/kit boundary), 0015 (Flow↔Flow-Agents reconciliation); synthesis input #183.

---

## Context

The boundary between **flow**, **flow-agents**, and **flow-agent-kits** is defined across many ADRs (0001, 0007, 0009, 0014, 0015) but never as one model, and the pieces have drifted:

1. **A real contradiction.** ADR 0014 (Proposed) calls the bespoke `workflow-sidecar` FSM "confirmed core — the legitimate lifecycle engine" needing "a small cleanup, not a relocation." ADR 0015 (Accepted) calls the same FSM "a parallel reimplementation of ADR 0005's Resource Contract" to be retired via a phased migration. Both were written 2026-06-25; they cannot both stand as written.

2. **A load-bearing gap.** No ADR states that the core's gate enforcer and lifecycle driver must be **driven by the active kit's FlowDefinition** rather than hardcode a claim taxonomy. The consequence is live in the code: `scripts/hooks/stop-goal-fit.js` enforces a hardcoded generic taxonomy (`workflow.check.*`, `workflow.critique.review`, `workflow.acceptance.criterion`) with **zero** references to any FlowDefinition, while the kits' FlowDefinitions declare a different, per-step vocabulary (`builder.verify.tests`, `knowledge.ingest.capture`). ADR 0009 narrowed the de-coupling rule to skill/template names and explicitly *blessed* the hardcoded `workflow.*` taxonomy as "core" — sanctioning the very coupling this ADR forbids.

3. **Unresolved ownership.** Claim-taxonomy ownership (generic kinds vs kit-namespaced types) and the cardinality/lifetime parameterization (#183) are decided nowhere binding.

We own the full stack (hachure → surface → flow → flow-agents → kits). The boundaries should be **hard**, and the abstractions should let the *demoed* use cases — the Builder delivery workflow and the Knowledge hygiene workflows — run on the same machinery from their FlowDefinitions.

## Decision

### 1. Three hard boundaries (one named model)

- **flow** — the **domain-agnostic workflow engine.** Owns the FlowDefinition schema (steps, gates, `expects[]`, `route_back_policy`), gate *evaluation* (`evaluateGate` over expectations, re-derived from the trust layer), transition validation, run-state (`FlowRunState`/Resource Contract run model), route-back, and Flow Reports. It knows nothing about any kit or claim vocabulary; it operates on *whatever a FlowDefinition declares*.

- **flow-agents (core)** — the **kit-agnostic execution of a flow inside an agent harness.** Owns the lifecycle *driver* (`advance-state`), the gate *enforcer* (the Stop hook), evidence capture, the trust.bundle producer, the Resource/sidecar projection, the runtime adapters (claude/codex/…), and session machinery. It executes **any** kit's FlowDefinition. "**Core**" in this repo means exactly this layer; align other ADRs' usage to it.

- **flow-agent-kits** — the **domains** (builder, knowledge, and future Sales/Research). Each kit **declares**: its FlowDefinition(s) (steps + gates + `expects[]`), its skills/agents (the claim *producers*), and its domain store/adapters. The kit **declares**; the core **executes**. A kit never re-implements the engine or the enforcer.

### 2. Abstraction A (load-bearing) — the core is FlowDefinition-driven

The core gate enforcer and lifecycle driver **MUST be driven by the active kit's FlowDefinition.** The enforcer evaluates the claim expectations the kit's FlowDefinition `expects[]` declares for the current gate (re-deriving status via the trust layer); the lifecycle driver validates transitions and reads `route_back_policy` from the FlowDefinition. **The core MUST NOT hardcode a claim taxonomy, step graph, or route-back limit.**

The current `stop-goal-fit.js` hardcoded `workflow.*` taxonomy and `advance-state`'s hardcoded `>= 3` / `phase==="learning"` rules are **violations to remediate**, not "core contract." (This corrects ADR 0009 §3, which reclassified skill/template names but left the hardcoded taxonomy in place.)

### 3. Abstraction B — claim-taxonomy ownership

The **kit's FlowDefinition is authoritative** for which claims each gate expects. The core derives the generic *kind* of an expectation (a check, a critique, an acceptance, etc.) from the FlowDefinition's expectation metadata; it does not pattern-match a hardcoded namespace. Generic claim **kinds** are flow/core vocabulary; the **binding** of kinds to steps + accepted statuses is the kit's FlowDefinition. (Reconciles ADR 0004's kit-namespaced examples with the core enforcer.)

### 4. Abstraction C — cardinality & lifetime are kit parameters, not new engines

Builder and Knowledge are the **same** model at two settings of two parameters (per #183): **cardinality** (Builder = one work-item subject; Knowledge = many records — `SelectedScope` already says "one or many") and **lifetime** (run-scoped vs durable Resources via `ownerReferences`). New kits set these parameters over the same core + FlowDefinition machinery; they do not author new lifecycle engines.

### 5. Abstraction D — Resource/claim separation is the architecture (invariant)

Per ADR 0005 + #183 Finding 2: the **Resource Contract** (`WorkflowRun`/`RunPlan`/`status.conditions`) is the run/state model; the bespoke `workflow-sidecar` FSM is a parallel reimplementation that **retires** via ADR 0015's phased migration. Conditions are **writable summaries**; the gate **re-derives** truth from Hachure claims via Surface; `conditions[].evidenceRefs` cite claim IDs. **Resource and claim must not be fused** — the friendly mutable surface over the un-gameable derived core is the whole point.

### 6. Resolution of the 0014↔0015 contradiction

Both were partly right. The core **owns a lifecycle engine** (0014) — but that engine is the **FlowDefinition / Resource-Contract-driven** one defined here, **not** the bespoke FSM, which retires (0015). ADR 0014's "keep the FSM as core, tweak defaults" finding is superseded by this ADR; its boundary *principle* (the agent-blind "dividing test") stands.

## Consequences

- A clear target for the ADR-0015 migration: each phase moves a core mechanism from hardcoded behavior to FlowDefinition-driven behavior, within these boundaries.
- The first remediation of Abstraction A is the gate enforcer: `stop-goal-fit` should evaluate the active kit's FlowDefinition `expects[]` (still re-deriving via Surface — the anti-gaming property is unchanged, only the *source of expectations* moves).
- New kits become "write a FlowDefinition + skills + (optionally) a store adapter" — no engine work.
- Requires reconciling the live taxonomy split (`workflow.*` enforced vs `builder.*`/`knowledge.*` declared); whether the per-step `expects[]` are produced today is a named follow-on investigation.
- Terminology: "core" is fixed to the flow-agents kit-agnostic execution layer; 0001/0009/0014/0015 usage aligns to it.

## References

- ADR 0001, 0004, 0005, 0007, 0008, 0009, 0014, 0015
- `docs/kontour-resource-contract.md` (Compatibility Guidance)
- Issue #183 (synthesis input — "not a new decision"); #174 (boundary umbrella); #177 (the migration)
- `scripts/hooks/stop-goal-fit.js` (the Abstraction-A violation to remediate); `kits/builder/flows/build.flow.json`, `kits/knowledge/flows/*.flow.json` (kit FlowDefinitions)
