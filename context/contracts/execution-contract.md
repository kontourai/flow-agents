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

### Tier ladder

The delegate roles form a cost/capability ladder that both escalation and the
Goodhart guard below reference. Lowest to highest:

```
delegate-mechanical  <  delegate-implementation  <  delegate-design
```

`orchestrator` is off-ladder — it is the session's own model (planning, gates,
adversarial verification), typically inherited rather than overridden, and sits
above `delegate-design` for escalation purposes. `extraction-default` is a
non-delegate role (bulk extraction) and is not part of this ladder.

### Escalation on gate failure

Delegate at the step's hinted tier, then let the gates enforce cost safety:

- Dispatch the delegate at the tier its skill hint names (a cheap tier for
  mechanical/fully-specified work).
- On a review or verify **gate FAILURE of that delegate's output**, re-dispatch
  the **fix** one tier higher on the ladder — `delegate-mechanical` failures
  escalate to `delegate-implementation`, `delegate-implementation` failures to
  `delegate-design`, and a `delegate-design` failure escalates to the
  `orchestrator` / a human decision. Do not re-dispatch the fix at the same
  tier that already failed its gate.
- Record every escalation in the session artifact (see *Routing decisions in
  the run artifact* below) with the tier it climbed **from**, so the run shows
  why a more expensive model was used.
- This is the fail-closed cost story: cheap tiers are safe **because** the gates
  catch their misses and escalate. Routing cheap-by-default never weakens
  verification — an ungated cheap delegate is what this ladder exists to prevent.

### Goodhart guard (review/verify never cheaper than the work)

Review and verify roles resolve at a tier **greater than or equal to** the tier
of the work they check; they never auto-downgrade below it.

- If the checked work was produced at `delegate-design`, its reviewer/verifier
  resolves `delegate-design` (or `orchestrator`) — never `delegate-implementation`
  or `delegate-mechanical`.
- If the checked work was produced at `delegate-implementation`, its
  reviewer/verifier resolves at `delegate-implementation` or higher.
- Rationale: a cheaper checker rubber-stamping a more capable worker's output
  defeats the gate and turns the routing table into a Goodhart target (optimize
  the cost metric, lose the thing the metric was a proxy for). The gate must be
  at least as capable as the work, or the fail-closed escalation story above is
  hollow.

### Routing decisions in the run artifact

Record each delegation's resolved role and model on the session artifact so a
downstream economics record (`flow-agents#349`) can price role assignments and a
baseline harness (`flow-agents#350`) can A/B tiers. Use the sidecar writer's
`record-agent-event` (additive `--role` / `--model` / `--escalated-from` flags):

```bash
# per-delegation routing decision
npm run workflow:sidecar -- record-agent-event \
  --agent-id <delegate-id> --kind delegation --status active \
  --role <resolved-role> --model "<resolved-model@provider>" \
  --summary "<what was delegated>"

# an escalate-on-gate-failure re-dispatch
npm run workflow:sidecar -- record-agent-event \
  --agent-id <delegate-id> --kind escalation --status active \
  --role <higher-tier-role> --model "<resolved-model@provider>" \
  --escalated-from <lower-tier-role> \
  --summary "<gate that failed> failed at <lower-tier-role>; fix re-dispatched one tier higher"
```

These land as top-level `role`, `model`, and (for escalations) `escalated_from`
fields on the JSONL event under `agents/<agent-id>/events.jsonl`. The shape is
additive: events without a routing decision are byte-identical to before, so no
existing consumer breaks. An economics consumer reads events where `role` is
present as one priced delegation each; `escalated_from` marks the entries that
cost more because a gate caught a cheaper tier.

## Completion Rules

Execution is complete only when:
- all planned waves are complete or explicitly blocked
- modified files are recorded in the session/deliver artifact or an evidence sidecar that the verifier can read; do not store them in `state.json` unless the workflow state schema supports that field
- sandbox mode and approval/rollback assumptions are recorded when relevant
- local validation attempted for changed areas
- failures caused by the execution are fixed or reported as blockers
- remaining gaps are ready for verification rather than hidden in the final summary
