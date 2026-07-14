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
Synchronization selects only live claims: producer-superseded claims and claims
carrying `metadata.superseded_by` remain auditable history but never determine
the current outcome. Passing evidence is published atomically only when every
required expectation for the gate is present; this prevents sequential critique
writes from attaching an intermediate partial snapshot and consuming a
route-back attempt. Failed evidence may still synchronize immediately when it
carries a route reason declared by the gate; a disputed report-only critique is
not itself a routed gate decision and remains pending.

Attachments carry the exact expectation ids selected from the current bundle.
Digest idempotence applies only while an unsuperseded attachment for that gate
and expectation set remains live. After route-back, claims must be current for
the new gate visit before synchronization, and claim/evidence identities used
by any earlier attachment to that gate can never satisfy the later visit.
Gate claims, verified criteria, and critiques carry producer-recorded version
timestamps plus `identity_version: 2` in their identity derivation so legitimate
re-verification creates new identities. Unmarked pre-upgrade records retain the
legacy identity formula during rebuild; installing new code alone can never
manufacture a fresh identity. Because those identities are embedded in TrustBundle bytes, a
genuinely new identity necessarily changes the bundle SHA-256; byte-identical
replay remains pending rather than consuming another attempt.

Every gate visit has a canonical boundary: the latest Flow transition into the
step, or the run's initial timestamp for its entry step. Claim creation and
observation timestamps must fall within that visit and may not be more than 30
seconds ahead of synchronization. The sole pre-boundary allowance is the
30-second acquisition window for the assignment-backed `selected-work` claim,
which is intentionally produced immediately before the canonical run starts.
Previously attached claim and evidence identities are excluded from every later
visit to the same gate regardless of timestamp skew.

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

Projection is always derived from the canonical run's `current_step`, including
composed steps that have no legacy sidecar phase (`merge-ready-ci` and `learn`).
Both the legacy `current.json` pointer and every matching per-actor pointer are
updated from that canonical step; `phase_map` is presentation metadata, not the
authority for pointer navigation.

### Gate-Action Envelope

Every active Builder continuation request includes a bounded
`gate_action_envelope` with schema version `3.0`. Flow Agents derives it from
the persisted canonical Flow run and effective Flow Definition, then joins it
to the installed Builder Kit's validated `flow_step_actions` record. It is an
execution context, not a second gate evaluator: Flow remains the only authority
that evaluates requirements, advances steps, routes back, or consumes attempt
budget.

The envelope provides the current gate ids and claim shapes, including each
expectation's required flag and `satisfied`, `accepted_exception`, or `unresolved`
status. Accepted exceptions are identified separately. Flow Agents evaluates
these statuses with the run's effective Flow config, including gate overrides,
so waived, satisfied, and optional work is never mislabeled as required. Skill
identities bind package, version, stable package-relative source
path, and SHA-256, so durable attestations never retain a stale absolute install path.
Requirement status comes from Flow's canonical gate evaluation and therefore
uses the expectation's trust-bundle selector, Surface-derived claim status,
supersession, freshness, and current gate visit; `expectation_ids` labels alone
never mark a requirement satisfied.
Declared operations, artifacts, and evidence expectation ids come from product
metadata. `implementation_allowed` is also product metadata; the shipped Builder
Kit declares it true only for `builder.build/execute`.

Declared artifact targets are typed. A `file` target includes its resolved
project-relative path under the active session, its direct-write policy, and
the skill or external operation that produces it. Operation result files are
not model-writable. A `trust_slice` target names a
logical `trust.bundle#<slice>` projection, sets `direct_write_allowed` to false,
and identifies the public evidence or critique interface that records it. A
trust slice is never a filename and adapters must not edit `trust.bundle`
directly.

The read-only status interface identifies the exact package version, binary,
and argv without requiring an adapter to parse a shell command. Mutation
interfaces are typed per expectation: `workflow.evidence`, `workflow.critique`,
or a named product operation such as `publish-change`. Evidence and critique
interfaces expose fixed argv plus typed required parameters and allowed values;
they do not publish shell strings with substitution placeholders. Structured
evidence parameters reference `public_interfaces.schemas.evidence_ref_json`, a
bounded JSON Schema with required fields for source, command, artifact,
provider, and external evidence. Consumers add parameter values as distinct
argv entries.

Adapters that perform an allowed direct file write remain responsible for
opening the target without following symlinks and for confirming that the final
path remains inside the active session. The envelope declares authority and
identity; it does not make an arbitrary adapter filesystem write atomic.

`publish-change` is a provider-capability protocol, not a claim that the local
`flow-agents publish-change` helper opens a pull request. Its envelope binds the
exact `pull_request.create` capability, bounded structured inputs, the required
provider result, and the dedicated session-relative
`publish-change.result.json` artifact. No authenticated ChangeProvider executor
ships in this issue, so the operation is explicitly unavailable locally and has
an `external_verification_required` completion state. It exposes no
`record_completion` mutation, a self-authored result cannot satisfy
`pull-request-opened`, and the projection waits instead of scheduling repeated
adapter turns. The protocol remains the future provider contract. The local
publish-change helper only renders and validates publish artifacts and provider
checks; it is not the provider action executor.

`flow_step_actions` must explicitly declare `artifacts`, `artifact_bindings`,
`expectation_ids`, `expectation_bindings`, and `implementation_allowed`, including
empty lists for terminal actions. Expectation ids must exactly equal the resolved
Flow expectation set. Artifact bindings map each artifact to its owning
expectations, allowing optional artifacts to remain declared without appearing
under `stop_condition.required`. The same ownership is projected publicly as
typed `action.artifact_bindings`; consumers derive required targets by selecting
bindings that own an unresolved required expectation. These bindings are
product-owned gate semantics, not grader hints or consumer-authored guidance.
For file artifacts, an empty `expectation_ids` list keeps the artifact declared
and observable but never gate-required. Trust slices must own at least one
expectation because ownership determines their recording interface.
Operation bindings must resolve through the
canonical public operation catalog, not merely a self-declared string. Artifact
refs are either lexically safe session-relative paths or validated
`trust.bundle#<safe-id>` virtual refs; absolute paths, traversal, and arbitrary
fragments fail closed. Malformed,
unknown-field, duplicate, oversized, unmatched, symlinked, or otherwise
unbounded action metadata fails closed before an adapter is launched. The
runtime verifies every named skill against the installed Builder package and
binds its contents by SHA-256. Kit JSON, skill source, and artifact identity/hash
reads open the final path once with `O_NOFOLLOW`, bound size from `fstat`, read
through that descriptor, and recheck descriptor/path identity after the read.
Run-wide artifact observation deduplicates refs and enforces count plus aggregate
byte/hash budgets before reading file contents. Product validation and runtime
both cap each action at 16 skills and each flow at 128 distinct observable file
artifacts; virtual trust-bundle refs and control artifacts are excluded using the
same classification in both layers.

After every successful or failed adapter turn, Flow Agents synchronizes the
canonical run and records a delta: step advancement, newly attached canonical
evidence, changed hashes of declared artifacts (`artifact_changes`), or no
progress. Evidence identities and the artifact manifest are run-wide rather
than selected-step scoped, so the evidence/artifact that advances a gate remains
attributable and files already present for later steps are part of the baseline.
Control `state.json` is excluded from both request-facing declared/required
artifacts and artifact progress. Legacy kit ownership metadata may retain it,
but the envelope never instructs an adapter to produce Flow Agents control
state or observes its own hash. Repeated
no-progress deltas are classified as `possible` and then `stagnant`; they never
invent evidence, auto-pass a gate, or change Flow state. A same-step evidence
attachment is recorded as progress even though the legacy `gate_not_advanced`
event remains for compatibility. Adapter-returned `evidence` remains optional
adapter telemetry only and is never gate evidence.

The durable `last_progress` snapshot is the recovery baseline. A durable active
turn phase and pre-turn snapshot identify an adapter turn interrupted before its
post-turn measurement. Reinvocation compares freshly synchronized canonical
state with that snapshot, counts an unchanged started turn as no progress exactly
once, records any delta, and clears the recovery marker. Synchronization and this
reconciliation occur before waiting or terminal disposition handling, so the
turn's audit and progress survive either outcome. Accepted turns, wait turns, and
callback failures are likewise synchronized and measured before their durable
turn marker is cleared. Signed workflow drives preflight the aggregate attestation
capacity before launching an adapter when another bounded signed result cannot fit.
Accepted request/result pairs and their measured progress are first stored in a
durable idempotent journal while the active turn remains in `measured` phase.
Only after journal and completion-event persistence does the driver clear that
marker. Restart completes either write exactly once. Signed attestations reload
the journal and fail closed if an accepted event lacks request/result coverage.
The complete serialized turn result is capped at 74,000 bytes; signed preflight
reserves that exact maximum in addition to the actual request and JSON structure.
The authoritative envelope
exists only at top-level in the turn request; projected `next_action` and durable
`state.json` do not contain a duplicate.

Canonical synchronization normally waits for attached bundle evidence before
evaluating a gate. It may evaluate an evidence-free gate only when the run's
effective config proves the gate can pass without new evidence: an accepted
exception applies, or every effective expectation is optional. This advances
those gates without prematurely evaluating ordinary missing-required gates, and
once the run advances no obsolete action skill remains required.

The envelope and its prior-turn delta are additive fields of
`ContinuationTurnRequest` schema `1.0`; adapters that only consume the existing
request fields remain compatible. When `workflow drive` produces its optional
signed request/result attestation, the exact request object (including the
envelope) is included in the signed payload without transformation.
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
