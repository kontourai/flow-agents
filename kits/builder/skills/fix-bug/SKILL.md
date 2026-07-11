---
name: "fix-bug"
description: "Bug-fix profile for builder.build. Adds disciplined diagnosis and regression-focused verification without replacing the build primitives."
---

# Fix Bug

## Role and Boundary

**Role:** `builder.build` profile for a reported defect.

Select this profile when a Work Item is a bug report, regression, error, or
observable incorrect behavior. It supplies diagnosis context to the standard
build primitives; it is not a separate flow or a generic delivery entrypoint.

The profile owns **no step-gate evidence**. `pull-work`, `design-probe`,
`plan-work`, `execute-plan`, `review-work`, and `verify-work` retain ownership
of their artifacts and evidence.

## Model Routing

Use `delegate-mechanical` for reproduction bookkeeping, `delegate-design` for
hypothesis and fix planning, and `delegate-implementation` for implementation,
review, and verification. Resolve roles from `.datum/config.json` under
`context/contracts/execution-contract.md` and record fallbacks or escalations.

## Inputs and Provider Adapters

Capture the original report, reproduction steps, logs, screenshots, affected
Repository adapter, and relevant Change-adapter history. The Work Item adapter
holds the defect scope and acceptance criteria. A GitHub issue is an optional
Work Item example, not a prerequisite.

## Profile Behavior

1. Select `builder.build` through the `deliver` entrypoint, with this profile
   recorded as `fix-bug` in the planning context.
2. Reproduce the behavior when feasible and distinguish confirmed observations
   from unverified reports.
3. Ask the planning primitive to identify a root-cause hypothesis, minimal fix
   scope, affected tests, and regression risks before implementation.
4. Require the execution and verification primitives to prove both that the
   reported behavior is corrected and that relevant existing behavior still
   works.
5. Route a failed or inconclusive result back to the primitive best able to
   resolve it; do not silently convert an unverified diagnosis into a fix.

Keep investigation proportionate to the report. A missing reproduction is a
recorded uncertainty, not a reason to fabricate certainty.

## Output Responsibility

This profile creates no independent artifact or evidence. Its output is
diagnostic and regression context carried into the standard primitive artifacts
and final delivery report.

## Standalone and No-Active-Run Behavior

`fix-bug` does not start or resume a run itself. With no active run, return the
captured bug context and route to `deliver` to select and start `builder.build`.
With an active run, apply the profile only when its Work Item matches the
reported defect; otherwise stop and ask for the intended Work Item.
