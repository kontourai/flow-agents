---
title: Sandbox Policy
---

# Sandbox Policy

Flow Agents workflows should choose the smallest execution boundary that can produce useful evidence.

The policy is not a replacement for a runtime's permission model. It is the shared vocabulary agents use when planning, delegating, asking for approval, and explaining why a task needs isolation or escalation.

The canonical contract lives in `context/contracts/sandbox-policy.md`. This page is the human-facing explanation of the same vocabulary.

## Modes

| Mode | Use When | Allowed Shape | Approval / Evidence |
| --- | --- | --- | --- |
| `local-read-only` | Research, review, planning, verification that does not mutate files or external systems | Read files, inspect configs, run safe read-only commands | Record sources read and checks attempted |
| `local-edit` | Small changes in the current workspace with low conflict and rollback risk | Edit files inside the active workspace; run local checks | Record modified files, commands, and evidence |
| `worktree` | Parallel work, risky refactors, overlapping file ownership, generated artifacts, or tasks likely to outlive one session | Create or use an isolated git worktree and branch | Record worktree path, branch, owner, and merge/cleanup plan |
| `container` | Untrusted dependencies, destructive build steps, generated-code experiments, or tools that may pollute the host | Run in a disposable container or equivalent isolated environment | Record image/context, mounted paths, and copied outputs |
| `cloud-sandbox` | Cloud resources, remote preview environments, infrastructure plans, or account-scoped experiments | Use scoped cloud accounts/projects/environments with explicit owner and teardown | Record account/project, region, permissions, cost risk, and teardown evidence |
| `privileged-integration` | Actions that mutate production-like systems, send external messages, access sensitive data, approve releases, or require elevated local permissions | Use the narrowest tool/action scope; request explicit approval | Record approval reason, target, expected effect, rollback, and post-action verification |

## Selection Rules

- Start at `local-read-only` for discovery and planning.
- Use `local-edit` only when the active workspace is the intended edit surface and conflict risk is low.
- Prefer `worktree` when work overlaps with another active task, touches broad/shared files, or may need independent review.
- Prefer `container` when dependency installation, generation, or destructive tooling could change host state outside the repo.
- Use `cloud-sandbox` for cloud experiments instead of real/shared environments unless the user explicitly authorizes otherwise.
- Use `privileged-integration` only with explicit scope, approval reason, and evidence that the action completed or was rolled back.

## Required Records

Planning or execution artifacts should record:

- `sandbox_mode`: one of the modes above
- `scope`: files, systems, resources, accounts, or branches in scope
- `owner`: agent, human, or integration responsible for the action
- `approval`: not required, requested, granted, denied, or blocked
- `rollback`: how to revert or clean up if the action fails
- `evidence`: commands, checks, logs, links, screenshots, or sidecars proving the outcome

## Stop Conditions

Stop and route back to planning or user approval when:

- the needed mode is stronger than the plan recorded
- the task requires destructive git operations, external sends, production data access, or cloud mutations without explicit approval
- the rollback path is unknown
- evidence cannot distinguish success from partial completion
- the runtime sandbox blocks a required action and no safer equivalent exists

## Relationship To Worktrees

`pull-work` owns the first worktree decision. `execute-plan` must respect it and may upgrade to `worktree`, `container`, `cloud-sandbox`, or `privileged-integration` if implementation risk increases. Downgrades require a reason in the workflow artifact.
