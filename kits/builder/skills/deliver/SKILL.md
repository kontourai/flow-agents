---
name: "deliver"
description: "Builder Kit build entrypoint. Starts or continues a selected Work Item through builder.build by composing the build primitives without owning their step evidence."
---

# Deliver

## Role and Boundary

**Role:** Builder Kit entrypoint for standard `builder.build` delivery.

Select this entrypoint when the user asks to build or deliver a selected Work
Item without requesting test-first development. For test-first delivery, select
the `tdd-workflow` `builder.build` profile instead.

`deliver` coordinates the standard build primitives:

`pull-work` -> `design-probe` -> `plan-work` -> `execute-plan` ->
`review-work` -> `verify-work`, followed by the applicable publish and learning
activities.

It does not reproduce those primitives' detailed procedure, write source code,
or own **any step-gate evidence**. Each primitive produces and records the
evidence for its own step. `deliver` consumes their results only to select the
next primitive or surface a blocker.

## Model Routing

Use `delegate-mechanical` for selection bookkeeping, `delegate-design` for
probing and planning, and `delegate-implementation` for execution, review, and
verification. Resolve each role from `.datum/config.json` under
`context/contracts/execution-contract.md`; this entrypoint does not pin models
or reasoning effort itself.

## Inputs and Provider Adapters

Use the following provider-neutral inputs:

- **Work Item adapter:** selected work, scope, acceptance context, and identity.
- **Board adapter:** availability, priority, WIP, dependencies, and selection
  state when work comes from a queue.
- **Repository adapter:** checkout, branch/worktree policy, and local checks.
- **Change adapter:** proposed change and, when applicable, review, CI, merge,
  and release state.

A provider may implement any adapter. A Work Item reference is a stable,
human-readable provider reference that the configured Work Item adapter can
resolve; GitHub issues are one example, not the contract. For a direct local
request, use an already-bound local session. Do not invent a provider record or
claim a fresh binding when the configured adapter cannot resolve the selected
reference.

## Flow Selection and Run Behavior

Before starting a run, require a completed `pull-work` artifact showing readiness,
WIP and conflict assessment, assignment/liveness preflight, post-claim ownership
confirmation, and the selected Work Item binding. A Work Item reference alone is
not sufficient preflight.

After those conditions hold, start the selected Work Item with the public
workflow interface:

```sh
flow-agents workflow start --flow builder.build --work-item <provider-ref> \
  --assignment-provider <configured-kind> \
  [--effective-state-json <provider-status.json>]
```

Use `flow-agents workflow status --session-dir <session-dir> --json` to inspect
an existing canonical run. For an interrupted active run, follow the returned
`next_action` and use its exact idempotent command. Use `flow-agents workflow
resume --session-dir <session-dir> --reason "Continue the bound Work Item"` only
for an existing paused run. Use no private workflow interface, internal writer,
or caller-selected run/step recovery command.

For provider-backed work, begin with `pull-work` and `design-probe`. For a
direct local Work Item, resume its already-bound session; if none exists, report
the missing adapter binding rather than bypassing Flow. If the request is only
a raw idea, offer `builder-shape`; do not start delivery until a Work Item is
selected.

## Orchestration Rules

- Delegate planning, implementation, review, and verification to their named
  primitives. Keep model routing and worker parallelism in those primitives;
  this entrypoint sets neither a worker count nor a coverage threshold.
- A failed review or verification result returns to the appropriate planning or
  execution primitive. A `NOT_VERIFIED` result remains visible as a gap.
- At each transition, compare the Work Item goal, acceptance criteria, current
  artifacts, and unresolved gaps. Route back to the earliest primitive that can
  correct a failed condition; do not wait until final verification to expose a
  known mismatch.
- Use the Repository and Change adapters to decide whether publishing,
  release-readiness, or learning applies. Do not treat a remote change or merge
  as implicit authorization.
- Preserve the exact commands and evidence emitted by primitives rather than
  replacing them with orchestration prose.

## Output Responsibility

`deliver` produces no separate artifact and no gate evidence. The active
`builder.build` run and the artifacts produced by its primitives are the output
of delivery. Report the Work Item, current run status, completed primitive
outputs, remaining gaps, and any Change-adapter state to the user.

Before closeout, perform a Final Acceptance reconciliation across the selected
Work Item, actual changed scope, criterion verdicts, critique, and Flow status.
Do not describe delivery as complete while required behavior, evidence, or
follow-up remains unresolved. Route eligible outcomes into publish/readiness and
learning through their owning Builder skills.

When an eligible code-host change needs its verified trust state committed for
CI reconciliation, use the public `flow-agents workflow publish-delivery
--session-dir <session>` command after release readiness while the assignment actor
and reviewed source snapshot still exactly match. A later source change requires
canonical review and verification again; older sessions without a verification
workspace snapshot must also rerun verification before public publishing. Do not manufacture a
prior session, invoke a private writer, or use a `delivery/DECLARED` exemption
for agent-delivered work.

## Standalone and No-Active-Run Behavior

If no active run exists, require a selected Work Item and start
`builder.build` only after the completed preflight above; do not create a partial
or preflight-bypassing run. If an active run exists,
inspect its public status and continue only from its canonical next action. If
selection, adapter access, or authorization is missing, stop and report the
specific blocker.
