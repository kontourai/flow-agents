---
name: "plan-work"
description: "Code planning primitive that turns a goal and directory into a structured implementation plan."
---

# Plan Work

Turn a bounded goal into an execution-ready plan. This skill plans; it does not implement or resume a Builder run.

## Role And Binding

- **Role:** canonical Builder build-step producer and standalone planning primitive.
- **Binding:** `builder.build` step `plan`.
- **Produces:** `<slug>--plan-work.md`, `acceptance.json`, `handoff.json`, and `implementation-plan` for an active matching run.
- **Standalone no-run behavior:** return a plan artifact without starting a Builder run, recording Builder evidence, or claiming the Builder prefix completed.

## Model Routing

Delegate codebase analysis and plan writing to `tool-planner`. Resolve `delegate-design` from `.datum/config.json`; when unavailable, inherit the session model and record the fallback.
Apply the routing and escalation contract in `context/contracts/execution-contract.md`.

## Provider Boundaries

For provider-backed planning, consume context supplied by `WorkItemProvider`, `BoardProvider`, `RepositoryAdapter`, and `AssignmentProvider`. Do not assume a GitHub issue, pull request, branch convention, or provider-specific API. GitHub may be an optional adapter example only.

## Inputs

- goal, working directory, and user or repository constraints
- optional selected-work and pickup-probe records for provider-backed work
- source revision, dependency, acceptance-criteria, sandbox, worktree, and conflict context when available

## Research And Readiness

1. Search the codebase for existing behavior and patterns. Use `search-first` when the work adds a capability that may already exist elsewhere.
2. Before adding a type, schema, artifact, status, or algorithm, inspect existing contracts and dependency exports. Consume canonical concepts instead of creating parallel ones.
3. For Builder-backed work, require a fresh pickup record with selected IDs, readiness, grouping decision, decisions or accepted gaps, expected modified files, conflict risks, route reason, and next action. Route a missing or contradictory record to `pickup-probe`.
4. Carry forward revision freshness, target ref/SHA, planned base, source-scope intersections, dependency state, acceptance-criteria drift, and accepted fallback baseline. A stale or unaccepted unknown baseline stops planning.

## Plan Contract

Ask `tool-planner` to produce an implementation plan containing:

- goal, constraints, repository context, source revision, and accepted gaps
- files or surfaces to change, sequence of work, dependencies, and rollback boundaries
- `## Definition Of Done`, including stop-short risks and durable documentation target
- stable acceptance criteria and a mapping from every task or wave to the criteria it supports
- expected command/test evidence and structured source evidence for behavior changes
- sandbox mode, escalation conditions, expected modified files, and conflict handling
- execution handoff and next action

Require evidence that is proportionate to the change and named by the accepted criteria.

## Procedure

1. Resolve the artifact location through the host contract when one exists. In an active Builder run, write `<slug>--plan-work.md`, update `acceptance.json` with the stable criteria and evidence plan, and update `handoff.json` with the execution target and next action.
2. Delegate the goal, directory, constraints, research findings, pickup context, and evidence requirements to `tool-planner`.
3. Read the returned plan. Send it back for refinement when task-to-criterion traceability, scope, stop-short risks, or evidence expectations are missing.
4. Present the plan when a user decision is needed; otherwise hand the plan to `execute-plan` only when the caller requests execution.

## Active Builder Evidence

This skill does not create or restamp a Builder run. For an already active `builder.build` `plan` step, confirm the run and record the completed plan through the public interface:

```bash
flow-agents workflow status --session-dir <session-dir>
flow-agents workflow evidence --session-dir <session-dir> \
  --expectation implementation-plan --status pass \
  --summary "Implementation plan records scope, sequencing, acceptance criteria, and required evidence." \
  --evidence-ref-json '{"kind":"artifact","file":"<session-dir>/<slug>--plan-work.md","summary":"Execution-ready plan with Definition Of Done and task-to-criterion mapping."}' \
  --evidence-ref-json '{"kind":"artifact","file":"<session-dir>/acceptance.json","summary":"Stable acceptance criteria and evidence requirements."}' \
  --evidence-ref-json '{"kind":"artifact","file":"<session-dir>/handoff.json","summary":"Execution handoff, route reason, and next action."}'
```

Use `fail` or `not_verified` when the plan is incomplete or cannot be evidenced. Do not enter `builder.build` at this step directly and do not use private writer commands.

## Baseline And Evidence Safeguards

Follow `context/contracts/planning-contract.md`, `context/contracts/artifact-contract.md`, and `context/contracts/sandbox-policy.md`. In an active Builder run, consume the recorded pickup Probe decisions, accepted gaps, expected modified files, conflict risks, grouping decision, route reason, and `revision_freshness`; direct standalone planning does not require Builder-specific Probe state.

For provider-backed work, require the current target ref/SHA and revalidate each upstream AC id against drift. Record stale assumptions. Missing `planned_base_sha` is never fresh. If baseline freshness is missing or `NOT_VERIFIED`, stop unless an accepted fallback baseline names the current target ref/SHA plus provider history. `stale` shaped work routes to `idea-to-backlog`; missing pickup decisions route to `pickup-probe`.

Behavior-changing plans require structured evidence ref objects and an `Acceptance Evidence` table mapping AC ids to command/test evidence, source evidence, and gaps. A plan must not be handed to execution when Definition Of Done, Stop-short risks, Durable docs target, sandbox mode, or task-to-AC traceability is missing.
