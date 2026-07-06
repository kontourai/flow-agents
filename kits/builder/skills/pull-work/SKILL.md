---
name: "pull-work"
description: "Select ready GitHub issues from the executable backlog and prepare them for implementation. Use when choosing what to work on next, reviewing a kanban-style issue board, enforcing WIP limits, grouping issues, deciding worktree isolation, or handing selected work to plan-work."
---

# Pull Work

Select ready backlog work and prepare a bounded execution handoff without implementing it.

## Contract

- Use `context/contracts/work-item-contract.md` as the source vocabulary for provider-backed work item shape, provider roles, and capability flags.
- Use `context/contracts/assignment-provider-contract.md` as the second source vocabulary for durable ownership: the `AssignmentProvider` operations (`claim`/`release`/`supersede`/`status`/`list`), the assignment ⋈ liveness join's effective-state enum (`held`/`reclaimable`/`human-held`/`free`), and the versioned claim-record format come from that contract, not from this skill.
- `pull-work` may perform exactly two provider-adjacent writes at selection: the liveness claim (ADR 0012, ephemeral, local runtime presence stream — see "1a. Liveness Selection Preflight" / "Liveness Claim On Selection") and the durable assignment claim (`context/contracts/assignment-provider-contract.md`, GitHub assignee/label/comment or a local-file record — see "Assignment Claim On Selection"); no other provider mutation is added to this skill.
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

## Model Routing

Board selection, WIP/shepherding scans, dependency joins, liveness preflight, and
issue-sync-style bookkeeping are fully-specified mechanical work: when this skill
delegates them, resolve the `delegate-mechanical` role from `.datum/config.json`
(`npx @kontourai/datum resolve delegate-mechanical --json`) and pass the resolved
model explicitly. See `context/contracts/execution-contract.md` § Delegation:
Model Routing. Fallback: inherit the session model when datum/config is absent,
noted in the artifact.

## Inputs

- Repository or working directory.
- Optional labels, milestone, project board, assignee, or priority filter.
- Optional WIP limit or current in-progress context.
- Existing `.kontourai/flow-agents/<slug>/` artifacts, PRs, and CI/review queues.

## Artifact Contract

Create or update `.kontourai/flow-agents/<slug>/<slug>--pull-work.md` with:

- `board_snapshot`: filters, issue list, labels, milestone/provider milestone state, project fields, state, blockers
- `wip_assessment`: active work, reviews, verification, CI remediation, with personal WIP separated from global conflict context
- `liveness_preflight`: per-candidate `{subjectId, state: held|reclaimable|human-held|free|mine, holder_actor?, status_raw, effective_reason?}` plus `self_actor`/`self_actor_source`, computed via `liveness status --json` + `liveness whoami --json` joined with `assignment-provider status`'s `effective_state`/`reason` (see "1a. Liveness Selection Preflight"); `self_actor` is captured exactly once per pull-work pass and pinned for reuse (see "1a. Liveness Selection Preflight" and "Liveness Claim On Selection" — never re-derived per claim call); this is now the **full** ADR 0021 §1 `assignment ⋈ liveness` join (previously liveness-only pending #290 — #290 has landed)
- `reclaimable_override`: recorded only when a `reclaimable` (stale) candidate is selected, or when `--force`/an explicit user instruction overrides a `held` exclusion — the explicit opt-in decision and its stated reason (see "1a. Liveness Selection Preflight")
- `liveness_claim`: per selected item, `{subjectId, actor, emitted_at, ttl_seconds}`; on any claim-emit failure, `{skipped: <stderr reason>}` instead — fail-open (never block selection on a liveness-emit failure) but never silent: the skip reason is also surfaced in pull-work's user-facing output, and an unresolved-actor failure additionally names the remediation (`--actor <id>` / `FLOW_AGENTS_ACTOR=<id>` / a supported runtime), matching ADR 0012; also carries an optional `post_claim_conflict: {other_actor, detected_at}` when the post-claim re-check (see "Post-Claim Conflict Re-check") detects a double-hold
- `assignment_claim`: per selected item, `{provider: "github"|"local-file", subject_id, actor, command_evidence, confirmed_status}` — the durable-claim analog of `selected_item_ids`: provider kind, subject id, actor, the rendered/executed command evidence (`gh_commands`/`claim_comment_body` for `github`, the local-file `claim` invocation for `local-file`), and the confirmed `assignment-provider status` result for each selected item, recorded once the post-claim confirmation in "Assignment Claim On Selection" succeeds; see `context/contracts/assignment-provider-contract.md` for the underlying claim-record shape
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

When a `BoardProvider` is configured, read the board Ready queue as the primary cross-repo selection input, ordered by configured priority and board position. Per-repo `WorkItemProvider` issue listing is the intake-gap detector: use it to surface open issues missing from the board, not as a silent fallback when the board has no ready items. If the configured board returns zero ready items, record and surface that warning as a dead readiness source before selecting or asking for alignment.

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

When board state is available, read the Ready queue and intake gaps through the same helper:

```bash
npm run pull-work-provider -- \
  --settings-json context/settings/backlog-provider-settings.json
```

For fixture-backed evaluation or cached provider JSON, pass `--items-json /path/to/project-items-and-open-issues.json`. The board output includes `ready_queue`, `intake_gaps`, and `warnings`; select from `ready_queue` first when it is populated.

Before classifying provider-backed work as ready for pickup, fetch the latest target ref when network access and provider credentials are available, then compare the current target SHA to the work item's `planned_base_sha`. Record the current target ref/SHA, planned base ref/SHA, `commits-since`, planned age, changed files since the planned base, and changed-file intersections with `planning_scope_refs` in the pull-work artifact or helper output.

Classify revision freshness as:

- `fresh`: the planned base matches the current target SHA, or the only newer commits/files are known not to affect the planning scope.
- `drifted`: the target has moved, but changed files do not materially intersect `planning_scope_refs`; prompt alignment and record accepted decisions before planning may proceed.
- `stale`: changed files intersect `planning_scope_refs`, contracts, dependencies, or expected execution areas enough that the issue may no longer describe the right slice; route back to `idea-to-backlog` instead of handing directly to `plan-work`.

Missing `planned_base_sha` is not fresh. Record it as an explicit `NOT_VERIFIED` or accepted-gap baseline with the concrete fallback baseline used, such as current target ref/SHA plus provider history. Do not invent revision certainty for legacy work items.

Return vague work to `idea-to-backlog` instead of inventing scope.

### 1a. Liveness Selection Preflight

Resolve the current actor once per `pull-work` pass and pin it for reuse:

```bash
npm run workflow:sidecar -- liveness whoami --json
```

Capture the returned `actor` value as `self_actor` (and its `source` as `self_actor_source`) exactly once per pass. Reuse this pinned `self_actor` value explicitly via `--actor <self_actor>` on every subsequent `liveness claim` call in the same pass (see "Liveness Claim On Selection" below) — never re-derive the actor mid-pass, since ancestry/session-based resolution could otherwise resolve to a different value across separate calls within the same pass and silently defeat the "who am I" pinning this preflight depends on.

Read the full liveness stream once per pass (omit `--subject` to get every row):

```bash
npm run workflow:sidecar -- liveness status --json
```

For each ready candidate, derive `subjectId` via:

```bash
npm run workflow:sidecar -- resolve-slug <owner>/<repo>#<issue-number>
```

then group all rows for that `subjectId` by subject (classify per subject, not per row), reading each row's raw `status` field (never `label`). Detect the liveness-only double-hold case first, before computing the full assignment ⋈ liveness join below: when a `verified` row for an actor other than self and a `verified` row for the resolved self actor both exist on the same subject, that is a double-hold — surface it as `held` plus an explicit conflict warning (per ADR 0012 §4 detection: "a false-stale double-hold ... is detected ... not prevented"), never silently resolve it to `mine`.

Otherwise, compute the full ADR 0021 §1 `assignment ⋈ liveness` join per candidate via `assignment-provider status` (using the effective provider kind, repo, artifact root, `label_name`, and `claim_comment_marker` from `effective-assignment-provider-settings` — see "Assignment Claim On Selection" below — joined against the same liveness stream already read above):

```bash
npm run assignment-provider -- status \
  --provider <github|local-file> \
  --subject-id <subjectId> \
  --liveness-stream <path-to-events.jsonl> \
  --self-actor <self_actor>
  # github: --issue-json <path-to-gh-issue-view-json|-> --label-name <label> --claim-comment-marker <marker>
  # local-file: --artifact-root <dir>
```

Read the returned `.effective.effective_state` and `.effective.reason` and classify in this precedence order:

1. `effective_state: "held"` with `reason: "self_is_holder"` ⇒ `mine`: hand to `### 2. Enforce WIP And Shepherding`'s existing personal-WIP logic; do not re-offer as new, do not exclude as held-by-other.
2. else `effective_state: "held"` (`reason: "fresh_liveness_heartbeat"` or `"liveness_claim_present_assignment_lagging"`) ⇒ excluded from the ready set by default.
3. else `effective_state: "reclaimable"` ⇒ offered, flagged, with a warning; selecting it requires an explicit recorded opt-in (record in `reclaimable_override`, and/or `alignment_questions`), never a silent normal pick. On selecting a `reclaimable` candidate, run the **Takeover Protocol** (#294, ADR 0021 §5) below — takeover is resumption, not restart: grace-beat, supersede, then continue the incumbent's branch. Never auto-reclaim without the recorded opt-in.
4. else `effective_state: "human-held"` ⇒ surfaced, never auto-reclaimed (Design Decision 3 / ADR 0021 §6): record the assignee identity and idle duration (`effective.holder.assignee`, `effective.holder.idle_days`) in `alignment_questions` with a recommended answer (e.g. "assigned to `<assignee>`, idle `<idle_days>` days — reclaim?" recommending confirmation before proceeding), and select only on the user's explicit confirmation.
5. else `effective_state: "free"` ⇒ offered normally — including a `superseded` liveness row (no active assignment, no fresh liveness): now select-able via the **Takeover Protocol** below once the reclaimable/opt-in gate is satisfied (#294 implements the takeover semantics previously deferred here).

An explicit user instruction to proceed despite a `held` or `reclaimable` classification (`--force`, "take it anyway", equivalent) overrides the exclusion/opt-in requirement; the override and its stated reason must be recorded in the artifact (`liveness_preflight`, `reclaimable_override`, and/or `priority_rationale`). A `human-held` classification is never overridden by `--force` alone — only the user's explicit answer to the recorded `alignment_questions` entry authorizes selecting it.

This preflight now computes the **full** ADR 0021 §1 `assignment ⋈ liveness` join (previously liveness-only, pending #290): the assignment dimension is `#290`'s `AssignmentProvider` `status()` (`context/contracts/assignment-provider-contract.md`), joined against the same liveness stream this preflight already reads.

#### Takeover Protocol (#294, ADR 0021 §5) — resumption, not restart

When a `reclaimable` (or `superseded`-liveness) candidate is selected WITH the recorded opt-in, take it over by resuming the incumbent's work — never by starting a parallel branch or replanning. This is render-don't-execute: the CLI computes the decision and emits the exact steps; you run them.

1. **Preflight:** `npm run workflow:sidecar -- takeover-preflight .kontourai/flow-agents/<slug>`. It returns `{action, effective_state, holder, resume_branch, grace_seconds, next_steps}`. Only `action: "grace-then-supersede"` proceeds; `back-off` (incumbent live/revived) ⇒ STOP and reselect; `ask-first` (human-held) ⇒ do not proceed without the user's explicit answer.
2. **Grace beat:** wait `grace_seconds` (one heartbeat interval), then **re-run `takeover-preflight`**. If it now returns `back-off`, the incumbent revived — concede and reselect (this is the AC2 race guard). Proceed only if it is still `grace-then-supersede`.
3. **Supersede:** `npm run workflow:sidecar -- ensure-session … --supersede-stale`. It re-checks the state and REFUSES if the incumbent revived in the meantime (a live `held` is never superseded), records the audit trail ("superseded actor X, last seen T, resuming from trust bundle"), and prints `resumed_branch`.
4. **Resume the incumbent's branch — never a new one:** `git fetch origin <resume_branch> && git checkout <resume_branch>` (the `resume_branch` from step 1/3). Re-enter the existing artifact dir (the deterministic slug points at the same `.kontourai/flow-agents/<slug>/`); restore the durable record via the resume surface (#153) and continue from `handoff.json`/plan — do NOT re-plan or restart.
5. **Record** the takeover (superseded actor, `resume_branch`, grace outcome) in `reclaimable_override`. If the superseded incumbent later wakes, it is blocked at publish by the verify-hold gate (#293) — the takeover is authoritative.

`liveness claim`/`status`/`whoami` read/write the local runtime liveness stream, never GitHub issue/label/assignee state — this is not a provider mutation, and the two-provider-writes-only invariant in `## Contract` is unchanged by this slice. `#290` adds the one narrow, audited durable assignment claim that pairs with this liveness emit — see "Assignment Claim On Selection" below.

### 2. Enforce WIP And Shepherding

Before selecting new work, check whether review, verification, release, or CI remediation is congested. Separate the current user's active work from global conflict context.

Personal WIP scan:

- Inspect local worktrees and branches for dirty state, unpublished commits, merged branches, abandoned branches, and unclear ownership.
- Inspect open PRs authored by the current user and record review/check state, requested changes, mergeability, and whether the PR needs shepherding.
- Inspect active `.kontourai/flow-agents/<slug>/` sidecars owned by the current user or current session, especially `planning`, `planned`, `in_progress`, `verifying`, `needs_decision`, `not_verified`, `failed`, and `blocked`.
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

### Liveness Claim On Selection

Once `selected_item_ids` is finalized at the end of `### 3. Select Work`, before handoff to `plan-work`, for each selected item run:

```bash
npm run workflow:sidecar -- liveness claim <subjectId> --actor <self_actor>
```

using the same `subjectId` computed via `resolve-slug` during the preflight, and the same pinned `self_actor` captured once from `liveness whoami --json` at the start of this pass (`### 1a. Liveness Selection Preflight`) — always pass `--actor <self_actor>` explicitly on every claim in this pass; never a fresh derivation per claim call.

Record the result in `liveness_claim` as `{subjectId, actor, emitted_at, ttl_seconds}`. On any claim-emit failure (non-zero exit, unresolved actor, or liveness disabled/unavailable), record `{skipped: <stderr reason>}` in `liveness_claim` instead — fail-open, never block selection on a liveness-emit failure — and also surface that skip reason in pull-work's user-facing output; never silent. When the failure is specifically an unresolved-actor failure, additionally name the remediation (`--actor <id>` / `FLOW_AGENTS_ACTOR=<id>` / a supported runtime), matching `liveness claim`'s own error message.

### Post-Claim Conflict Re-check

After emitting claims for the selected item(s) above, re-read liveness status for those same subjects:

```bash
npm run workflow:sidecar -- liveness status --json --subject <subjectId>
```

If another actor's fresh (`verified`) claim now coexists with this session's own just-emitted claim on the same subject — a double-hold, per ADR 0012 §4 ("a false-stale double-hold (two fresh claims on one subject) is detected ... via Hachure `conflictRules`/`conflictedClaims`, not prevented") — surface the conflict prominently in the user-facing output and instruct the user to coordinate before proceeding; do not silently continue as if the selection were exclusive. Record the detected conflict in `liveness_claim`'s `post_claim_conflict` field.

When a double-hold is detected, immediately run the deterministic tiebreaker using the same pinned `self_actor` and the same `subjectId` already in scope:

```bash
npm run workflow:sidecar -- liveness verdict <subjectId> --json
```

`liveness verdict` is a read-only, lock-free CLI action that computes `{subjectId, winner, losers, reason, holders}` as a pure function of the shared liveness stream: among the subject's currently-fresh claim holders, the one whose current `claim` event has the earliest `at` wins; an exact-timestamp tie breaks by ascending actor-id string comparison (`reason: "tie-actor-lexicographic"`) — the SAME verdict for the SAME stream state regardless of which actor invokes it.

Branch on the returned `winner.actor`:

- If `winner.actor !== self_actor`, this session is the loser: immediately run `npm run workflow:sidecar -- liveness release <subjectId> --actor <self_actor>`, extend `post_claim_conflict` with `{verdict_reason, winner_actor, conceded: true}`, and return to `### 3. Select Work` to reselect within the same `pull-work` pass — excluding the just-released subject — before any handoff to `plan-work`.
- If `winner.actor === self_actor`, this session wins: record the verdict for transparency (`{verdict_reason, winner_actor: self_actor, conceded: false}`) in `post_claim_conflict` and proceed normally; do not release.

Honesty note: this re-check narrows, but does not close, the read-then-write race between the preflight's read and the claim's write. The verdict-and-release loop above closes the "detected but advisory-only" gap ADR 0012 §4 names for THIS session's own double-hold — the loser deterministically concedes and re-selects within the same pass, a new convergence guarantee this slice adds — but it still does not provide true mutual exclusion across the read-then-write race window itself; that residual is unchanged from before. `#290`'s provider assignment lease closes this gap for the **local-file** provider only: `claim`/`release`/`supersede` there are wrapped in a per-subject `mkdir`-lock (atomic create, EEXIST-spin, staleness reclaim), so two concurrent local-file `claim` calls on the same subject genuinely cannot both win — true mutual exclusion, not just detection. The **GitHub** provider (assignee/label/claim-comment) remains advisory/last-writer: `render-claim`/`render-supersede` emit `gh` argv for the calling skill to run, and nothing about a GitHub issue's assignee/label/comment state gives atomic compare-and-swap across two concurrent skill invocations — the post-claim `status` re-check above still only *detects* a lost race after the fact, it does not *prevent* one. Do not read "provider assignment lease" as closing the GitHub race; only the `verify-hold` publish gate (#293), not yet implemented, would do that for GitHub.

### Assignment Claim On Selection

After the post-claim liveness conflict re-check above resolves (no double-hold detected, or this session won the deterministic tiebreaker and any loser has reselected) and `selected_item_ids` is otherwise ready to finalize, perform the durable assignment claim — the second and last provider-adjacent write this skill performs (see `## Contract`) — before recording `selected_item_ids` as final and before any handoff to `plan-work`.

Resolve the effective assignment provider settings once per pass:

```bash
npm run effective-assignment-provider-settings -- --repo-path . --json
```

If the result is `status: ask_user`, ask the user which `AssignmentProvider` (`github` or `local-file`) to use before claiming; do not silently assume. If `status: configured`, use the returned `settings.provider.kind`, `settings.provider.repo`, `settings.policy.label_name`, and `settings.policy.claim_comment_marker` for every call below.

For each selected item's `subjectId` (the same `subjectId` resolved via `resolve-slug` and used throughout this pass):

- **`kind: "github"`**: build an `--input-json` payload with `repo` (`{owner, name}`), `issue_number`, `assignee_login` (the current actor's GitHub login when known), `existing_assignee_login` and `existing_comment_id` (only when superseding an already-recorded `reclaimable`/confirmed `human-held` candidate — otherwise omit), `label_name`, `claim_comment_marker`, `ttl_seconds`, `branch`, and `artifact_dir`, then render:

  ```bash
  npm run assignment-provider -- render-claim \
    --provider github \
    --subject-id <subjectId> \
    --input-json <path> \
    --actor-json <path>
  ```

  Execute every command in the returned `gh_commands` array **verbatim** via the Bash tool, in order — never freehand `gh` text. Each `gh_commands` entry is an **argv array** (one element per argument, e.g. `["gh", "issue", "comment", "9101", "--repo", "kontourai/flow-agents", "--body", "..."]`) and MUST be executed as argv — every element passed as its own separate Bash-tool argument — **never** concatenated into a single shell-command string, and **never** run via `bash -c "..."` or any other shell re-interpretation of the joined elements. `claim_comment_body` (and, when superseding, `previous_record`) can carry attacker-influenced text (see the GitHub claim-record sanitization note in `context/contracts/assignment-provider-contract.md`); concatenating argv elements into a shell string before execution would reintroduce a shell-injection surface this render/execute split is designed to avoid. Record the rendered `record`, `claim_comment_body`, and each executed `gh_commands` entry as evidence.

- **`kind: "local-file"`**: call the local-file `claim` subcommand directly — no render step, since this is the one path that performs real I/O inside the CLI itself:

  ```bash
  npm run assignment-provider -- claim \
    --provider local-file \
    --artifact-root <artifact-root> \
    --subject-id <subjectId> \
    --branch <branch> \
    --artifact-dir <artifact_dir> \
    --actor-json <path>
  ```

  A non-zero exit (already claimed by a different actor) must not be silently retried or overwritten — treat it exactly like a `held`/`reclaimable` conflict and return to `### 3. Select Work` to reselect.

Then, regardless of provider kind, re-fetch current state — re-fetch the GitHub issue via `gh issue view --json assignees,labels,comments` for `github` (the local-file record is already current on disk) — and call `assignment-provider status` again, passing the same pinned `self_actor`, to **confirm** the claim landed before treating `selected_item_ids` as final:

```bash
npm run assignment-provider -- status --provider <github|local-file> --subject-id <subjectId> --self-actor <self_actor> ...
```

Confirm `effective.effective_state === "held"` with `effective.reason === "self_is_holder"` (the join function's signal that this session's own actor is the confirmed holder). Only after this confirmation does `selected_item_ids` become final for handoff. If confirmation fails — the claim did not land, or a different actor's record now appears — treat this exactly like a liveness double-hold: do not proceed to `plan-work` with this subject; return to `### 3. Select Work` to reselect, excluding the contested subject.

Record the render/status evidence — provider kind, subject id, actor, the rendered/executed command(s), and the confirmed `status()` result — for every selected item under `selection` and in the dedicated `assignment_claim` artifact field (see Artifact Contract above).

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
npm run workflow:sidecar -- record-gate-claim .kontourai/flow-agents/<slug> \
  --expectation selected-work \
  --status pass \
  --summary "Selected <work-item-ref>: scope clear, acceptance criteria present." \
  --evidence-ref-json '{"kind":"artifact","file":".kontourai/flow-agents/<slug>/<slug>--pull-work.md","summary":"Pull-work artifact with selected_item_ids, scope, and acceptance criteria."}'
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
