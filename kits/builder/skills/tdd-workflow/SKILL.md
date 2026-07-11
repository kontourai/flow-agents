---
name: "tdd-workflow"
description: "Test-first profile for builder.build. Requires observable RED, GREEN, and appropriate REFACTOR evidence through the standard build primitives."
---

# TDD Workflow

## Role and Boundary

**Role:** test-first `builder.build` profile.

Select this profile only when the user requests test-driven development or when
the selected Work Item explicitly requires a test-first approach. It constrains
the standard build primitives; it is not a separate flow and does not replace
`deliver` as the build entrypoint.

The profile owns **no step-gate evidence**. The plan, execution, review, and
verification primitives own the artifacts and evidence for their respective
steps.

## Model Routing

Use `delegate-mechanical` for test and check bookkeeping, `delegate-design` for
acceptance and test design, and `delegate-implementation` for the red-green-
refactor implementation and its review. Resolve roles from `.datum/config.json`
under `context/contracts/execution-contract.md` and record fallbacks or
escalations.

## Inputs and Provider Adapters

Use the selected Work Item's acceptance criteria, Repository adapter test
conventions and commands, and Change-adapter risk context. A remote issue or
pull request may supply these inputs, but no particular provider is required.

## Profile Behavior

1. Select `builder.build` through `deliver`, recording the `tdd-workflow`
   profile in planning context.
2. Have `plan-work` identify test scenarios before the implementation tasks,
   including what behavior each test should demonstrate and why it should fail
   against the pre-change behavior.
3. Have `execute-plan` make the tests demonstrably fail for the intended
   reason before implementation, then make them pass with the smallest adequate
   change.
4. Refactor only while the relevant tests remain passing. Use checkpoints when
   the Repository adapter's practice calls for them; do not impose a commit
   pattern.
5. Have review and verification evaluate the test quality, changed behavior,
   relevant regression coverage, and any project-defined coverage requirement.

Do not require an arbitrary numeric coverage percentage. Coverage targets come
from the Work Item, repository policy, or an explicit user decision.

## Output Responsibility

This profile creates no independent artifact or evidence. Its output is the
test-first constraints and RED/GREEN/REFACTOR observations carried by the
standard primitive artifacts and final delivery report.

## Standalone and No-Active-Run Behavior

`tdd-workflow` does not start or resume a run itself. With no active run,
route to `deliver` to select and start `builder.build` with this profile. With
an active run, apply it only when doing so is compatible with the current Work
Item and canonical next action; otherwise surface the conflict.
