# Sandbox Policy Contract

Workflow artifacts must name the execution boundary required for the work. The sandbox mode is a planning and delegation contract, not a substitute for the runtime permission model.

## Canonical Modes

Use exactly one of these values when recording `sandbox_mode`:

- `local-read-only`: inspect files, configs, logs, docs, and command output without mutating files or external systems.
- `local-edit`: edit files in the active workspace and run local validation with low conflict and rollback risk.
- `worktree`: use an isolated branch/worktree for parallel work, broad refactors, generated artifacts, or work likely to outlive the current session.
- `container`: use a disposable local environment for untrusted dependencies, destructive tools, or build steps that may pollute host state.
- `cloud-sandbox`: use scoped cloud accounts, projects, stacks, or preview environments with explicit owner, budget risk, and teardown.
- `privileged-integration`: access sensitive data, mutate external systems, send messages, deploy, approve releases, or use elevated local permissions.

## Required Artifact Fields

Plans, execution summaries, and handoffs should record:

- `sandbox_mode`
- `scope`
- `owner`
- `approval`
- `rollback`
- `evidence`

The Markdown form may use a Definition Of Done bullet. Structured sidecars should use the same vocabulary when a schema supports the field.

## Selection Rules

- Start discovery, planning, and code review at `local-read-only`.
- Use `local-edit` only when the active workspace is the intended edit surface.
- Prefer `worktree` for parallel agents, overlapping ownership, broad shared-file edits, or long-running work.
- Prefer `container` for risky dependency installation, generated-code experiments, or destructive commands.
- Use `cloud-sandbox` for cloud experimentation before touching shared or production-like resources.
- Use `privileged-integration` only with explicit approval, target, expected effect, rollback, and post-action verification.

## Escalation Rules

- Upgrade the mode when the work becomes riskier than planned.
- Stop for approval when the required mode is `privileged-integration` or when cloud, destructive, or externally mutating behavior was not already authorized.
- Downgrade only when the artifact records why the stronger boundary is no longer required.
- Do not hide sandbox blockers in a final summary. Record the blocker and route back to planning or user approval.

## Evidence Expectations

- `local-read-only`: sources read and checks attempted.
- `local-edit`: modified files and validation commands.
- `worktree`: worktree path, branch, owner, merge plan, and cleanup plan.
- `container`: image/context, mounted paths, command evidence, and copied outputs.
- `cloud-sandbox`: account/project, region, permissions, cost risk, teardown evidence.
- `privileged-integration`: approval reason, target, action result, rollback status, and post-action verification.
