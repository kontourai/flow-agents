---
name: "plan-work"
description: "Code planning primitive — goal + directory to structured execution plan. Delegates to tool-planner. No resume, no ideation."
---

# Plan

Goal + directory in, structured plan artifact out. Pure planning primitive.

## Agents

| Agent | Role |
|---|---|
| tool-planner | Codebase analysis, structured execution plan, writes plan artifact |

## Orchestrator Rule

You do not read source files. You delegate to tool-planner and read the artifact it produces.

## Shared Contracts

Follow:
- `context/contracts/artifact-contract.md`
- `context/contracts/planning-contract.md`
- `context/contracts/sandbox-policy.md`

This skill owns orchestration. The contracts own the required artifact shape, Definition Of Done, acceptance criteria, sandbox mode, evidence expectations, and stop-short risk rules.

## Pre-Planning: Research

Before delegating to tool-planner, check if the goal can be solved with existing tools or libraries:
1. Search the current codebase for similar functionality
2. If the goal involves adding new capabilities, invoke the search-first skill
3. Pass research findings to tool-planner as additional context

**Survey existing concepts before designing new ones.** Before the plan introduces a new
artifact, schema, type, data shape, status, or derivation/algorithm, check what the project's
**dependencies and contracts already define** — not just the local codebase. Inspect exported
types, schemas, and builders from dependencies (e.g. `@kontourai/*` packages and vendored
schemas) and the resource/data contracts under `context/contracts/`. Prefer **consuming the
canonical concept over inventing a parallel one**: follow existing patterns, understand the
dependency surface, and leverage existing concepts. If a planned shape resembles a dependency's
existing concept, consume theirs and record which one. This operationalizes the consume-never-fork
guardrail of ADR 0008 and ADR 0010 at planning time — the cheapest place to catch a fork.

Skip the codebase-similarity search for pure bug-fix/refactor goals, but still apply the
survey-existing-concepts check whenever the plan would add a new shape or algorithm.

## Input

The orchestrator (or user) provides:
- **Goal**: what to build or change
- **Directory**: working directory for the codebase
- **Constraints**: from AGENTS.md, user preferences, conversation context
- **Session file path** (optional): if part of a larger workflow, the orchestrator passes this

Direct `plan-work` remains a standalone planning primitive. Do not require Builder Kit pickup Probe state for ordinary direct planning prompts unless the user is trying to pick up provider-backed backlog work or continue a productized build/delivery workflow.

When `plan-work` is invoked from the Builder Kit `build` flow, from `deliver`, or from a pick-up-and-build request after `pull-work`, first read the recorded pickup Probe decisions, unresolved questions, accepted gaps, sandbox/worktree mode, expected modified files, and conflict risks from the pull-work or handoff artifact. If the handoff lacks required Probe decisions or explicitly accepted gaps, stop planning and route `decision_gap` back to `design-probe`; for pickup/planning gaps, that means returning to the pickup Probe before retrying planning.

Only consume Builder Kit Probe `resolution_hints` in those Builder Kit build/deliver/pickup contexts. Direct primitive `plan-work` remains valid without Builder Kit-specific `resolution_hints`; do not require or synthesize them for ordinary planning requests.

Required Builder Kit handoff fields before planning:

- `probe_status` is `passed` or `accepted_gap`
- `probe_artifact_ref` points to the pickup Probe record
- selected item ids are present
- grouping decision is `single-item`, `independent-items`, or `justified-bundle`
- accepted gaps, expected modified files, conflict risks, route reason, and next action are recorded

If the handoff came from stale broad continuation language after a previous merge, treat it as missing Probe evidence and route back to `design-probe` / `pickup-probe`. Do not infer permission to plan the next item from a previous continuation instruction.

## Provider-Backed Baseline Preflight

For provider-backed backlog work, `plan-work` consumes freshness context; it does not classify revision freshness itself. Before delegating to `tool-planner`, read the pull-work or pickup Probe artifact and carry forward:

- `revision_freshness` from the upstream artifact
- current target ref/SHA confirmed from the latest provider or repository state available to pull-work/pickup Probe
- `planned_base_ref` and `planned_base_sha` when present
- accepted gaps, including any accepted-gap baseline for missing historical `planned_base_sha`
- Builder Kit Probe `resolution_hints` for `revision_freshness_not_verified` when the invocation came through Builder Kit build/deliver/pickup, especially hints for `planning.baseline.current`
- changed scope intersections with `planning_scope_refs`, contracts, dependencies, expected files, or execution areas
- dependency freshness and provider state, including blockers, PR links, board/project membership, and any `NOT_VERIFIED` checks

If `revision_freshness` is `stale`, unresolved, missing without an accepted gap, or contradicted by dependency/provider state, stop planning. Route pickup/planning gaps back to `pickup-probe`; when `revision_freshness` is `stale`, route stale shaped work back to `idea-to-backlog` instead of handing the item to `tool-planner`.

An explicit accepted-gap fallback baseline may allow planning to proceed, but it must name the fallback baseline used. Missing `planned_base_sha` is never fresh by itself. If baseline freshness is missing or `NOT_VERIFIED`, record the gap and stop planning unless it has been explicitly accepted as a fallback baseline naming the current target ref/SHA plus provider history or equivalent.

For Builder Kit `resolution_hints` with `gap_id: revision_freshness_not_verified` and `claim_id: planning.baseline.current`, carry the accepted fallback baseline into the plan's baseline section exactly enough for execution and verification to recover it. If the missing baseline evidence does not include an explicit accepted fallback baseline, do not pass the item to `tool-planner`; route back to `pickup-probe` so the Probe can collect evidence or record the accepted gap.

The `tool-planner` prompt context must include the latest-base confirmation and acceptance-criteria drift findings:

- the current target ref/SHA that planning is based on
- the source freshness state or accepted-gap baseline
- each upstream AC id revalidated against drift
- stale assumptions found during revalidation
- any route-back decision already taken or still required

## Workflow

1. Create session file in `.flow-agents/<slug>/` if one wasn't provided:
   - Filename: `<slug>--plan-work.md`
   - `status: planning`, `type: plan-work`
   - Create or update `state.json` with phase `planning`
   - use `npm run workflow:sidecar -- ensure-session --source-request ... --summary ... --criterion ...` when the repository provides it; this also writes `.flow-agents/current.json`
2. Delegate to `tool-planner`:
   ```
   Goal: <goal>
   Directory: <working directory>
   Constraints: <constraints>
   todo_file: <session file path>
   Workflow artifact root: <path from npm run workflow:sidecar -- current --format path>
   Latest-base confirmation: <current target ref/SHA, revision_freshness, planned base or accepted-gap baseline>
   AC drift findings: <per-AC revalidation, stale assumptions, route-back decisions>
   Evidence expectations: preserve AC ids; require command/test evidence and structured source refs for implementation behavior; require provider/closure `Acceptance Evidence` tables when comments claim behavior
   ```
3. tool-planner explores the codebase and writes the plan to the artifact file:
   - `<session-basename>-plan.md`
   - `acceptance.json` with pending criteria from Definition Of Done
   - `handoff.json` with the execution/user-approval next steps
   - use `npm run workflow:sidecar -- init-plan <artifact> --source-request ... --summary ... --next-action ...` when the repository provides it
   - every acceptance criterion should have a stable id, either in Markdown or mirrored in `acceptance.json`
   - every implementation task/wave should list which acceptance criterion ids it supports
   - acceptance criteria for behavior changes should name expected command/test proof and expected source evidence refs or permalink upgrade expectations
   - `acceptance.json` evidence refs must be structured objects, not legacy strings
   - if task-to-acceptance mapping is unclear, send the planner feedback before presenting the plan as ready
4. Read the plan artifact
5. Update session file: paste plan summary into `## Plan`, set `status: planned`
6. Update `state.json` with `status: planned`, phase `planning`, and the next action
7. Present the plan to the user
8. If the user wants changes, re-delegate to tool-planner with feedback

Never rely on conversational memory for the slug. Resolve the active artifact with `npm run workflow:sidecar -- current --format path` and pass that path to delegated agents.

## Definition Of Done Contract

Every plan artifact must include the `## Definition Of Done` defined in `context/contracts/planning-contract.md`, including `Stop-short risks` and `Durable docs target`. If the goal is exploratory or uncertain, the plan must still name what the user should be able to take away from the work. Do not let acceptance criteria stop at implementation tasks.

Every non-trivial implementation plan must include traceability from requirements to acceptance criteria to execution tasks. At minimum, acceptance criteria need stable ids and each wave/task needs a `Supports:` line referencing those ids. Loose wave names without criterion references are not execution-ready.

Every behavior-changing plan must also include evidence traceability expectations. The Definition Of Done should tell workers and verifiers which command/test evidence is expected and which source evidence refs should support claimed behavior. Source refs use the structured evidence ref object from `context/contracts/artifact-contract.md`; before publication they may be local file/line/excerpt refs, and provider-facing comments should upgrade them to immutable GitHub blob permalinks pinned to a commit SHA when available. Plans that expect provider, PR, issue, closure, or final acceptance comments must require an `Acceptance Evidence` table with columns `AC id`, `Status`, `Command/Test Evidence`, `Source Evidence / Permalinks`, and `Gaps`.

Every plan artifact must also record `Sandbox mode` using `context/contracts/sandbox-policy.md`. If the needed mode is unclear, choose the smallest safe mode for the plan and list the escalation condition that would require a stronger boundary.

## Structured Sidecars

Follow `context/contracts/artifact-contract.md` and `context/contracts/planning-contract.md`.

When `npm run workflow:sidecar --` exists, structured sidecars are not optional ceremony. Use the writer commands above, then validate the artifact directory when local validation is available. If the writer is unavailable or blocked, preserve the exact blocker in the Markdown artifact as a `NOT_VERIFIED` gap.

Planning owns:

- `state.json`: current phase/status and next action
- `acceptance.json`: criteria from the Definition Of Done, initially `pending`
- `handoff.json`: summary and execution/user-approval next steps

If a target harness cannot write sidecars, record `NOT_VERIFIED` or an explicit gap in the session file instead of pretending the structured state exists.

## Session File Format

```markdown
# <Goal one-liner>

branch: <branch>
worktree: <worktree>
created: <date>
status: planning | planned
type: plan-work

## Plan

Structured plan from tool-planner (pasted from artifact).

## Definition Of Done

Copied from the plan artifact. This is the stop condition for delivery.
```

## Output

- Session file in `.flow-agents/<slug>/` with status `planned`
- Plan artifact: `<session-basename>-plan.md`
- Structured sidecars: `state.json`, `acceptance.json`, and `handoff.json`
- The plan artifact is the source of truth — tool-worker agents read it directly
- Plan artifact follows `context/contracts/planning-contract.md`

{context?}
