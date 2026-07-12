# Builder Flow Runtime

Builder Kit build sessions use Flow as the authority for steps, gates, transitions,
route-backs, and attempt limits. Flow Agents supplies the agent-facing adapter: it
starts or loads the canonical run, attaches the session trust bundle, and projects
Flow's current state into the existing workflow sidecars.

## Ownership Boundary

- Flow persists generated run state under `.kontourai/flow/runs/<run-id>/` and owns
  Flow Definition evaluation.
- Builder Kit declares agent actions for each Flow step in `kit.json` under
  `flow_step_actions`. Actions name skills or product operations; they do not alter
  Flow transitions or gate outcomes.
- Flow Agents compiles its kit-level `uses_flow` extension and gate-less `done`
  sentinel into one Flow-native effective definition. The generated definition is
  content-addressed under `.kontourai/flow-agents/runtime-definitions/`; Flow then
  owns all evaluation of that definition.
- Flow Agents writes product session artifacts under
  `.kontourai/flow-agents/<slug>/`, produces Hachure trust bundles through Surface,
  and projects the canonical Flow run into `state.json` and `current.json`.
- Durable Flow Definitions remain authored under `kits/builder/flows/`. Generated
  state has no `.flow/runs` fallback.

The adapter contains no benchmark, task, filename, or grader-specific guidance.
It derives its next action from the persisted Flow step, the current gate's declared
expectations, and Builder Kit's structured action map.

## Entry And Synchronization

A Builder session is created at the Flow Definition's entry step by the public
workflow command. Start the selected Work Item with its stable, human-readable
provider reference:

```bash
flow-agents workflow start --flow builder.build --work-item <provider-ref> \
  --assignment-provider <configured-kind> \
  [--effective-state-json <provider-status.json>]
```

The configured provider resolves and durably assigns the exact Work Item to the
workflow actor. Non-local adapters pass their standard status result to start;
Flow Agents retains it as provenance and creates a local runtime lease mirror.
The start path then produces the declared
`builder.pull-work.selected` claim through the normal Surface trust bundle path.
Flow evaluates that subject-bound evidence and advances to `design-probe`; Flow
Agents does not write a transition or gate outcome directly. Skipped ownership,
unresolved actors, precomputed state, and unavailable provider resolution do not
produce selection evidence and remain at `pull-work`.

If start fails, the failure is returned to the caller and no substitute run state
is invented. Runtime hooks keep projected actions advisory while the agent
performs their declared skills and operations.

Sidecars written by 3.4.2 may still contain `next_action.enforcement`. The 1.0
schema accepts that deprecated field for artifact compatibility, but current
runtime steering ignores it and does not install a PreToolUse bootstrap hook.

`start` requires exactly one `state.work_item_refs` entry and uses that stable Work
Item reference as the Flow run subject. It is idempotent for an existing canonical
run. A direct primitive session without a Builder Flow stamp remains independent and
does not create a Flow run.

After a gate producer writes `trust.bundle`, the public evidence path
synchronizes the existing run while holding the assignment subject lock.
Synchronization is digest-idempotent: the same trust bundle is not attached
twice.

## Public Status And Recovery

Inspect an interrupted canonical Builder session with:

```bash
flow-agents workflow status --session-dir .kontourai/flow-agents/<slug> --json
```

`workflow status` is read-only. It loads the canonical run and reports its run
identity, definition, status, current step, projected `next_action`, and bound
session directory. Callers cannot select a different run or force a step.

For an active interrupted run, continue from the reported `next_action` and use
its exact idempotent command to recheck the canonical state. The current step's
producer records gate evidence through `flow-agents workflow evidence`; that
public operation validates assignment and observations before attaching the new
trust-bundle digest and evaluating the gate. For a paused run, the current
assignment actor resumes it with an explicit reason:

```bash
flow-agents workflow resume --session-dir .kontourai/flow-agents/<slug> --reason <text>
```

Do not use a private synchronization or recovery command, manually project run
state, or create a replacement run for a missing, foreign, or corrupt binding.

## Trust Binding

Claims relevant to the current gate must carry
`metadata.workflow_subject_ref` equal to the persisted Flow run subject. Unrelated
claims are ignored for that gate. A relevant claim with a missing or different
subject reference is rejected; Flow is not mutated.

A failed gate claim may include a Flow classifier through
`flow-agents workflow evidence --status fail --route-reason <reason>`. Flow validates the reason
against the gate's `on_route_back` map and owns both the destination and attempt
budget. Flow Agents only projects the resulting attempt and maximum into `state.json`.

## Agent Projection

While a run is active, `state.json` contains:

- `flow_run`: canonical run identity, current step, open gates, run reference, and
  route-back attempt information when present.
- `next_action.skills`: ordered Builder skills for the current step.
- `next_action.operations`: ordered non-skill product operations when present.
- `next_action.summary`: required gate claims derived from the Flow Definition.
- `next_action.command`: the exact idempotent public status command for reorientation.

Workflow steering surfaces these fields on session start and prompt submission. The
Stop hook treats an unfinished canonical Flow run as active even during pickup or
planning, blocks a premature stop in block mode, and does not release its liveness
claim. A run is complete only when Flow reaches its terminal step.
# Builder Lifecycle Authority

The canonical Flow run owns pause, resume, and cancellation. The current assignment actor may
pause, resume, or release its own assignment with a reason. Cancellation and archival require
an Ed25519-signed authorization record conforming to
`schemas/builder-lifecycle-authorization.schema.json`. The record is operation-bound and binds
the request to the run id, selected Work Item, current assignment actor, immutable external
request reference, nonce, and expiry. Its signing key must be pinned in the durable
`.flow-agents/lifecycle-authority-keys.json` registry. Runtime or harness adapters hold the
private key and capture the signed record from a user/operator channel they trust; agent-authored
prose or an unsigned model-written file is not cancellation authority.

This is an audit and policy boundary, not authentication against a process with unrestricted
access as the same operating-system user. The harness must keep its signing key outside the
agent process and enforce its own filesystem or process isolation when the agent is adversarial.
The repository hooks protect the pinned public-key registry from ordinary agent writes, but are
explicitly not an operating-system security boundary.
Adversarial-runtime authentication is tracked separately in Flow Agents issue #545. Flow's
current lifecycle authority vocabulary also requires agent-owned pause/resume events to use the
closest available `operator_request` shape; a distinct canonical runtime authority is tracked in
Flow issue #118.

```text
flow-agents builder-run pause --session-dir <dir> --reason <text>
flow-agents builder-run resume --session-dir <dir> --reason <text>
flow-agents builder-run cancel --session-dir <dir> --authorization-file <record.json>
flow-agents builder-run release-assignment --session-dir <dir> --reason <text>
flow-agents builder-run archive --session-dir <dir> --authorization-file <record.json>
```

Pause and resume verify the live assignment actor under the assignment lock, and preserve the
current Flow step and assignment. Assignment release does not
change the Flow run. Cancellation changes Flow first and then idempotently releases the owning
assignment while holding the same lock; a successfully consumed cancellation nonce cannot be
replayed. Archive accepts only completed or canceled runs, moves the session under
`.kontourai/flow-agents/archive/<slug>/`, and retains the canonical Flow run. None of these
operations deletes a branch or worktree; cleanup requires a separate provider-aware action.
