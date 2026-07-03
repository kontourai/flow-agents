# Execution Contract

> Read [`context/contracts/standing-directives.md`](standing-directives.md) — ratified owner directives that override default engineering conservatism.

Execution turns an approved plan artifact into code and local evidence while preserving parallel safety.

## Required Inputs

- plan artifact path
- session artifact path
- task description, files, acceptance criteria, and Definition Of Done items relevant to the task
- prior wave results when executing a later wave
- sandbox mode and escalation policy from `context/contracts/sandbox-policy.md`

## Worker Rules

- Validate scope before writing code.
- Confirm the planned `sandbox_mode` still fits the task before mutating files or systems.
- Check existing task artifacts for overlapping modified files.
- Work with existing user or agent changes; do not revert unrelated work.
- Follow local project patterns and use the smallest implementation that satisfies the plan.
- Update the session or worker task artifact with modified files and progress. Modified files are required execution evidence for conflict detection, verification scope, and optional governance providers.
- Prefer `npm run workflow:sidecar -- advance-state` when available to update `state.json` and `handoff.json` at phase boundaries.
- Run relevant validation for the files changed.
- If instructions are insufficient, another in-progress task blocks the work, the required sandbox mode is stronger than planned, or approval is missing, stop and report the blocker rather than guessing.

## Sandbox Modes

Use the vocabulary in `context/contracts/sandbox-policy.md`:

- `local-read-only`
- `local-edit`
- `worktree`
- `container`
- `cloud-sandbox`
- `privileged-integration`

Execution may upgrade to a stronger mode when risk increases. Downgrades require a recorded reason.

## Parallel Wave Rules

- Independent tasks with no shared files can run in the same wave.
- Shared files, generated artifacts, migrations, and cross-cutting contracts should be serialized unless the plan gives explicit file ownership.
- Worker delegation must name the exact worker role (`tool-worker`) rather than spawning an unnamed/default implementation agent.
- After each wave, collect results, check conflicts, and update the session artifact before starting the next wave.

## Delegation: Model Routing

Model-routing policy is data, not code: `.datum/config.json` (schema:
`@kontourai/datum`, provider/role registry) is the source of truth for which
model backs which delegate role. This contract only says where to read it.

- When spawning a delegate, resolve its role via `npx @kontourai/datum resolve <role> --json`
  (or the `@kontourai/datum` library's `resolve()`) and pass the resolved
  `model` explicitly to the delegate invocation. Do not hardcode a model name
  in a skill, agent definition, or generated file — the role name is the
  stable reference; the model it resolves to can change without touching
  delegation call sites.
- Role selection follows task shape, not delegate identity: fully-specified
  mechanical tasks resolve `delegate-mechanical`; precisely-planned
  implementation tasks resolve `delegate-implementation`; tasks needing design
  latitude resolve `delegate-design`. The orchestrator's own model (planning,
  gates, adversarial verification) resolves `orchestrator`, typically inherited
  rather than overridden.
- When `datum` (the CLI/library) or `.datum/config.json` is absent or a role
  fails to resolve, fall back to the runtime's inherited model and note the
  fallback in the session/task artifact — do not block delegation on datum
  being present.

## Completion Rules

Execution is complete only when:
- all planned waves are complete or explicitly blocked
- modified files are recorded in the session/deliver artifact or an evidence sidecar that the verifier can read; do not store them in `state.json` unless the workflow state schema supports that field
- sandbox mode and approval/rollback assumptions are recorded when relevant
- local validation attempted for changed areas
- failures caused by the execution are fixed or reported as blockers
- remaining gaps are ready for verification rather than hidden in the final summary
