---
status: current
subject: Workflow Enforcement
decided: 2026-07-10
evidence:
  - kind: adr
    ref: docs/adr/0001-flow-agents-consumes-flow.md
  - kind: issue
    ref: https://github.com/kontourai/flow-agents/issues/438
  - kind: session-archive
    ref: .kontourai/flow-agents/builder-enforcement-remediation/builder-enforcement-remediation--pull-work.md
---
# Workflow Enforcement

**Decision.** A new Workflow Run always starts at the first step declared by its canonical
Flow Definition. A caller cannot choose a later starting step, and metadata such as an ad-hoc
reason cannot grant that authority. Flow-native accepted exceptions may satisfy a named gate in
an existing run; they do not authorize skipping the prefix that precedes that gate.

Recovery resumes persisted run state rather than creating a replacement run at an arbitrary
step. The recovered state must validate against the canonical definition identity and preserve
its transitions, gate outcomes, attached evidence, and accepted exceptions. An import surface,
when provided, must validate the same complete durable record before making it active; it is not
a step-selection escape hatch.

Direct primitives remain valid outside a product Workflow Run. For example, standalone
`plan-work` may execute with its own primitive contract, but it must not stamp or report itself
as a completed `builder.build` prefix. A request that intends the Builder Kit product flow must
enter through `pull-work`, then `design-probe`, before planning.

**Rationale.** The Flow Definition is the executable ordering authority. Allowing callers to
self-declare a later step makes every upstream gate advisory and lets the artifact being created
justify its own creation. Separating standalone primitives from product-flow runs preserves
useful composability without weakening ordered workflows.

**Consequences.** `ensure-session --flow-id builder.build --step-id plan` is invalid for a new
run, even with `--ad-hoc-reason`. Existing run recovery is identified by durable run identity,
not by a reason string. Refusal must happen before session files, assignment claims, or other
side effects. Builder skills must route productized work through the declared prefix and describe
direct primitive use as standalone.
