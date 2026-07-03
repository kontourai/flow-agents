# Builder Kit Workflow State Contract

This contract defines the durable routing state for Builder Kit build-flow pickup and resume. It keeps `state.json` limited to canonical Flow Agents workflow routing and stores rich pickup decisions in a documented Probe record sidecar referenced by `state.json`, `handoff.json`, and the session artifact.

Builder Kit owns product-level build-flow coordination. Flow Agents owns the workflow harness, artifact conventions, primitive execution, and evidence gates. Flow remains the owner of Flow gate semantics. Builder Kit contracts may route to Flow Agents primitives, but must not redefine pass, fail, approval, or release authority semantics.

## State Surfaces

Builder Kit routing uses these surfaces together:

| Surface | Owner | Purpose |
| --- | --- | --- |
| `state.json` | Flow Agents workflow state | Durable current phase, status, next action, and routing target. |
| `handoff.json` | Flow Agents handoff | Human and machine-readable pause, resume, delegation, or blocker summary. |
| Builder Kit Probe record | Builder Kit contract sidecar | Rich pickup/design decisions used to choose the next build-flow step. |
| session artifact | active orchestrator or worker | Human-readable execution progress, modified files, evidence, and links. |
| plan, acceptance, evidence, critique, release, learning sidecars | phase owners | Phase-specific gates and proof. |

`state.json` must not be overloaded with detailed Probe decisions. It should reference the Probe record path in `artifact_paths` or `next_action.target_artifact` when the Probe record is the target for resuming or deciding the next step. `handoff.json` should also reference the Probe record whenever a paused Builder Kit build-flow cannot be resumed correctly from `state.json` alone.

## Required Routing Fields

Every Builder Kit build-flow pause, resume, or step transition must make the following fields recoverable from artifacts alone.

| Field | Durable location | Required meaning |
| --- | --- | --- |
| current step | `state.phase`, `state.status`, and Probe record `current_step` | The current Builder Kit step or direct Flow Agents primitive. |
| branch | `state.json.branch`; seeded in the session Markdown's `branch:` line | The `agent/<actor>/<slug>` routing branch `ensure-session` derives for a new session (optional field for migration honesty — see `schemas/workflow-state.schema.json`); an explicit `--branch` overrides; an existing session's already-recorded branch is never re-derived (see [ADR 0021](../../docs/adr/0021-assignment-leases-and-stale-claim-takeover.md) §3 and §5). |
| next step | `state.next_action` and Probe record `next_step` | The next step to run after resume or after the current primitive exits. |
| route reason | Probe record `route_reason`; summarized in `state.next_action.summary` | Why this route was selected, including missing state, evidence, decisions, or blockers. |
| selected work item refs | Probe record `selected_work_items`; optionally linked in `handoff.json` | Neutral work item references from the work-item contract. |
| missing evidence | Probe record `missing_evidence`; evidence sidecar for verification gaps | Evidence needed before planning, execution, verification, or release can proceed. |
| unresolved questions | Probe record `unresolved_questions`; handoff summary when user input is needed | Open decisions that block or shape the next step. |
| accepted gaps | Probe record `accepted_gaps`; acceptance sidecar when tied to criteria | Known gaps explicitly accepted for this iteration. |
| resume prompt | Probe record `resume_prompt`; handoff summary for future sessions | The concise instruction needed to resume without chat memory. |
| artifact references | `state.artifact_paths`, `state.next_action.target_artifact`, handoff refs, and Probe record `artifact_refs` | Paths to sidecars, plans, evidence, source refs, and docs needed for pickup. |
| automation mode | Probe record `automation_mode` and route reason | The active Builder Kit automation boundary: `manual`, `guided`, `strict`, or `autonomous-bounded`. |
| recovery mode | Probe record `recovery_mode` | Whether the workflow came from a direct primitive invocation or Builder Kit build-flow recovery. |
| probe status | Probe record `probe_status` and handoff summary | Machine-checkable pickup Probe outcome: `missing`, `required`, `in_progress`, `passed`, `accepted_gap`, or `blocked`. |
| probe artifact ref | Probe record `probe_artifact_ref` | The artifact or sidecar path that contains the current pickup Probe evidence. |
| grouping decision | Probe record `grouping_decision` | Whether selected work is a single item, independent multi-item set, justified bundle, unsafe group, or empty board. |
| WIP/shepherding decision | pull-work artifact `wip_assessment`, `my_active_work`, `shepherding_candidates`, `stale_worktrees`, `open_prs_by_me`, `global_conflicts`, `dependency_impacts`, and `start_new_work_decision` | Whether starting new work is appropriate or whether existing personal work should be shepherded first. |
| worktree lifecycle | pull-work artifact `worktree_lifecycle`; handoff summary when cleanup is pending | How long an isolated worktree should be retained, who owns cleanup, and which command removes it after merge/abandonment. |
| Flow boundary | Probe record `flow_boundary` | Explicit preservation of Flow gate authority and Flow Agents harness ownership. |

## Probe Record

A Builder Kit Probe record is a JSON sidecar beside the other workflow artifacts, for example `.kontourai/flow-agents/<slug>/builder-kit-probe.json`. It is the durable location for pickup/design context that would otherwise make `state.json` too broad.

Required shape:

```json
{
  "schema_version": "1.0",
  "task_slug": "example-task",
  "current_step": "design-probe",
  "next_step": "plan-work",
  "route_reason": "selected work item has enough evidence and no unresolved blocking questions",
  "automation_mode": "guided",
  "recovery_mode": "builder-kit-build-flow",
  "probe_status": "passed",
  "probe_artifact_ref": ".flow-agents/example-task/builder-kit-probe.json",
  "grouping_decision": {
    "status": "single-item",
    "justification": "one selected work item"
  },
  "selected_work_items": [
    {
      "provider": "github",
      "ref": "#68",
      "title": "Builder Kit workflow state contract"
    }
  ],
  "missing_evidence": [],
  "unresolved_questions": [],
  "accepted_gaps": [],
  "resolution_hints": [],
  "resume_prompt": "Resume Builder Kit build-flow by running plan-work from the selected work item and Probe record.",
  "artifact_refs": [
    ".flow-agents/example-task/state.json",
    ".flow-agents/example-task/handoff.json"
  ],
  "flow_boundary": {
    "builder_kit_owns": "product-level build-flow coordination and next-step selection",
    "flow_agents_owns": "workflow artifacts, primitive execution, and evidence harness",
    "flow_owns": "gate authority semantics"
  }
}
```

Allowed `current_step` and `next_step` values are Builder Kit step names or direct Flow Agents primitive names. Use `pull-work`, `design-probe`, `pickup-probe`, `plan-work`, `execute-plan`, `verify-work`, `evidence-gate`, `release-readiness`, `learning-review`, `blocked`, or `done` unless a downstream contract defines a narrower Builder Kit flow. The Builder Kit flow step remains `design-probe`; `pickup-probe` is the Builder Kit specialization record or skill used to prepare a selected work item for planning.

`selected_work_items` should use the neutral fields from `context/contracts/work-item-contract.md` where available. Provider-specific IDs may be included, but routing must not depend on a provider-specific shape when the neutral reference is present.

## Resolution Hints

Builder Kit Probe records may include optional `resolution_hints` for missing evidence, `NOT_VERIFIED`, or accepted-gap readiness states. Use them when Builder Kit can name the blocked readiness claim, deterministic blocked references, required evidence, and the step that should resolve the gap. Omit them when the Probe record has no actionable readiness gap or when a direct Flow Agents primitive has all inputs needed without Builder Kit build-flow context.

The canonical machine storage for `resolution_hints` is the Builder Kit Probe JSON record. Markdown pull-work, pickup, plan, or session artifacts may summarize the hints or link to the Probe record for humans, but they are not a second machine contract and must not introduce divergent machine-readable hint shapes.

Stable hint fields:

| Field | Meaning |
| --- | --- |
| `gap_id` | Stable identifier for the gap class Builder Kit is describing, such as `revision_freshness_not_verified`. |
| `claim_id` | Builder Kit-owned readiness claim affected by the gap, such as `planning.baseline.current`. This is not a Flow gate schema or Veritas claim requirement. |
| `reason_code` | Stable reason the claim is missing, inconclusive, `NOT_VERIFIED`, or accepted as a gap. |
| `blocked_refs[]` | Deterministic references blocked by the gap. Entries should be objects with stable `kind` and `id` values, for example `acceptance_criterion` / `AC2`, `workflow_gate` / `plan-work.readiness`, and `flow_step` / `builder.build.plan`. |
| `resolve_at` | The Builder Kit or Flow Agents step expected to resolve or explicitly accept the gap. Use an object with at least `step`; include `owner` or `artifact` when useful. |
| `required_evidence[]` | Evidence records needed to resolve the claim. Entries should have stable ids, a short description, and expected source or artifact refs when known. |
| `fallback_policy_id` | Stable policy id for an explicitly accepted fallback path when fresh evidence cannot be recovered for this iteration. The fallback is an accepted gap, not proof that the missing evidence is fresh. |
| `summary` | Human-readable summary of what is blocked and how to resolve it. |

Baseline freshness example for missing historical `planned_base_sha`:

```json
{
  "probe_status": "accepted_gap",
  "accepted_gaps": [
    {
      "gap_id": "revision_freshness_not_verified",
      "claim_id": "planning.baseline.current",
      "reason_code": "missing_planned_base_sha",
      "summary": "Historical planned_base_sha was not recorded; current main and provider history are accepted as the fallback baseline for this iteration."
    }
  ],
  "resolution_hints": [
    {
      "gap_id": "revision_freshness_not_verified",
      "claim_id": "planning.baseline.current",
      "reason_code": "missing_planned_base_sha",
      "blocked_refs": [
        {
          "kind": "acceptance_criterion",
          "id": "AC2"
        },
        {
          "kind": "workflow_gate",
          "id": "plan-work.readiness"
        },
        {
          "kind": "flow_step",
          "id": "builder.build.plan"
        }
      ],
      "resolve_at": {
        "step": "pickup-probe",
        "owner": "builder-kit"
      },
      "required_evidence": [
        {
          "id": "current_target_ref",
          "description": "Current target branch or ref recorded during pickup.",
          "source": "pull-work provider scan or local git baseline",
          "example_value": "main"
        },
        {
          "id": "current_target_sha",
          "description": "Current target commit SHA recorded during pickup.",
          "source": "pull-work provider scan or local git baseline",
          "example_value": "73f050b275290838a5b8f3a5a1e9eb8715830c46"
        },
        {
          "id": "provider_history",
          "description": "Provider issue/project history or equivalent source proving the selected work context inspected during pickup.",
          "source": "provider adapter output",
          "example_value": ".flow-agents/builder-kit-not-verified-resolution-hints/builder-kit-not-verified-resolution-hints--pull-work.md"
        },
        {
          "id": "source_artifact",
          "description": "Source shaped artifact or pickup artifact used to accept the fallback baseline.",
          "source": ".kontourai/flow-agents/<slug>/<slug>--idea-to-backlog.md",
          "example_value": ".flow-agents/builder-kit-not-verified-resolution-hints/builder-kit-not-verified-resolution-hints--idea-to-backlog.md"
        }
      ],
      "fallback_policy_id": "accepted_fallback_baseline.current_target_plus_provider_history",
      "summary": "Resolve missing planned_base_sha at pickup-probe by recording the current target ref and SHA, provider history/source artifact evidence, and the accepted fallback baseline policy before planning."
    }
  ]
}
```

This example is intentionally limited to baseline freshness for missing or inconclusive `planned_base_sha`. It does not make the fallback baseline fresh planned evidence; it records an accepted Builder Kit readiness gap with deterministic repair guidance.

Boundary and non-goal rules:

- Builder Kit owns readiness guidance, including optional `resolution_hints`, Builder Kit `claim_id` names, and product-flow next-step selection.
- Flow Agents owns workflow artifacts, sidecars, primitive execution, modified-file recording, and evidence harness behavior.
- Flow owns gate semantics. `resolution_hints` must not redefine Flow pass, fail, approval, release, or route-back authority.
- Veritas remains optional evidence. A hint may reference Veritas output when present, but Builder Kit Probe records must not require Veritas schemas or duplicate Veritas policy contracts.
- Generic Flow Agents sidecar schemas, including `schemas/workflow-evidence.schema.json`, are not extended by this Builder Kit field.
- Direct primitive workflows remain valid without Builder Kit-specific `resolution_hints`.

## Product Flow Chaining And Primitive Stopping

Product-level Builder Kit flows may guide the next step; direct primitives must not surprise the user by auto-continuing.

- `builder-shape` is the product-level shape entry point. It delegates to `idea-to-backlog` without requiring the user to name that primitive, then stops at the backlog gate unless issue sync or continuation was explicitly requested.
- Builder Kit `build` is the product-level build entry point. It may guide `pull-work -> design-probe / pickup-probe -> plan-work` when the user asked for the Builder Kit build flow.
- Direct `idea-to-backlog`, direct `pull-work`, and direct `plan-work` remain standalone primitives. They record state and report the expected next step, but they do not auto-continue merely because a product flow exists.
- If a direct primitive is invoked with missing upstream Builder Kit state, it must explain the missing pre-step and offer the product-level entry point or the correct previous primitive instead of fabricating state.
- If the user declines guided continuation, record `automation_mode: "manual"` and the expected `next_step` in the Probe record or handoff.

## Pull Work WIP And Worktree Lifecycle

Builder Kit build pickup must not treat all active work equally. `pull-work` records two separate views before selecting new work:

- Personal WIP controls whether new work should start. This includes the current user's dirty worktrees, local branches, open PRs, active sidecars, review/verification/release decisions, and stale worktrees.
- Global work informs safety and priority. Work by others blocks only when it creates file-scope conflict, dependency, sequencing, release-lane, provider-state, or artifact-contract risk.

The pull-work artifact must record:

- `my_active_work`
- `shepherding_candidates`
- `stale_worktrees`
- `open_prs_by_me`
- `global_conflicts`
- `dependency_impacts`
- `start_new_work_decision`

`start_new_work_decision` is the durable gate for pickup. Use `proceed` only when personal WIP is within policy and global risks are recorded or accepted. Use `shepherd_existing`, `cleanup_required`, `blocked`, or `needs_user` when existing work, stale worktrees, unresolved PRs, or decisions should be handled first.

When a worktree is selected, the artifact must also record `worktree_lifecycle`:

- path
- branch
- retain-until condition: PR merged, branch abandoned, or user override
- cleanup owner
- cleanup command
- cleanup blockers such as open PR, pending review, pending CI, dirty files, unpublished commits, or user decision

Publish-change retains the worktree so review, CI, and follow-up fixes can happen in the same isolated checkout. Final acceptance, release cleanup, or explicit abandonment owns `git worktree remove <path>` and any branch deletion when safe. Files should not be copied back to a main checkout by hand.

## Automation Modes

Builder Kit routing must record one automation mode:

| Mode | Boundary |
| --- | --- |
| `manual` | Surface state, recommendations, and resume prompt only. Do not advance to the next primitive without explicit user instruction. |
| `guided` | Recommend and prepare the next step. Ask before crossing from Probe/design into planning or execution when unresolved questions or missing evidence remain. |
| `strict` | Advance only when all required artifacts, evidence, conflict checks, and acceptance inputs are present. Missing upstream state routes to `decision_gap` through `design-probe`. |
| `autonomous-bounded` | Advance within the approved work item, file ownership, sandbox, and Definition of Done boundaries. Stop for scope expansion, missing gate evidence, destructive actions, or Flow authority decisions. |

Mode changes must be explicit in the Probe record route reason or handoff. A stricter mode may stop earlier than the table permits. A looser mode must not bypass Flow Agents evidence gates or Flow authority.

## Direct Primitive Recovery

Direct primitive invocation remains valid. A user or orchestrator may call `pull-work`, `plan-work`, `execute-plan`, `verify-work`, or another primitive without Builder Kit build-flow state.

When a direct primitive has sufficient required inputs, it should proceed according to that primitive's own contract and update the standard Flow Agents artifacts. It may create a Probe record only if Builder Kit resume will need richer pickup context.

When Builder Kit build-flow recovery detects missing upstream state, selected work item evidence, or unresolved route decisions, it must distinguish that from direct primitive use:

| Scenario | Required route |
| --- | --- |
| Direct primitive has complete primitive inputs | Continue the primitive and record standard state/handoff. |
| Direct primitive lacks required primitive inputs | Mark `state.next_action.status` as `needs_user` or `blocked` and summarize the missing input. |
| Builder Kit build-flow lacks selected work item or design context | Route `decision_gap` to `design-probe` in the Probe record and summarize that in `state.next_action`. |
| Builder Kit build-flow has selected work item but incomplete pickup evidence | Route to `pickup-probe` or `design-probe` with `missing_evidence` populated. |
| Builder Kit build-flow has complete pickup context | Route to `plan-work` with the Probe record and selected work item refs linked. |

`decision_gap` is a route reason, not a new `state.phase`. Use the existing `pickup` or `planning` phase as appropriate and put the detailed reason in the Probe record.

Primitive recovery prompts should name the next intended step. Examples:

- Missing backlog item: "This needs Builder Kit shape / idea-to-backlog before pull-work can select executable work."
- Missing pickup Probe: "This Builder Kit build-flow plan request lacks pickup Probe evidence; route `decision_gap -> design-probe` and complete `pickup-probe` before planning."
- Manual mode: "Direct primitive mode selected; next expected step is `plan-work` after you approve the recorded handoff."

## Guided Next-Step Behavior

The default Builder Kit build-flow route is:

```text
pull-work -> design-probe / pickup-probe -> plan-work -> execute-plan -> verify-work -> evidence-gate
```

Routing rules:

- After `pull-work`, if no work item is selected, route to `design-probe` with route reason `decision_gap`.
- After `pull-work`, if one or more work items are selected but evidence is incomplete, route to `pickup-probe` with `missing_evidence` populated.
- After `pickup-probe`, if unresolved questions remain and are not accepted gaps, route to `design-probe` or user input according to the automation mode.
- After `design-probe` or `pickup-probe`, if the selected work item, acceptance criteria, evidence, conflict scan, and ownership boundaries are sufficient, route to `plan-work`.
- After `plan-work`, route to `execute-plan` only when the plan is approved by the active workflow mode and ownership boundaries remain valid.
- Mid-work resume must choose the next action from artifacts, not chat memory.

## Per-Item Pickup Probe Enforcement

Every selected work item or explicitly bundled work group in Builder Kit `build` needs a fresh pickup Probe before planning.

- One item is the default selection after `pull-work`.
- Multiple items are allowed only when the Probe record includes `grouping_decision.status: "independent-items"` or `"justified-bundle"` and records the bundle or independence justification plus conflict risks.
- A broad prior instruction such as "continue through all waves" or "pick up the next tasks" must not authorize planning for a newly selected item after a merge. The workflow may inspect the queue, but must create a fresh Probe record before planning or execution.
- Unsafe grouped work must route back to `pull-work` with `grouping_decision.status: "unsafe-group"` and a split recommendation.
- Empty board state must route to Builder Kit shape / `idea-to-backlog`; do not improvise implementation work.

Planning may proceed only when `probe_status` is `passed` or `accepted_gap` and `probe_artifact_ref`, selected work refs, grouping decision, accepted gaps, expected modified files, conflict risks, and resume prompt are present.

## Resume Requirements

A future session must be able to resume Builder Kit build-flow from these artifacts alone:

- `state.json` identifies current phase/status and the next action target.
- `handoff.json` summarizes the pause, blocker, delegation, or resume target.
- The Probe record explains the current step, next step, route reason, selected work item refs, missing evidence, unresolved questions, accepted gaps, automation mode, and recovery mode.
- The session artifact records modified files and progress.
- Phase sidecars record acceptance criteria, evidence, critique, release, or learning state when those gates have started.

If any required resume field is absent, Builder Kit build-flow must route through `design-probe` or `pickup-probe` before planning or execution. Direct primitive recovery may instead ask for the missing primitive input.

## Downstream Contract Target

Issues #64, #51, and #62 are downstream consumers of this contract. They may add implementation, hooks, provider behavior, or fixtures, but they must preserve:

- `state.json` as the routing-focused Flow Agents state sidecar.
- Builder Kit Probe records as the rich pickup/design decision surface.
- Direct primitive invocation as valid outside Builder Kit build-flow.
- Builder Kit build-flow recovery through `decision_gap` to `design-probe` when upstream state is missing.
- Flow boundary preservation: Builder Kit coordinates product flow, Flow Agents coordinates harness artifacts and primitives, and Flow owns gate authority semantics.
