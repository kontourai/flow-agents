---
title: "ADR 0009: Canonical Hook Core/Kit Boundary"
---

> **FROZEN — immutable history.** Superseding/current decisions live in [`docs/decisions/`](../decisions/index.md). Do not edit.

# ADR 0009: Canonical Hook Core/Kit Boundary

**Date:** 2026-06-23
**Status:** Accepted (decided with Brian Anderson, 2026-06-23)

> **Extended/corrected by ADR 0016 (2026-06-26).** This ADR de-coupled the canonical hook from Builder skill/template *names* but left the hardcoded `workflow.*` claim taxonomy in the hook as "core contract." ADR 0016 (Abstraction A) corrects that: the gate enforcer must be **driven by the active kit's FlowDefinition `expects[]`**, not a hardcoded taxonomy. The hook's hardcoded `workflow.check.*`/`workflow.critique.review`/`workflow.acceptance.criterion` filtering is reclassified as a **violation to remediate** (same treatment this ADR gave `DELIVERY_TYPES`). The anti-gaming re-derivation via Surface is unchanged — only the *source* of the expectations moves to the FlowDefinition.

---

## Context

Flow Agents ships **canonical hooks** — `stop-goal-fit`, `workflow-steering`,
`evidence-capture`, `config-protection`, `quality-gate` — wired into *every* runtime
bundle as kit-neutral policy. ADRs 0007 (skill/tool/kit boundary) and 0008 (kit
operation boundary) classify skills, tools, kits, and kit *operations*, but they
never explicitly placed **hooks**. Hooks are a fourth thing: the always-on policy
layer the runtime fires, independent of which kit is active.

Dogfooding block-by-default surfaced a boundary violation: `stop-goal-fit` (a
canonical hook shipped to all runtimes) hard-codes **Builder-Kit extension
semantics** — `DELIVERY_TYPES` (the Builder skill names deliver/fix-bug/
execute-plan/verify-work) plus `--deliver`/etc. artifact detection, and the Builder
deliver-template section names (`Definition Of Done` / `Goal Fit Gate` /
`Final Acceptance`). A hook that runs under *any* kit should not know *one* kit's
skills or markdown template.

An open sub-question rode along: is the workflow-state **phase set**
(`idea → … → done`, enumerated in `schemas/workflow-state.schema.json`) a canonical
core lifecycle, or Builder-Kit's own?

## Decision

### 1. Apply ADR 0008's dividing test to canonical hooks

A canonical hook **may read the kit-neutral core workflow contract**: the
`schemas/workflow-*.schema.json` shapes (`state` status/phase/next_action,
`evidence` verdict/checks, `acceptance` criteria) and `command-log.jsonl`. These are
container/contract-level (the *WHAT*), owned in core `schemas/` + `context/contracts/`
and agentless-capable (ADR 0001).

A canonical hook **may NOT interpret kit-extension semantics**: specific skill names,
a kit's artifact-template section conventions, or any per-kit vocabulary. This is
ADR 0008's *agent-blind guardrail*, extended from kit operations to hooks: *does the
hook interpret the extension (kit-specific) or only the contract (core)?*

### 2. The workflow-state phase set is canonical/core

Flow owns a **single canonical task lifecycle**; kit Flow Definitions map their steps
onto it. Kits do not invent phases. This is what lets one canonical gate work across
every kit — the cross-kit gate property. (Trade-off accepted: a kit with a radically
different lifecycle must map onto canonical phases or motivate adding one.)

### 3. Consequence for `stop-goal-fit` (the de-coupling)

- Detect the active task by the **kit-neutral signal** — presence of `state.json` /
  the workflow sidecars, scoped via `.flow-agents/current.json` — **not** by the
  Builder skill-name patterns. Remove `DELIVERY_TYPES` / `--deliver` coupling.
- The deliver-template **finish-line section checks** (`Definition Of Done` /
  `Goal Fit Gate` / `Final Acceptance`) are Builder-Kit vocabulary → supplied by the
  **kit** (config the canonical hook reads) or a Builder-Kit-owned check, not
  hard-coded in the canonical hook.
- The deterministic enforcement that matters (evidence verdict/checks + the capture
  cross-reference + acceptance criteria) is all **schema-based** and stays in the
  canonical hook unchanged.

## Consequences

- The canonical gate becomes genuinely kit-neutral; the proven false-completion catch
  (conformance L2; `prove-capture-teeth`) is unaffected because it is schema-based.
- Builder-Kit finish-line conventions move to kit ownership — a small, mechanical
  refactor analogous to the skill-placement move ADR 0007 made mechanical.
- **Resolves the A/B fork as A** ("core knows the core contract"), with the precise
  boundary: **schema + canonical phases = core; skill-names + template-sections = kit.**

## Alternatives Considered

- **B — canonical hooks fully kit-agnostic; the stop gate is Builder-Kit-owned.**
  Rejected: the workflow contract is core (schemas/, context/contracts/, agentless per
  ADR 0001), and relocating the gate per-kit duplicates a well-tested enforcement,
  violating consume-never-fork. The dividing test already gives a kit-neutral core gate.
- **Leave the skill-name / template-section coupling in place.** Rejected: it violates
  ADR 0008's agent-blind guardrail — a hook shipped to every runtime must not interpret
  one kit's extension.

## References

- [ADR 0001: Flow Agents Consumes Flow](./0001-flow-agents-consumes-flow.md)
- [ADR 0007: Flow / Skill / Kit / Tool Boundary](./0007-flow-skill-kit-tool-boundary.md)
- [ADR 0008: Kit Operation Boundary](./0008-kit-operation-boundary.md) — the dividing test this ADR extends to hooks.
- [ADR 0004: Gates Expect Hachure Trust Bundles](./0004-gates-expect-surface-claims.md)
- `schemas/workflow-*.schema.json`; `scripts/hooks/{stop-goal-fit,evidence-capture,workflow-steering}.js`.
