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

A Builder session must first be created at the Flow Definition's entry step by the
workflow sidecar. Start the canonical run with:

```bash
flow-agents builder-run start --session-dir .kontourai/flow-agents/<slug>
```

`start` requires exactly one `state.work_item_refs` entry and uses that stable Work
Item reference as the Flow run subject. It is idempotent for an existing canonical
run. A direct primitive session without a Builder Flow stamp remains independent and
does not create a Flow run.

After a gate producer writes `trust.bundle`, the sidecar writer synchronizes an
existing run automatically. Interrupted clients can replay the projected command:

```bash
flow-agents builder-run sync --session-dir .kontourai/flow-agents/<slug>
```

Synchronization is digest-idempotent. The same trust bundle is not attached twice.
Inspection loads the run without evaluating it, so invalid evidence is rejected
before Flow mutation.

## Recovery

Recover an interrupted canonical Builder session with:

```bash
flow-agents builder-run recover --session-dir .kontourai/flow-agents/<slug>
```

`recover` derives the Flow run id from the session directory slug; callers cannot
select a run id or step. It requires exactly one non-empty
`state.work_item_refs` entry, loads the existing run through Flow's canonical load
API, and verifies that the ref matches persisted `state.subject` and, when present,
`state.params.subject`. A missing, foreign, or corrupt run fails closed and is not
created or repaired.

Recovery is load/validate/project only. It computes the complete projection before
updating `state.json`, the matching global `current.json`, and matching per-actor
current pointers. It does not inspect or attach `trust.bundle`, evaluate gates, or
write any file in `.kontourai/flow/runs/<slug>/`; the complete Flow run tree remains
byte-identical. Use `sync`, not `recover`, to attach recorded evidence and evaluate
the current gate.

## Trust Binding

Claims relevant to the current gate must carry
`metadata.workflow_subject_ref` equal to the persisted Flow run subject. Unrelated
claims are ignored for that gate. A relevant claim with a missing or different
subject reference is rejected; Flow is not mutated.

A failed gate claim may include a Flow classifier through
`record-gate-claim --status fail --route-reason <reason>`. Flow validates the reason
against the gate's `on_route_back` map and owns both the destination and attempt
budget. Flow Agents only projects the resulting attempt and maximum into `state.json`.

## Agent Projection

While a run is active, `state.json` contains:

- `flow_run`: canonical run identity, current step, open gates, run reference, and
  route-back attempt information when present.
- `next_action.skills`: ordered Builder skills for the current step.
- `next_action.operations`: ordered non-skill product operations when present.
- `next_action.summary`: required gate claims derived from the Flow Definition.
- `next_action.command`: the exact idempotent synchronization command.

Workflow steering surfaces these fields on session start and prompt submission. The
Stop hook treats an unfinished canonical Flow run as active even during pickup or
planning, blocks a premature stop in block mode, and does not release its liveness
claim. A run is complete only when Flow reaches its terminal step.
