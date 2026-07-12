---
name: "pickup-probe"
description: "Provider-grounded pickup probe used at the Builder design-probe step before planning."
---

# Pickup Probe

Verify that selected work is understood well enough to plan without implementing it.

## Role And Binding

- **Role:** canonical Builder build-step producer and specialized pickup primitive.
- **Binding:** `builder.build` step `design-probe`.
- **Produces:** the pickup-probe section in `<slug>--pull-work.md`, plus `pickup-probe-readiness` and `probe-decisions-or-accepted-gaps` for an active matching run.
- **Standalone no-run behavior:** produce a probe record or conversation summary only. Do not start a Builder run, record Builder evidence, or claim readiness for a non-Builder invocation.

## Contract

- Probe one selected work item or one justified group after `pull-work` and before `plan-work`.
- Reuse the generic `design-probe` interview behavior for unresolved decisions, but own the Builder pickup record and Builder evidence when the matching flow is active.
- Do not implement code, revise the backlog, or turn unknowns into assumed requirements.
- Stop planning when a blocker, contradiction, stale baseline, or material unanswered question lacks an explicit accepted gap.

## Provider Boundaries

Use `WorkItemProvider` for item detail and acceptance criteria, `BoardProvider` for current queue and dependency context, `RepositoryAdapter` for revision and source-scope context, and `AssignmentProvider` for durable ownership. A GitHub adapter is optional; provider-specific URLs, labels, Projects, pull requests, and commands are not required.

## Required Inputs

- selected work-item identifier and `pull-work` artifact
- scope, non-goals, requirements, acceptance criteria, dependencies, and blockers
- provider state, assignment/liveness result, target revision, and baseline freshness
- expected modified files, conflict risks, worktree mode, and sandbox constraints
- existing decisions, unresolved questions, and caller constraints

## Probe Method

1. Re-read the selected item and its upstream artifact. Check that selected identifiers, scope, acceptance criteria, grouping rationale, and next action agree.
2. Confirm goal fit, user or operator outcome, scope, non-goals, acceptance-criteria quality, dependencies, blockers, provider state, assignment, WIP, and conflict context. When drift now makes a selected item `reclaimable`, re-confirm the recorded takeover opt-in and consequence; do not silently carry an earlier opt-in across changed holder or freshness evidence.
3. Check target revision against the recorded base and planning scope. Record whether it is fresh, stale, or `NOT_VERIFIED`; identify changed intersections and acceptance-criteria drift.
4. Identify expected files, sandbox/worktree mode, stop-short risks, and the evidence needed for planning and later verification.
5. Resolve contradictions through the generic one-question-at-a-time probe. Record each decision, unresolved question, accepted gap with consequence, route reason, and next action.
6. Set readiness to `ready`, `needs_more_probe`, or `accepted_gap_ready`. Only the first and explicitly accepted third outcome may hand off to `plan-work`.

## Probe Record

Record:

- selected IDs and grouping decision
- goal fit, scope, non-goals, acceptance-criteria assessment, and provider state
- dependency and revision freshness, baseline, drift, assignment, WIP, and conflict findings
- expected modified files, sandbox/worktree mode, risk, and stop-short risks
- decisions, unresolved questions, accepted gaps, readiness, route reason, and next action

## Active Builder Evidence

Only for the active `builder.build` `design-probe` step, confirm the run and then record both expectations through the public interface:

```bash
flow-agents workflow status --session-dir <session-dir>
flow-agents workflow evidence --session-dir <session-dir> \
  --expectation pickup-probe-readiness --status pass \
  --summary "Pickup probe records goal fit, scope, dependencies, risks, and planning readiness." \
  --evidence-ref-json '{"kind":"artifact","file":"<session-dir>/<slug>--pull-work.md","summary":"Pickup readiness, scope, dependencies, risks, and planning decision."}'
flow-agents workflow evidence --session-dir <session-dir> \
  --expectation probe-decisions-or-accepted-gaps --status pass \
  --summary "Probe decisions and accepted gaps are explicit in the handoff." \
  --evidence-ref-json '{"kind":"artifact","file":"<session-dir>/<slug>--pull-work.md","summary":"Probe decisions, unresolved questions, accepted gaps, route reason, and next action."}'
```

Use `fail` for an unresolved planning blocker and `not_verified` when the record cannot prove an expectation. Do not record either claim outside the active matching step.

## Durable Decision Notes

When probing resolves a reusable domain decision, follow `context/contracts/probe-docs-write-contract.md`: update the existing vocabulary home when necessary, revise or create the topic-keyed decision record, and retain the probe record as provenance. Keep transient provider snapshots, implementation notes, and open questions in the pickup artifact.

## Handoff

Hand `plan-work` the selected references, probe record, provider and baseline summary, decisions, unresolved questions, accepted gaps, expected modified files, conflict risks, sandbox/worktree mode, route reason, and next action. If the record is absent, contradictory, stale without an accepted gap, or not ready, route back to this probe instead of planning.

## Drift And Decision Safeguards

Research drift before asking alignment questions. Record `planned_base_ref`, `planned_base_sha`, current target ref/SHA, commits-since, planned age, changed files, and intersections with `planning_scope_refs`. Classify revision freshness as `fresh`, `drifted`, or `stale`, and material drift as `no_material_drift`, `scope_drift`, `dependency_drift`, `contract_drift`, or `conflict_risk`.

`drifted` may proceed only with a recorded decision or accepted gap. `stale` routes to `idea-to-backlog`. Missing `planned_base_sha` is `NOT_VERIFIED`, never implicitly fresh; an accepted fallback must name the current target ref/SHA plus provider history. When the Builder Probe shape supports resolution hints, record `gap_id: revision_freshness_not_verified`, `claim_id: planning.baseline.current`, the required evidence, and `resolve_at: pickup-probe`.

Challenge existing domain vocabulary before creating terms. A durable decision follows the probe docs-write contract and topic-keyed decision registry; never propose a numbered ADR. Link the probe artifact as provenance. Create a context file only when a resolved reusable term has no existing home.
