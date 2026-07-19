---
name: "execute-plan"
description: "Execution primitive that turns a structured plan into implemented scope through tool-worker delegation."
---

# Execute Plan

Implement an approved plan while preserving scope, traceability, and recovery context.

## Role And Binding

- **Role:** canonical Builder build-step producer and standalone execution primitive.
- **Binding:** `builder.build` step `execute`.
- **Produces:** the active session execution report (`<slug>--deliver.md`), `state.json`, the wave manifest (`waves.json`) for delegated waves, and `implementation-scope` for an active matching run.
- **Standalone no-run behavior:** execute the supplied plan and return execution evidence. Do not start a Builder run, record Builder evidence, or imply that an inactive Builder flow advanced.

## Model Routing

Delegate implementation tasks to `tool-worker`. Select `delegate-mechanical`, `delegate-implementation`, or `delegate-design` according to the planned task, resolving the role from `.datum/config.json` when available. Use parallel workers only when the plan's file ownership and dependencies make concurrent work safe; no fixed worker count is part of this contract.
Apply the routing and escalation contract in `context/contracts/execution-contract.md`.

## Provider Boundaries

Use `RepositoryAdapter` for repository, target revision, worktree, and changed-file context. Carry provider-backed work-item, board, and ownership context from `WorkItemProvider`, `BoardProvider`, and `AssignmentProvider` when present. GitHub is an optional adapter, never a required execution contract.

## Inputs

- structured implementation plan and optional host session/artifact location
- Definition Of Done, stable acceptance criteria, task-to-criterion mapping, and required evidence
- sandbox/worktree mode, expected modified files, source revision, and conflict risks

## Procedure

1. Read the plan. Return it to `plan-work` when it lacks a Definition Of Done, stable acceptance criteria, task mapping, sandbox boundary, or usable execution scope.
2. Before delegation, compare the current target revision with the plan's base through `RepositoryAdapter`. Re-ground the plan when changed scope intersects its assumptions; record missing confirmation as `NOT_VERIFIED` rather than treating it as fresh.
3. Before dispatching a wave that delegates work, declare it in the session's wave manifest (`waves.json`, schema `schemas/workflow-waves.schema.json`): `wave_id`, owning step, and one `expected_workers` entry per worker, so the expected worker count (M) exists before any result arrives. Then give each worker its bounded task, owned files, relevant acceptance IDs, required evidence, sandbox/worktree constraints, rollback conditions, and plan reference.
4. Run safe independent tasks concurrently and dependent tasks in order. Between waves, reconcile results against the wave manifest — never collect from memory or prose. Every declared worker must land exactly one terminal status record (`completed`, `failed`, or `blocked`). Record each declared worker that has no terminal record as `not_reported` — never silently absorb a missing worker — then record the wave's `reconciliation` with an explicit "N of M reported" summary naming the `not_reported` workers (for example "2 of 3 reported; worker-3 not_reported"). Treat the wave as complete only when N equals M; an incomplete wave is visible data that routes to re-dispatch, a blocker, or an explicit accepted gap. After reconciliation, resolve conflicts and update the execution record with completed work, remaining work, changed files, and supported acceptance criteria.
5. For UI tasks, include the applicable frontend design guidance in the worker instruction.
6. When implementation completes, record scope integrity: changed files, accepted deviations, task-to-criterion traceability, evidence, and outstanding gaps. Hand off to report-only review and verification; do not treat implementation as verification.
7. Reconcile the execution report and `state.json` with the active session artifact directory.
   Any missing, stale, or unwritable durable record is a blocker or
   `NOT_VERIFIED` gap, not a reason to substitute chat prose. Publish only
   structured, resolving evidence references through the public CLI.

## Execution Record

The execution record must identify:

- each completed task and its supported `AC*` identifiers
- changed files and any scope deviation with approval or route-back reason
- worker evidence, conflicts, rollback notes, remaining work, and next action
- per-wave reconciliation against the manifest: "N of M reported" and any `not_reported` workers with their recovery route
- current revision comparison and re-grounding decision

## Active Builder Evidence

For an active `builder.build` `execute` step, record `implementation-scope` only after the changed-file scope and acceptance mapping are complete:

```bash
flow-agents workflow status --session-dir <session-dir>
flow-agents workflow evidence --session-dir <session-dir> \
  --expectation implementation-scope --status pass \
  --summary "Implementation stayed within recorded scope; changed files and supported acceptance criteria are documented." \
  --evidence-ref-json '{"kind":"artifact","file":"<session-dir>/<slug>--deliver.md","summary":"Execution report with changed scope and acceptance mapping."}' \
  --evidence-ref-json '{"kind":"artifact","file":"<session-dir>/state.json","summary":"Current execution state and canonical next action."}'
```

Use `fail` or `not_verified` when scope integrity is unresolved. A successful
worker report does not override missing changed-file or acceptance mappings. Do
not create a Builder run here or use private writer commands.
