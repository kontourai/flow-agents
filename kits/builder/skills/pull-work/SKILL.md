---
name: "pull-work"
description: "Select ready provider-backed work and prepare a bounded implementation handoff."
---

# Pull Work

Select ready backlog work and prepare a bounded handoff without implementing it.

## Role And Binding

- **Role:** canonical Builder build-step producer.
- **Binding:** `builder.build` step `pull-work`.
- **Produces:** `<slug>--pull-work.md` and, for an active matching run, the `selected-work` expectation.
- **Standalone no-run behavior:** inspect and select work as a direct primitive, then return the artifact. Do not start a Builder run, record Builder evidence, or represent selection as an active-flow gate pass.

## Contract

- Use `context/contracts/work-item-contract.md` and `context/contracts/assignment-provider-contract.md` as the source vocabulary.
- Select one ready work item or a justified coherent group; do not merge nearby but unrelated work.
- Finish or explicitly account for existing work before starting more work. Do not weaken scope to make selection easier.
- Do not implement code or invoke execution, review, verification, evidence-gate, or release skills.
- Do not hand off to planning until a fresh `pickup-probe` record exists, unless this direct primitive is intentionally stopping after selection.
- A broad continuation request may trigger queue inspection but never replaces per-item pickup evidence.

## Provider Boundaries

- `BoardProvider` lists and ranks ready work, board state, priority, milestone, and blockers.
- `WorkItemProvider` reads the selected item, acceptance criteria, relationships, and provider state.
- `RepositoryAdapter` supplies target revision, worktree capability, and changed-file overlap context.
- `AssignmentProvider` is the sole durable ownership interface: claim, release, supersede, status, and list.

An optional GitHub adapter may implement these interfaces. Do not require GitHub issue numbers, labels, Projects, pull requests, `gh`, or provider-native dependency APIs.

### Readiness Source Integrity

A configured `BoardProvider` is the canonical Backlog Readiness Source
(`docs/decisions/backlog-readiness-source.md`). When the configured board
yields zero ready items or cannot be read, record the provider warning
(`zero_ready_items`, or the read failure) in the pull-work artifact and route
to triage/intake for an explicit readiness decision. Never silently
substitute `WorkItemProvider` issue-level listing for board-driven selection:
a deliberate issue-listing pass must carry the `board_provider_bypassed`
warning it received into the artifact, with the reason the board was
bypassed.

## Model Routing

For board scans, WIP assessment, dependency joins, and selection bookkeeping, resolve `delegate-mechanical` from `.datum/config.json`. If unavailable, inherit the session model and record the fallback.
Apply the routing and escalation contract in `context/contracts/execution-contract.md`.

## Inputs

- working directory and configured provider capabilities
- optional priority, board, milestone, assignee, or WIP filters
- current delivery artifacts and active assignment/liveness context

## Artifact

Create or update `<slug>--pull-work.md` with:

- board snapshot and applied filters
- active work, review, verification, and conflict assessment
- candidate readiness, blockers, dependencies, priority rationale, and grouping decision
- assignment/liveness preflight, claim confirmation, takeover, post-claim
  conflict evidence, and any explicit `reclaimable_override`
- selected work-item identifiers, scope, acceptance criteria, target revision, and repository context
- revision freshness, source revision assumptions, changed-scope intersections, and unknowns
- worktree/isolation decision, expected modified files, conflict risks, route reason, and next action

## Selection Method

1. Read configured board and work-item state. Normalize readiness, dependencies, priority, target milestone or delivery outcome, and blockers through the provider interfaces.
2. Assess WIP and shepherding. Prefer completing active implementation, review, verification, or provider follow-up before selecting new work. Separate the caller's WIP limit from global overlap risk.
3. Join `AssignmentProvider` state with liveness state where available. Exclude held work unless the caller explicitly overrides it; record the reason, holder context, and recovery rule. A liveness emission failure is non-blocking only when the skipped check and its consequence are recorded.
4. Rank candidates by readiness, user outcome, dependency freshness, risk, priority, and overlap. Select a single item by default. A group needs a shared outcome, hard dependency, or explicit risk-reduction rationale.
5. Create the durable assignment through `AssignmentProvider` when the selected work requires ownership. Record the claim result, but do not substitute a provider-specific mutation for the interface contract.
6. Confirm the repository anchor with `RepositoryAdapter`: target ref/SHA, planned base when present, acceptance-criteria drift, related changes, and source-scope intersections. Mark unavailable evidence `NOT_VERIFIED`; do not call it fresh by assumption.
7. Decide isolation from expected modified-file overlap, active assignments, worktree support, and rollback needs. Record a shared-worktree decision only when overlap is acceptably low and coordination is explicit.
8. Hand the selected item and all unresolved context to `pickup-probe` before planning.

### Assignment And Liveness Selection Preflight

Capture the caller identity once for the selection pass. For each candidate,
join durable `AssignmentProvider.status()` with available liveness observations
and classify the subject, not individual observation rows, in this precedence:

1. `mine`: the durable assignment confirms the caller as holder. Fold it into
   WIP/shepherding; do not re-offer it as new work.
2. `held`: another live holder or a conflicting own/other live observation is
   present. Exclude it by default and surface a double-hold conflict.
3. `reclaimable`: the incumbent assignment is stale. Selection requires an
   explicit recorded opt-in and the provider's takeover protocol.
4. `human-held`: a human-owned assignment requires that human's explicit
   release or authorization; a force flag alone is insufficient.
5. `free`: no effective assignment or live holder blocks selection.

Read raw provider status, freshness, holder identity, and reason fields; do not
collapse them into a coarse display label. Record `assignment_preflight`, the
classification, holder context, provider capability, and any unavailable
liveness dimension. A missing optional liveness observation may be recorded as
skipped, but a missing durable assignment check is `NOT_VERIFIED` when ownership
matters.

An explicit override of `held` or `reclaimable` records the requester,
authorization, reason, consequence, and `reclaimable_override`. Reclaimable
takeover is resumption, not restart: observe the provider grace rule, supersede
the stale holder atomically when supported, and continue the incumbent branch
or durable handoff.

After `AssignmentProvider.claim()`, call `status()` again. If another holder now
coexists or the caller is not the confirmed holder, record a post-claim
conflict, surface it prominently, and reselect rather than planning. The check
does not imply universal mutual exclusion: a local-file provider may serialize
claims with a lock, while a remote provider without compare-and-swap remains
advisory and must rely on conflict detection plus its publish-time hold gate.

When the provider exposes deterministic conflict arbitration, resolve a
double-hold from the same pinned caller identity, subject, and observation
snapshot. Prefer the earlier claim; break an exact timestamp tie by ascending
actor identifier. Every caller must derive the same winner from the same state.
If the caller loses, release or concede its claim immediately, record
`{verdict_reason, winner_actor, conceded: true}`, exclude the contested subject,
and reselect in the same pass. If the caller wins, record
`{verdict_reason, winner_actor, conceded: false}` and continue without release.
This convergence rule closes a detected conflict for the current pass; it does
not close the underlying read-then-write race on a non-atomic provider.

Assignment and liveness records are runtime/provider state. Apart from the
narrow `AssignmentProvider` claim or supersede required for ownership, do not
mutate board fields, work-item content, or unrelated provider state from this
skill.

## Active Builder Run

Complete selection and ownership preflight before creating a run. The public
runtime supports exactly two Work Item reference forms: `provider:id` and
`owner/repo#numeric-id`. `provider:id` is the provider-neutral adapter form;
`owner/repo#numeric-id` is the GitHub-compatible adapter form. Do not invent
other reference formats or treat an unconfigured provider as resolved. Bind a
supported selected Work Item through either form:

```bash
flow-agents workflow start --flow builder.build \
  --work-item provider:work-item-123 \
  --assignment-provider <configured-kind> \
  --effective-state-json <provider-status.json>
# GitHub adapter example:
flow-agents workflow start --flow builder.build \
  --work-item kontourai/flow-agents#123 \
  --assignment-provider github \
  --effective-state-json <github-assignment-status.json>
flow-agents workflow status --session-dir <session-dir>
```

For `local-file`, pass `--assignment-provider local-file` and omit
`--effective-state-json`. `workflow start` atomically binds the selected Work Item, records the canonical
`selected-work` claim, and projects the next step. Do not call it before
provider ownership is confirmed, and do not attempt to attach `selected-work`
again after start. If readiness, ownership, or source context is unresolved,
stop before run creation with `FAIL` or `NOT_VERIFIED` in the pull-work artifact.
Do not use a private writer command, enter at a later step, or infer an active
run from an artifact path.

For GitHub, populate `render-claim` (and `render-supersede`) input with the
canonical actor key captured for this selection pass as `actor_key` and the
exact selected `owner/repo#numeric-id` as `work_item_ref`. Keep
`assignee_login` as the GitHub account used for provider notifications; it is
not the runtime actor identity. Execute every emitted `gh_commands` entry as
the exact argv array returned by `AssignmentProvider` through an argv-capable
process API. Never join, quote, or reconstruct a rendered argv array into a
shell command. Re-read status after those argv arrays complete and pass that
unaltered `AssignmentStatus` document to `workflow start`. For GitHub status,
pass the exact configured provider repository as `--repo owner/repo`; do not
derive it from the claim comment or its `work_item_ref`. Confirm the returned
`assignment.repository` and provider-sourced `assignment.issue_number` exactly
match the selected Work Item before starting the workflow.

## Handoff

Pass `pickup-probe` the selected identifiers, artifact path, provider state, dependencies, revision-freshness result, expected modified files, conflict risks, assignment/liveness result, worktree mode, route reason, and next action. Stop here unless the next primitive is explicitly requested.

## Revision Freshness

Fetch or otherwise resolve the latest target ref before classifying readiness. Compare the current target ref/SHA to the Work Item's `planned_base_ref` and `planned_base_sha`; record commits-since, planned age, changed files, and changed-file intersections with `planning_scope_refs`.

Classify revision freshness as `fresh`, `drifted`, or `stale` — this severity vocabulary is what `classifyRevisionFreshness()` mechanically emits. `drifted` requires an alignment decision or accepted gap. `stale` routes back to `idea-to-backlog`. Missing `planned_base_sha` is not fresh: record `NOT_VERIFIED` and stop unless an accepted-gap baseline explicitly names the current target ref/SHA plus provider history. Material drift (`no_material_drift`/`scope_drift`/`dependency_drift`/`contract_drift`/`conflict_risk`) is a distinct routing-judgment dimension pickup Probe produces from this severity plus dependency/scope/conflict context (work-item-contract.md "Planning Base And Drift") — do not conflate the two vocabularies.

Provider discovery and normalization belong to configured adapters, not this skill. Consume configured `WorkItemProvider`, `BoardProvider`, and `AssignmentProvider` results; when configuration is absent, ask for the intended adapters instead of assuming one.
