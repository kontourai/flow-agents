# Run Correlation Contract

> Read [`context/contracts/standing-directives.md`](standing-directives.md) — ratified owner directives that override default engineering conservatism.

The run correlation envelope is the portable identity carrier for joining one
workflow execution across runtime telemetry, Flow state, trust references,
economics, delegation lineage, and terminal outcomes. Flow Agents creates or
accepts the opaque `correlation_id`; consumers treat it only as an equality key.

Every identity slot is explicit. A runtime or producer records `present` with
the authority-owned identifier, or records `unavailable`, `unsupported`, or
`not_applicable` with a non-sensitive reason. Consumers must not infer a missing
identity from paths, timestamps, working directories, process ancestry, or
similarity.

The envelope carries references; it does not replace the owning records:

- Flow remains authoritative for workflow run and step identities.
- Runtime adapters remain authoritative for session, turn, trace, and span
  support.
- The work-item provider remains authoritative for work-item identity.
- Terminal record producers remain authoritative for their outcome record.

The same envelope is embedded unchanged in each participating record. Extension
fields are not permitted in version 1. New identity classes require a new
contract version so older consumers fail visibly instead of silently dropping a
join dimension.

Runtime adapters declare support for every identity slot through
`runtimeCorrelationIdentityDeclaration`. `supported` means the adapter can
observe that identity when the host supplies it; `partial` names the host mode
where it is absent; `unsupported` means the host cannot expose it; and
`not_applicable` means another authority owns the slot. These declarations do
not manufacture values.

Use `attachRunCorrelation` for runtime events, Flow projections, trust
references, economics records, delegation facts, and terminal outcomes. It
validates and defensively copies the envelope, preventing later mutation from
cross-joining otherwise independent records. `readRunCorrelation` returns an
explicit `incomplete` result for older records that omit the field. Consumers
must preserve that status and must not repair it from neighboring timestamps,
paths, work items, or sessions.

Builder Flow runs accept the envelope as `correlation` when started. The
`flow_run` identity must be present and must equal the requested run id. Flow's
string-only parameter contract stores the canonical JSON bytes; Builder load
and evaluation validate those bytes before exposing them. Trust evidence
analytics carry either the same envelope or the explicit incomplete result.

`reconstructRun` rebuilds a run account from identity-bearing facts only. A
complete account contains runtime session and turn facts, tool results, Flow
gates and route-backs, delegations, trust references, economics, and a terminal
outcome. Delegation facts may point to a child correlation id, making a nested
run discoverable without using prompt text, paths, timestamps, or process
ancestry. Facts from concurrent runs remain separate even when every surrounding
label is identical.

Evaluation identity remains external. `joinIndependentEvaluation` joins an eval
cell, attempt, and independent grade through the correlation id after
reconstruction. Run facts reject experiment arms, grade status, scores, and eval
identifiers. Process completion and task-quality acceptance are separate
booleans: a run can finish successfully while an independent grader rejects its
quality.

This is intentionally an embedded value rather than a standalone Kontour
Resource Contract. It has no independent lifecycle, desired state, authority,
or status conditions; wrapping every occurrence in resource metadata would
multiply identities and make equality joins less reliable. The telemetry,
workflow, trust, economics, delegation, and terminal records that contain it
retain their own resource or native record shapes.

Import `createRunCorrelationEnvelope`, `validateRunCorrelationEnvelope`, and the
related types from `@kontourai/flow-agents`. The JSON Schema ships at
`@kontourai/flow-agents/schemas/run-correlation-envelope.schema.json`.
