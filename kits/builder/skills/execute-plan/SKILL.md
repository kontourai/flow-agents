---
name: "execute-plan"
description: "Parallel execution primitive — plan artifact path to implemented code via tool-worker (x4). Reads plan directly. Updates session file between waves."
---

# Execute

Plan artifact in, implemented code out. Fans out to tool-worker subagents in parallel waves.

## Agents

| Agent | Role |
|---|---|
| tool-worker | Implementation per task spec (up to 4 parallel) |

## Orchestrator Rule

You do not write source files. You read the plan artifact, fan out tasks to tool-worker, and update the session file between waves.

## Shared Contracts

Follow:
- `context/contracts/artifact-contract.md`
- `context/contracts/execution-contract.md`
- `context/contracts/planning-contract.md` for the plan artifact and Definition Of Done
- `context/contracts/sandbox-policy.md`

This skill owns orchestration between waves. The contracts own artifact continuity, worker task expectations, conflict handling, validation expectations, and completion rules.

## Input

- **Plan artifact path**: path to the `-plan.md` file in `.flow-agents/<slug>/`
- **Session file path**: the session file to update with progress

## Workflow

1. Read the plan artifact directly
2. Confirm the plan follows `context/contracts/planning-contract.md`, including `## Definition Of Done`. If missing, return to `plan-work` before implementation.
3. Confirm the plan records an appropriate `sandbox_mode` using `context/contracts/sandbox-policy.md`. If missing, infer the smallest safe mode and record it before delegation.
4. Confirm execution traceability before any worker starts:
   - acceptance criteria have stable ids, preferably matching `acceptance.json`
   - every wave/task lists the acceptance ids it supports
   - the session/deliver file copies or links the criteria and includes a `Requirements Trace` or equivalent mapping
   - each worker prompt includes the relevant acceptance ids and required evidence, not only a loose task title
   - if traceability is missing, update the session file and/or send the plan back for refinement before delegation
5. Set session file `status: executing` and use `npm run workflow:sidecar -- advance-state <artifact-dir> --status in_progress --phase execution --summary ... --next-action ...` when the repository provides it
6. **Frontend design check:** If any tasks involve UI, CSS, layouts, components, or visual design, read the `frontend-design` skill and include its aesthetics guidelines in the tool-worker prompts for those tasks
7. **Before fan-out, run the [Pre-Fan-Out Freshness Re-Check](#pre-fan-out-freshness-re-check) and re-ground if the plan is stale.** Then fan out each wave to tool-worker subagents (up to 4 parallel):
   - Delegate to the exact `tool-worker` role for every implementation worker. Do not spawn unnamed/default implementation agents.
   ```
   Each tool-worker gets:
   - Task description from plan
   - Files to create/modify
   - Acceptance criteria
   - Acceptance criterion ids and requirement ids this task supports
   - Required evidence for those criteria
   - Definition Of Done items that this task supports
   - Sandbox mode, approval assumptions, rollback expectations, and escalation stop conditions
   - Context from plan + prior wave results
   - Plan artifact path (so it can read full context directly)
   ```
8. Between waves:
   - Collect results from all tool-worker subagents
   - Check for conflicts before next wave
   - Feed completed wave context forward
   - **Checkpoint**: update session file with completed tasks and next wave
   - Record worker progress with `npm run workflow:sidecar -- record-agent-event --artifact-dir <artifact-dir> --agent-id <worker-id> --kind evidence --status active|done --summary ...`
9. After all waves: set session file `status: executed` and update `state.json` / `handoff.json` with `advance-state`

The orchestrator owns root `state.json` updates. Workers should receive the workflow artifact root explicitly and append agent events under that root instead of inferring the slug or rewriting shared sidecars.

## Pre-Fan-Out Freshness Re-Check

A plan can go stale between planning and execution — upstream may have advanced, or the plan may simply be old. `plan-work` and `pull-work` stamp and check `planned_base_sha` / `revision_freshness` at planning and pickup; this is the same check at the **execution boundary**, where stale plans actually cause wasted work (parallel workers building what already landed upstream). Run it before any worker starts.

- **Always — cheap SHA tripwire.** Re-fetch the target ref and compare the current target SHA to the plan's `planned_base_sha` (per `context/contracts/planning-contract.md`). If the base moved **and** the newer commits/files intersect `planning_scope_refs`, the plan is stale: do not fan out. Route back to `plan-work` (or `pickup-probe` for provider-backed work) to re-ground against the current base — the same `revision_freshness: stale` rule plan-work and pull-work already enforce. Missing `planned_base_sha` is not fresh; record a `NOT_VERIFIED` gap and confirm the base before fan-out.
- **On plan age — deeper re-survey.** If the plan is older than the staleness window (default ~1h; shorter for fast-moving scope), do the costlier relook the SHA diff cannot: re-survey what now exists in the target area (recently merged PRs, new modules, sibling work) for anything that already does what this plan proposes. If it already shipped upstream, stop and route back to `plan-work` rather than building a duplicate. The SHA tripwire is the precise signal; plan age is the backstop for landscape drift the diff can't see.
- Record the re-check result (`fresh`, or re-grounded with the compared SHAs and route-back) in the session file before continuing. Worktree/isolation needs stay owned by `pull-work`'s file-overlap decision — don't re-derive them here.

## Session File Updates

Between each wave, append to the session file:

```markdown
## Execution Progress

### Wave 1 (completed)
- [x] Task A — done. Supports: AC1, AC2. Evidence: <test/check/artifact>. Modified files: `<path>`.
- [x] Task B — done. Supports: AC3. Evidence: <test/check/artifact>. Modified files: `<path>`.

### Wave 2 (in progress)
- [ ] Task C. Supports: AC4, AC5. Required evidence: <test/check/artifact>.
- [ ] Task D. Supports: AC6. Required evidence: <test/check/artifact>.

## Requirements Trace

- R1 <requirement>. Acceptance: AC1, AC2.
- R2 <requirement>. Acceptance: AC3.

## Modified Files / Scope

- Record changed paths in the session/deliver artifact and worker event summaries after each wave.
- Do not add ad hoc `modified_files` keys to `state.json` unless the sidecar schema explicitly supports them.
- Verification and optional governance providers such as Veritas should consume this scope from the session/evidence artifacts or a dedicated evidence sidecar, not from invalid state fields.
```

This is the recovery point. If context is lost, a new session reads this and knows which waves are done.

## Output

- Implemented code in the working directory
- Session file updated with execution progress and `status: executed`
- Execution progress follows `context/contracts/execution-contract.md`
- Structured state/handoff sidecars advanced when `npm run workflow:sidecar --` is available

If `advance-state` or artifact validation is unavailable or blocked, record that exact blocker in the session file and do not mark execution as cleanly complete.

{context?}
