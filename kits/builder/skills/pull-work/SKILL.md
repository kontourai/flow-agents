---
name: "pull-work"
description: "Select ready GitHub issues from the executable backlog and prepare them for implementation. Use when choosing what to work on next, reviewing a kanban-style issue board, enforcing WIP limits, grouping issues, deciding worktree isolation, or handing selected work to plan-work."
---

# Pull Work

Select ready backlog work and prepare a bounded execution handoff without implementing it.

## Contract

- Use `context/contracts/work-item-contract.md` as the source vocabulary for provider-backed work item shape, provider roles, and capability flags.
- Read the configured backlog provider dynamically.
- Select one issue or a coherent issue group.
- Do not implement code.
- Do not weaken scope to make execution easier.
- Do not implement provider settings, provider configuration, or configured-provider discovery; this skill consumes configured provider state and helper outputs when available.
- Do not reimplement Flow Definition validation or gate expectation semantics. When Flow Definition readiness is relevant, call Flow's validation surface (`flow validate-definition <path> [--json]` or `validateDefinitionWithDiagnostics`) and cite that result.
- Do not pull unrelated ideas together just because they are nearby in the backlog.
- Do not invoke `execute-plan`, `review-work`, `verify-work`, `evidence-gate`, or release skills.
- Hand selected work to `plan-work` only after the pickup gate is satisfied and the user wants planning.
- When the user wants to pick up work, enforce the full pull-work selection, WIP/shepherding, dependency, grouping, and worktree logic before any planning handoff.
- Do not hand selected work to `plan-work` until a fresh pickup Probe record exists for the selected item or explicitly bundled group, unless the user is making a direct primitive-only `pull-work` request and explicitly wants the primitive to stop before planning.
- Every pull-work artifact must correlate to selected backlog refs, shepherding refs for active PRs/sidecars/issues being finished before new work, or `backlog_gap=true` with a route to `idea-to-backlog`; direct audits with no new selection must record `shepherding_item_ids` or `backlog_gap`, not free-floating implementation scope.
- A stale broad continuation instruction, such as "keep going", "pick up the next two", or "continue after merge", may allow queue inspection but must not bypass per-item pickup Probe evidence.

## Inputs

- Repository or working directory.
- Optional labels, milestone, project board, assignee, or priority filter.
- Optional WIP limit or current in-progress context.
- Existing `.flow-agents/<slug>/` artifacts, PRs, and CI/review queues.

## Artifact Contract

Create or update `.flow-agents/<slug>/<slug>--pull-work.md` with:

- `board_snapshot`: filters, issue list, labels, milestone/provider milestone state, project fields, state, blockers
- `wip_assessment`: active work, reviews, verification, CI remediation, with personal WIP separated from global conflict context
- `my_active_work`: local worktrees, dirty branches, open PRs by the current user, active sidecars, and in-flight review/verification/release work owned by the current user
- `shepherding_candidates`: personal PRs, worktrees, or sidecars that should be reviewed, fixed, published, merged, abandoned, or cleaned before starting more work
- `stale_worktrees`: worktrees with no open PR, no recent activity, merged/abandoned branches, or unclear ownership that need an explicit keep/remove decision
- `open_prs_by_me`: open pull requests authored by the current user, including check/review state and whether they need shepherding
- `global_conflicts`: open PRs, active work, or sidecars by others that overlap selected files, dependencies, release lanes, or provider state
- `dependency_impacts`: blockers, blocked-by relationships, sequencing constraints, and work that should be prioritized because it unlocks or protects other work
- `start_new_work_decision`: `proceed`, `shepherd_existing`, `cleanup_required`, `blocked`, or `needs_user`, with the reason and next action
- `selection`: selected issue(s), rationale, priority, dependencies
- `selected_item_ids`: provider or local backlog artifact refs selected for pickup, using neutral work item refs when available
- `shepherding_item_ids`: active PR, sidecar, issue, worktree, or local backlog artifact refs being finished, reviewed, cleaned up, or unblocked before starting new work
- `backlog_gap`: `true` only when no provider/local backlog item or shepherding item can anchor the artifact, with the gap reason
- `backlog_gap_route`: route to `idea-to-backlog` or Builder Kit shape, including the prompt/context needed to create a local backlog artifact or provider-backed item
- `selected_scope`: selected repository, work item refs, whether the selection is single-item, independent-items, or a justified Work Item Group, and the thinnest meaningful slice being handed to planning
- `priority_rationale`: provider-neutral ranking reason, including delivery outcome, dependency unlocking, urgency, risk, size, readiness, and why higher-visible items were not selected
- `dependencies`: known blockers, blocked-by items, dependency freshness, cross-repo sequencing constraints, and any dependency checks that are `NOT_VERIFIED`
- `wip_conflict_notes`: personal WIP gate result, global WIP/conflict notes, file/provider-state/release-lane risks, and whether conflicts block, inform, or require isolation
- `alignment_questions`: pickup Probe questions asked one at a time, recommended answer, user answer, unresolved question, or reason no question is needed
- `grouping_check`: thinnest meaningful slice, bundle justification, dependency map, split/keep decision
- `anchor`: objective, source artifacts, non-goals, done criteria
- `work_scope`: allowed files/areas, risky areas, coordination notes
- `worktree_decision`: yes/no, path/branch if known, rationale
- `worktree_lifecycle`: path, branch, retain-until condition, cleanup owner, cleanup command, and whether cleanup is blocked by an open PR, review, CI, or user decision
- `handoff`: recommended `plan-work` prompt and acceptance criteria
- `pickup_gate`: pass/fail/block and reason
- `pickup_probe`: for Builder Kit build flow only, the recorded Probe decisions, unresolved questions, accepted gaps, planning readiness, expected modified files, sandbox/worktree mode, and conflict risks that `plan-work` must consume
- `builder_kit_handoff`: when Builder Kit build flow is active, machine-checkable fields `probe_status`, `probe_artifact_ref`, selected item ids, grouping decision, accepted gaps, route reason, and next action

## Workflow

### 1. Read Board State

First inspect effective backlog provider settings when the repo provides them:

```bash
npm run effective-backlog-settings -- --repo-path . --json
```

If the command returns `status: configured`, use the returned `WorkItemProvider`, `BoardProvider`, filters, and WIP policy as the default board source. Preserve the provider source and settings path in the pull-work artifact. If it returns `status: ask_user` or the helper is unavailable, ask the user which backlog `WorkItemProvider` and `BoardProvider` to use before selecting work. Do not silently assume a repository, project, filters, labels, milestone, or WIP policy.

Use `github-cli` / `gh` when available to inspect issues, labels, milestones, project fields, PR links, and blockers.

Treat GitHub Issues as a `WorkItemProvider` and GitHub Projects as a `BoardProvider`, mapped through `context/contracts/work-item-contract.md`. Preserve provider-specific values in the artifact when useful, but use the contract's neutral fields for selection, grouping, and handoff.

Classify issues:

- ready
- blocked
- stale
- in progress
- related-only

When local JSON from `gh issue list/view --json ...` is available, normalize it through the helper before selection:

```bash
npm run pull-work-provider -- \
  --settings-json context/settings/backlog-provider-settings.json \
  --issues-json /path/to/github-issues.json \
  --resolved-ref kontourai/flow#2=closed
```

The helper preserves provider refs, project fields, blockers, PR links, and source artifact refs, then emits the work item contract fields plus readiness evidence. Use live provider state for final decisions; fixture output is only test evidence.

Before classifying provider-backed work as ready for pickup, fetch the latest target ref when network access and provider credentials are available, then compare the current target SHA to the work item's `planned_base_sha`. Record the current target ref/SHA, planned base ref/SHA, `commits-since`, planned age, changed files since the planned base, and changed-file intersections with `planning_scope_refs` in the pull-work artifact or helper output.

Classify revision freshness as:

- `fresh`: the planned base matches the current target SHA, or the only newer commits/files are known not to affect the planning scope.
- `drifted`: the target has moved, but changed files do not materially intersect `planning_scope_refs`; prompt alignment and record accepted decisions before planning may proceed.
- `stale`: changed files intersect `planning_scope_refs`, contracts, dependencies, or expected execution areas enough that the issue may no longer describe the right slice; route back to `idea-to-backlog` instead of handing directly to `plan-work`.

Missing `planned_base_sha` is not fresh. Record it as an explicit `NOT_VERIFIED` or accepted-gap baseline with the concrete fallback baseline used, such as current target ref/SHA plus provider history. Do not invent revision certainty for legacy work items.

Return vague work to `idea-to-backlog` instead of inventing scope.

### 2. Enforce WIP And Shepherding

Before selecting new work, check whether review, verification, release, or CI remediation is congested. Separate the current user's active work from global conflict context.

Personal WIP scan:

- Inspect local worktrees and branches for dirty state, unpublished commits, merged branches, abandoned branches, and unclear ownership.
- Inspect open PRs authored by the current user and record review/check state, requested changes, mergeability, and whether the PR needs shepherding.
- Inspect active `.flow-agents/<slug>/` sidecars owned by the current user or current session, especially `planning`, `planned`, `in_progress`, `verifying`, `needs_decision`, `not_verified`, `failed`, and `blocked`.
- Classify personal items into `my_active_work`, `shepherding_candidates`, `stale_worktrees`, and `open_prs_by_me`.

Global conflict scan:

- Inspect open PRs, active work, and known sidecars from other owners only for file overlap, dependency, sequencing, release-lane, provider-state, or artifact-contract risk.
- Record those risks in `global_conflicts` and `dependency_impacts`; do not block just because other people have work in progress.

Default policy:

- Prefer finishing active work over starting new work.
- Personal WIP may block new work when it exceeds the WIP policy, needs review/CI shepherding, has dirty worktrees, or has unresolved verification/release decisions.
- Other people's WIP blocks only when it creates concrete file-scope conflict, dependency, sequencing, release, provider-state, or artifact-contract risk for the selected item.
- Do not pull new implementation work when verification/evidence gates are overloaded.
- Prefer shepherding an already-open personal PR over starting new implementation when the PR is near merge or needs only checks/review/fixes.
- Return vague or stale issues to `idea-to-backlog`.
- Do not select work that conflicts with another active TODO's `modified_files` unless isolation or sequencing is recorded.
- Always record `start_new_work_decision` before selection handoff. If the decision is not `proceed`, stop with the shepherding, cleanup, blocker, or user-decision next action.

### 3. Select Work

Choose one issue or coherent group based on:

- priority
- milestone / delivery outcome alignment
- dependency unlocking
- risk
- size
- readiness
- owner / agent availability
- parallelism opportunity

Prefer the smallest coherent unit that can reach evidence and release readiness without leaving dependent half-work.

### Cross-Repo Ranking And Selection

When the backlog spans related repositories or product areas, use provider-neutral cross-repo ranking before selection. Compare work items by normalized work item refs from `context/contracts/work-item-contract.md`, not by provider-specific board mechanics. Preserve provider-specific details as evidence, but do not mutate GitHub Projects, provider fields, or cross-repo provider state from this skill.

Rank candidates by:

- delivery outcome alignment, including milestone, release lane, dogfood target, or explicit user priority
- dependency unlocking or protection across repositories
- readiness, acceptance criteria quality, dependency freshness, and provider state
- risk, size, reversibility, and ability to produce evidence without dependent half-work
- personal WIP, global conflicts, release-lane conflicts, and file/provider-state overlap
- owner or agent availability and whether the work is appropriate for the current sandbox/worktree mode

The output must make the ranking decision reviewable. Record `selected_scope`, `priority_rationale`, `dependencies`, `wip_conflict_notes`, and `alignment_questions` even when the selection is a single issue. Include why visible alternatives were deferred when they outrank the selected item on one dimension but lose on readiness, dependency, WIP, or scope fit. If ranking cannot be completed from available provider context, ask one alignment question or record the unknown as a blocker or accepted gap before planning.

Default to one thinnest meaningful slice. A Work Item Group selection requires explicit justification in `grouping_check` and `selected_scope`; do not group items merely because they share a milestone, label, repository family, or theme.

For issue groups, require an explicit grouping check:

- the group shares one user outcome and acceptance signal, or
- one issue hard-blocks another and the dependency sequence is recorded, or
- splitting would create unsafe or unusable partial delivery.

If the relationship is only thematic, split the work and select the thinnest meaningful slice instead.

### Selection Examples

Use these compact examples as the expected artifact shape when selecting or rejecting cross-repo work:

- **independent docs work**: `selected_scope`: single-item docs update in `kontourai/flow-agents`; `priority_rationale`: small, ready, improves workflow discoverability, and does not block runtime delivery; `dependencies`: none known; `wip_conflict_notes`: no personal WIP block and no global file overlap; `grouping_check`: single-item, no Work Item Group; `alignment_questions`: none needed because scope and docs target are explicit.
- **Resource Contract audit work**: `selected_scope`: single-item audit of the Resource Contract guidance across the owning repo and referenced docs; `priority_rationale`: selected because it protects later implementation work and resolves contract drift before code changes; `dependencies`: requires current contract docs and provider refs to be fresh, with unknown external repo state recorded as `NOT_VERIFIED` if not checked; `wip_conflict_notes`: block if another active task edits the same contract, otherwise record as global context; `grouping_check`: do not bundle fixes unless the issue explicitly requires audit plus remediation; `alignment_questions`: ask whether to stop at audit evidence or include narrowly scoped doc fixes, with a recommended answer.
- **dogfood-alpha implementation work**: `selected_scope`: single-item implementation slice in the dogfood-alpha milestone; `priority_rationale`: high delivery alignment and unlocks product dogfood evidence, but only selected if dependencies are closed or explicitly accepted; `dependencies`: list blocked-by issues, required artifacts, and pickup Probe freshness; `wip_conflict_notes`: require worktree isolation when implementation overlaps active files or release lanes; `grouping_check`: Work Item Group only when one item hard-blocks the implementation and the dependency sequence is part of the same acceptance signal; `alignment_questions`: ask the narrow scope question before `plan-work` if the issue could expand into provider adapters or runtime orchestration.
- **blocked cross-product dependency**: `selected_scope`: no implementation selection; `priority_rationale`: defer because a higher-priority item in another product/repo is blocked by an unresolved dependency or missing provider state; `dependencies`: name the blocker, owner/repo when known, and freshness check; `wip_conflict_notes`: record any release-lane or provider-state conflict as the reason to stop; `grouping_check`: unsafe-group unless explicit dependency sequencing and shared acceptance justify a bundle; `alignment_questions`: ask whether to shepherd/unblock the dependency, return to shaping, or choose the next ready independent item.

### 4. Anchor Check

Before planning, restate:

- selected issue links
- objective
- authoritative artifacts
- milestone or delivery outcome, including whether it is a real provider milestone, a project field, a label, or intentionally unset
- non-goals
- current gate
- allowed file/work scope
- done criteria
- expected verification/evidence/release gates

### 5. Worktree Decision

Use `context/contracts/sandbox-policy.md` for the broader execution boundary decision. `pull-work` owns the first `sandbox_mode` recommendation; `execute-plan` may upgrade it if risk increases.

Strongly consider isolated worktrees, especially for:

- parallel agent execution
- risky refactors
- prototype/MVP work
- multiple agents in one repo
- large dependency or migration changes

Record:

- sandbox_mode: `local-read-only`, `local-edit`, `worktree`, `container`, `cloud-sandbox`, or `privileged-integration`
- worktree used: yes/no
- path or branch when known
- rationale
- worktree lifecycle:
  - `retain_until`: `pr_merged`, `branch_abandoned`, `user_override`, or a documented equivalent
  - `cleanup_owner`: user, orchestrator, or named agent role
  - `cleanup_command`: usually `git worktree remove <path>` after merge/abandonment and optional branch deletion when safe
  - `cleanup_blocked_by`: open PR, pending review, pending CI, dirty files, unpublished commits, or user decision

If not using a worktree, state why shared-workspace execution is acceptable.

Publishing a branch must retain the worktree for review, CI, and follow-up fixes. Final acceptance, release cleanup, or explicit abandonment owns worktree removal. Do not copy files back into the main checkout by hand; Git is the merge surface.

### 6. Handoff

Then invoke or recommend `plan-work` only when the user wants execution planning to begin.

### Builder Kit Pickup Probe Handoff

Direct `pull-work` remains a standalone primitive: it may select work, write the pull-work artifact, and stop at a `plan-work` handoff without invoking the productized Builder Kit build flow.

For productized pickup, selected work routes through the `design-probe` step as `pickup-probe` before planning. This applies to Builder Kit `build` flow and to "pick up work and build it" requests that intend to continue into delivery. Do not let `plan-work` proceed until the pull-work or plan handoff artifact records the pickup Probe outcome:

- goal fit and scope
- blockers and dependencies
- dependency freshness
- acceptance criteria quality
- provider state
- risk and stop-short risks
- sandbox/worktree mode
- expected modified files and conflict risks
- planning readiness
- decisions, unresolved questions, and any accepted gaps

Record these machine-checkable handoff fields for every selected productized pickup item or bundle:

- `probe_status`: `missing`, `required`, `in_progress`, `passed`, `accepted_gap`, or `blocked`
- `probe_artifact_ref`: path to the pull-work section or Builder Kit Probe sidecar that contains the pickup Probe evidence
- `selected_item_ids`: neutral work item refs from `context/contracts/work-item-contract.md`
- `grouping_decision`: `single-item`, `independent-items`, `justified-bundle`, `unsafe-group`, or `empty-board`
- `accepted_gaps`: known gaps explicitly accepted for this planning pass
- `route_reason` and `next_action`

Ask one alignment question at a time only when repo/provider context leaves a genuine decision gap. Include a recommended answer with that question. If the user accepts proceeding despite an unresolved question, record the unresolved question as an accepted gap in the handoff artifact before planning.

For productized pickup handoff, route `decision_gap` back to `design-probe`; for pickup/planning gaps, that means returning to this pickup Probe record before retrying `plan-work`.

If a direct `pull-work` invocation has enough primitive inputs but no productized build intent, stop after the handoff and report the expected next step. If the user then asks to continue into build or delivery, route to `design-probe` / `pickup-probe` before planning.

If no ready backlog item exists, route to Builder Kit shape / `idea-to-backlog` instead of inventing implementation work.

Direct pull-work audits that inspect WIP, PRs, sidecars, or board state without selecting new implementation work are valid only when the artifact records `shepherding_item_ids` for the active items being finished or `backlog_gap=true` plus `backlog_gap_route` to `idea-to-backlog`. They must stop at shepherding, cleanup, blocker, or shaping guidance and must not create free-floating implementation scope.

## Pickup Gate

Selected work is ready when:

- `selected_item_ids` records the selected provider/local backlog item refs, or `shepherding_item_ids` records the active PR/sidecar/issue refs being finished before new work, or `backlog_gap=true` records the route to `idea-to-backlog`
- issue scope is clear
- acceptance criteria exist
- dependencies are known
- selected issue group has explicit bundle justification or is split to one thinnest meaningful slice
- multi-item selection records independence or bundle justification and expected conflict risks
- owner/agent path is clear
- worktree decision is recorded
- worktree lifecycle is recorded when a worktree is used
- personal WIP/shepherding scan is recorded
- global conflicts and dependency impacts are recorded
- `start_new_work_decision` is `proceed` or an explicit accepted gap allows pickup to continue
- no higher-priority blocked verification work should be finished first
- conflict risk with active TODOs is recorded

If the gate fails, update the artifact and stop with the blocker.

After a merge, automatic continuation may inspect the queue and write a new pull-work artifact, but it cannot enter planning or execution for the next work item until a fresh pickup Probe record exists for that newly selected item or justified group.
## Gate Claim: Record Selected Work

When the Pickup Gate passes and work is selected (not just a shepherding scan or WIP-only audit), record the gate claim for the Builder Kit `pull-work` step before handing off to `design-probe` or `plan-work`. This satisfies the `builder.pull-work.selected` gate expectation.

Use the `selected_item_ids` as the evidence artifact ref and confirm that scope and acceptance criteria are present in the pull-work artifact:

```bash
npm run workflow:sidecar -- record-gate-claim .flow-agents/<slug> \
  --expectation selected-work \
  --status pass \
  --summary "Selected <work-item-ref>: scope clear, acceptance criteria present." \
  --evidence-ref-json '{"kind":"artifact","file":".flow-agents/<slug>/<slug>--pull-work.md","summary":"Pull-work artifact with selected_item_ids, scope, and acceptance criteria."}'
```

Use `--status fail` when the gate fails (blocker recorded but no selection made). Use `--status not_verified` only when the session has no active flow step (non-Builder-Kit usage).

Record `--status fail` with a summary naming the blocker when stopping before selection. Do not record `pass` until `selected_item_ids` are confirmed and the pickup gate criteria above are met.



## Flow Validation Boundary

Flow Agents may need to know whether a Flow Definition referenced by a work item is valid, but Flow owns those semantics. Use one of Flow's published validation surfaces instead of copying checks into this repo:

```bash
flow validate-definition <path> --json
```

or, from code that already depends on Flow:

```js
validateDefinitionWithDiagnostics(definition)
```

Record the command/API result in the pull-work artifact or evidence sidecar. If Flow is unavailable, mark that readiness subcheck `NOT_VERIFIED` or blocked; do not create a partial validator in Flow Agents.
