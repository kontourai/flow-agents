---
status: current
subject: Backlog Readiness Source
decided: 2026-07-16
evidence:
  - kind: issue
    ref: https://github.com/kontourai/flow-agents/issues/441
  - kind: pr
    ref: https://github.com/kontourai/flow-agents/pull/449
  - kind: commit
    ref: c19c3e64a214be7d5b2585004fd3c4f2597781e5
  - kind: url
    ref: https://claude.ai/code/session_01SmQYjiUo1aDSXgEKyiye7M
---

# Backlog Readiness Source

Which signal marks a Work Item intentionally ready for pickup, and what
`pull-work` is allowed to do when that signal yields nothing.

## Decision

- **The org project board is the readiness source.** The configured
  BoardProvider — org GitHub Project `kontourai/1` ("Flow Agents Builder
  Platform") — carries readiness as board Status. `ready_statuses=["ready"]`
  is the pickup filter; the board's `Priority` field ranks the cross-repo
  ready queue.
- **Triage is the automated intake status.** Every new `kontourai/*` issue is
  added to the board with Status=Triage by the shared reusable workflow
  (`kontourai/.github` `add-issue-to-project.yml`, called per-repo from
  `.github/workflows/add-to-project.yml`); closing an issue moves it to Done.
  Nothing reaches Ready automatically.
- **The Triage → Ready move is the intentionality act.** Moving an item to
  Ready (and setting Priority) is the triage responsibility that makes work
  eligible for agent pickup. This is a deliberate human/triage-pass decision,
  not automation.
- **A configured readiness source that yields nothing is a surfaced warning,
  never a silent fallback.** The board reader emits `zero_ready_items` when
  the configured board produces an empty ready queue (landed with PR #449),
  and the issue-listing path emits `board_provider_bypassed` whenever a
  BoardProvider is configured but issue-level listing is used instead.
  `pull-work` must carry these warnings into its artifact and route to
  triage/intake rather than silently substituting unranked issue listing.
- The settings contract declares the real board taxonomy: the schema's
  `exclude_statuses` vocabulary includes `triage`, and this repo's settings
  exclude `triage` explicitly. `verification` remains in the schema vocabulary
  for provider-neutral shapes even though this board has no such column.

## Evidence basis (re-verified live, 2026-07-16)

Issue #441 was shaped on 2026-07-06 evidence that the board was dead (15
items, all Done, no automation). That premise is now false:

- The kontourai org has exactly **one** ProjectV2: `kontourai/1`, open, **468
  items** (306 Triage / 14 Ready / 148 Done) spanning 13 repos; 169 of 171
  open flow-agents issues are on it.
- The auto-add workflow targets exactly this project
  (`PVT_kwDOEJYCKs4BYzgP`), Status field options: Triage, Ready, In Progress,
  Blocked, Review, Done.
- A live board-driven `pull-work` read returns a **14-item priority-ranked
  cross-repo ready queue** with zero warnings and zero intake gaps.
- The agent-path `gh` token carries the `project` scope, so the read:project
  friction recorded in #441 no longer holds.

## Rejected alternative

**Label-based readiness (per-repo `ready`/`blocked`/`in-progress` labels).**
Recommended by #441 when the board was dead, because it needed no board
maintenance and no extra token scope. Both advantages evaporated once the
auto-add automation went live org-wide and the agent token gained `project`
scope — and labels cannot express cross-repo priority ranking without
inventing a parallel convention per repo. Revisit trigger: if the auto-add
workflow or `project` token scope regresses for agent environments, reopen
this subject rather than quietly re-deriving readiness from labels.

## Follow-ups (owned elsewhere, not absorbed here)

- **One-time triage sweep** of the ~306 Triage items (and any open issues
  missing from the board) to assign Ready/Priority intentionally — owned by
  the triage pass in #443 item 2. Not executed with this decision: the Ready
  set was already non-empty (14 items), and bulk-moving 300+ items without
  the accepted mechanism would manufacture fake intentionality.
- **Board maintenance as flow responsibility** (intake adds, claim → In
  Progress, completion Done assertion): #443.
- **Doctor board-health checks** (configured-but-unfed board, dead readiness
  source, missing token scope): #443 item 5 / #321. Until that surface
  exists, the warnings live in `pull-work` provider output and the
  `pull-work` skill contract only.
- **Workspace-scoped pull-work** across multiple repos: #444.
