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

Every current-gate claim in a Flow-bound session is stamped with the exact
projected `run_head` at record time, and synchronization rejects missing, mixed,
or stale stamps. Pre-upgrade unbound current-gate claims must be re-recorded;
they are never silently rebound to a later canonical head. Regenerate an old
projection and re-record through `flow-agents workflow evidence --session-dir
<session-dir> <evidence options>`, then inspect the recovered result with
`flow-agents workflow status --session-dir <session-dir> --json`. If evidence writing
commits bytes but later reports a durability failure, the public wrapper moves
those bytes to a unique inert quarantine artifact and restores the prior live
bundle with creation-only operations, preserving both audit data and concurrent
writes.

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
`plan_gap` is therefore not a universal command: a Builder `execute` claim may use it
only when that run's current `execute-gate` declares `plan_gap -> plan`. The Builder
definition bounds that correction to three Flow-owned attempts and blocks on exhaustion;
there is no default execute route. Status and sync are read-only/reprojection operations,
not implicit backtracking or definition amendment.

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

Route-back changes the canonical head. A gate-action envelope derived before an
`execute -> plan` correction is stale and cannot authorize evidence or progress for the
new plan head; callers must obtain the newly projected envelope after Flow records the
route.

An authorized Flow definition amendment also changes the canonical head. The immutable
`definition.json` continues to authenticate the installed Builder definition that started
the run, while Flow 3.6 validates the complete amendment ledger and its effective successor
drives gates and projections. The adapter accepts that successor only when it is byte-for-byte
the shipped composed Builder definition; an arbitrary old origin or unshipped successor cannot
be projected. Envelopes,
progress snapshots, and sidecar `flow_run` projections bind the successor's version and
SHA-256 digest. A pre-amendment envelope therefore fails canonical snapshot validation even
when the run id and current step are unchanged. Legacy unamended runs remain readable without
a projected digest.

An active continuation turn is also bound to that effective version and digest. Stop and
public evidence validate the full Flow ledger before honoring its signed capability, so a
capability issued before an amendment cannot be replayed against the amended head; the next
turn receives a fresh capability for the new identity.

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

`publish-change` is an authenticated, provider-neutral operation. Its envelope binds
the `change.create` capability, bounded command inputs, the canonical run and current
gate visit, the required provider result, and the dedicated session-relative
`publish-change.result.json` artifact. When the effective ChangeProvider is configured,
the envelope projects the exact executable argv `flow-agents publish-change execute
--session-dir <session-dir>` plus typed title/body/base/head/draft parameters. When it
is absent or incompatible, the envelope remains `external_capability_required` with an
`external_verification_required` wait state and no executable completion claim.

The public command derives repository, immutable head SHA, assignment actor, provider
configuration identity, run identity, and gate-visit identity under the Flow subject lock.
It invokes the configured ChangeProvider outside that lock as necessary, then the
Flow-owned completion transaction reacquires the lock and re-reads canonical state.
It rejects any assignment transfer, gate movement, replay, configuration change, or
request/result mismatch before persisting the bounded result. Only an authenticated,
fresh provider observation can write `publish-change.result.json`; it contains the
binding, provider configuration/adapter, repository, provider record id/number/HTTPS
URL, normalized published state (`open` or `merged`), base/head refs and immutable SHA, the bound `assignment_actor`,
the authenticated GitHub `provider_actor`, and observation timestamp.

Flow attaches exactly the `pull-request-opened` evidence for that issued operation,
requires it to advance the bound gate exactly one canonical step, and projects the result. It does not treat generic
driver evidence, caller-authored JSON, arbitrary expectation ids, or package-private
writers as completion authority. The transaction uses no-follow bounded file handling
and removes its temporary evidence after evaluation. Adapter authentication data and
provider diagnostics are not persisted in session files, trust bundles, diagnostics,
logs, or snapshots.

GitHub is the first adapter, not Flow vocabulary: it uses a fixed, trusted absolute `gh`
executable and direct argv (never a shell or caller-controlled `PATH`) to authenticate, create,
list, and re-observe pull requests. Before creating it
recovers one exact published record matching repository, base, head ref, immutable SHA, title,
body, and draft state. Open records cover the normal path; merged records cover reconciliation
after provider work completed ahead of the local run. After an ambiguous create failure it performs the same recovery
query before reporting failure, so retry does not blindly duplicate a pull request.
Multiple exact matches, a closed-but-unmerged/stale/wrong record, malformed output, unavailable
provider, or failed authentication leaves the canonical gate unresolved and requires
the public operation to be retried only after the underlying condition is corrected.

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

The envelope, its prior-turn delta, and `context_strategy` are additive fields of
`ContinuationTurnRequest` schema `1.0`; adapters that only consume the existing
request fields remain compatible. `context_strategy` tells a capable adapter to
start a `new` context or `resume` the mission context and identifies the handoff
as canonical. The mission-bound policy defaults to warm continuation; selecting
fresh context changes only transcript routing, never the Flow contract, gate
requirements, or evidence authority. When `workflow drive` produces its optional
signed request/result attestation, the exact request object (including the
envelope and context strategy) is included in the signed payload without
transformation.
# Builder Lifecycle Authority

The canonical Flow run owns pause, resume, and cancellation. The current assignment actor may
pause, resume, or release its own assignment with a reason. Cancellation and archival require
an Ed25519-signed authorization record conforming to
`schemas/builder-lifecycle-authorization.schema.json`. The record is operation-bound and binds
the request to the run id, selected Work Item, current assignment actor, immutable external
request reference, nonce, and expiry. Flow Agents serializes the request to an independently
provisioned protocol-v1 helper pinned at
`/usr/local/libexec/kontourai/flow-agents-lifecycle-authority-v1`. Callers cannot override that
identity or select another root-owned executable. The helper and every
path component must be OS-owned, outside the project/package/worktree, and non-writable by the
runtime user, group, and world. The external helper owns verification, locking, nonce replay
protection, compare-and-swap, critique edge/history persistence, canonical evidence attachment, Flow
synchronization, and all other authoritative writes; package JavaScript never enacts a mutation from
a helper return value. Flow Agents ships the public coordinator and installer, but no keys or deployment-specific configuration.
Missing or untrusted helpers fail closed.

The wire contract is one canonical JSON request line and exactly one JSON response line. Both bind
protocol version, action, and canonical request SHA-256; accepted responses also carry an exact
action-specific result. Unknown/extra fields, actions, versions, digests, statuses, empty output,
multiple output records, and malformed JSON fail closed. The helper independently canonicalizes and
constrains all received paths, derives root relationships itself, and never treats caller-provided
paths as trusted merely because the package serialized them. A positive end-to-end mutation remains
`NOT_VERIFIED` when the administrator-owned helper and pinned verification key are absent.
Package-side validation does not call a live verification action; it verifies the immutable signed
completion locally and binds its result digest to the exact resolution graph before Builder consumes
the transition.

The public reference coordinator source is
`packaging/lifecycle-authority/coordinator.mjs`. Administrators install, upgrade, or roll it back at
the pinned path with `sudo scripts/lifecycle-authority-admin.sh <install|upgrade|rollback> [coordinator.mjs] [node_modules]`.
The script stages the exact `@kontourai/flow` 3.5.0 package (once published) and its runtime dependencies
under the root-owned coordinator directory, then checks the reducer's public artifact identity and
hash from `packaging/lifecycle-authority/flow-reducer-v1.json`. It preserves one prior coordinator,
pin, and staged reducer for rollback and enforces root ownership and protected mode; it does not
create registries, signing keys, or deployment-specific configuration. The coordinator fixes those
administrator-owned inputs under
`/etc/kontourai/flow-agents-lifecycle-authority-v1` and durable locks/completions under
`/var/lib/kontourai/flow-agents-lifecycle-authority-v1`.

### Canonical manifest and completion-key boundaries

The coordinator permits at most 16 MiB only when it reads the canonical Flow evidence
manifest (`.kontourai/flow/runs/<run-id>/evidence/manifest.json`) for a signed critique
resolution. This is an isolated `MAX_CANONICAL_FLOW_MANIFEST_BYTES` boundary: canonical
definition and state reads, trust bundles, authorizations, journals, keys, responses, and all
other bounded inputs retain their smaller existing limits. The manifest is still opened with
`O_NOFOLLOW`, must be a regular file with no group/world write bit, is read through the protected
descriptor, and must parse as JSON. Raising this one size limit does not permit streaming,
lossy parsing, writable files, or a broader input-size relaxation.

Package-side completion verification always uses the fixed administrator-owned public-key path
`/etc/kontourai/flow-agents-lifecycle-authority-v1/completion-verification-key.pem`; callers and
environment variables cannot substitute a key path. On Darwin alone, the fixed root `/etc`
component may be the standard protected alias that resolves exactly to `/private/etc`. Every
resolved component, including `/`, `/private`, `/private/etc`, and the fixed descendants to the
key, must be root-owned and group/world non-writable; after that one alias, every component must
be non-symlinked. The final key is opened with `O_NOFOLLOW` and validated from its descriptor as
a protected regular Ed25519 public key. Arbitrary alias targets, deeper symlinks, writable or
non-root-owned components, and every symlink on non-Darwin hosts fail closed. This exception does
not apply to lifecycle-helper installation: the pinned helper path remains symlink-free through
every component.

The public package executes this helper only as `sudo -n -- <pinned-helper>`. Installation creates
the dedicated `kontourai-lifecycle-operator` group (or the explicit fourth installer argument) and
a `visudo`-validated, exact no-argument rule in `/etc/sudoers.d/`; `env_reset` and a fixed
`secure_path` apply to that command. The rule grants only execution of the fixed helper. It does
not bypass the signed authorization, protected key registry, replay lock, preimage CAS, or any
other operation checks in the helper.

Current implementation status is intentionally incremental and fail-closed. The separately installed
`runtime-v1.mjs` artifact contains the pure, deterministic critique-resolution reducer; both its
bytes and the signed completion bind a runtime digest. For critique resolution, the coordinator
uses the staged, exact Flow trust-attachment reducer to attach the authoritative post-resolution
bundle and synchronize the canonical Flow manifest, state, and reports. Flow attachment semantics
therefore remain Flow-owned; the coordinator owns only locked CAS and writes described by the
reducer. The coordinator writes its signed completion as the separate session-relative
`lifecycle-authority.completion.json` receipt and its append-only authorization events in
`lifecycle-authority.resolution-events.json`, while both the session trust bundle and the
Flow-attached bundle remain schema-valid Hachure bundles. Package JavaScript reads the pinned,
root-owned Ed25519 public verification key and cryptographically validates that receipt's immutable
bindings read-only; it never turns the response into a package-side mutation. The coordinator also invokes
Flow's canonical cancellation transition, then releases the exact bound local assignment; archival
requires a canceled or completed canonical Flow run and atomically relocates only the session to
`.kontourai/flow-agents/archive/<slug>/`. Positive root-owned installation remains
`NOT_VERIFIED` pending the root/container conformance lane.

An administrator upgrade copies the direct coordinator source
`packaging/lifecycle-authority/coordinator.mjs`; it is not generated package output. The signed
`coordinator_runtime_sha256` field deliberately continues to identify the separately installed
`runtime-v1.mjs`, so an upgrade proves coordinator source-to-installed byte equality and SHA-256
separately. The installer keeps its prior coordinator, runtime, pin, and reducer closure for
rollback. Neither the package caller nor an authorization record can override the helper, key, or
installed source selected by this boundary.

Runtime or harness adapters hold the private key and capture the signed record from a
user/operator channel they trust; agent-authored prose or an unsigned model-written file is not
cancellation authority. Repository files, package bytes, and Git refs are explicitly never
authority roots. Flow's
current lifecycle authority vocabulary also requires agent-owned pause/resume events to use the
closest available `operator_request` shape; a distinct canonical runtime authority is tracked in
Flow issue #118.

```text
flow-agents builder-run pause --session-dir <dir> --reason <text>
flow-agents builder-run resume --session-dir <dir> --reason <text>
flow-agents builder-run cancel-request --session-dir <dir> [--out <file>] [--reason <text>] [--actor <name>] [--expires-in-hours <n>]
flow-agents builder-run cancel --session-dir <dir> --authorization-file <record.json>
flow-agents builder-run release-assignment --session-dir <dir> --reason <text>
flow-agents builder-run archive --session-dir <dir> --authorization-file <record.json>
```

Pause and resume verify the live assignment actor under the assignment lock, and preserve the
current Flow step and assignment. Assignment release does not
change the Flow run. Cancellation changes Flow first and then idempotently releases the owning
assignment while holding the same lock inside the external helper; a successfully consumed
cancellation nonce cannot be replayed. Archive accepts only completed or canceled runs, moves the session under
`.kontourai/flow-agents/archive/<slug>/`, and retains the canonical Flow run. None of these
operations deletes a branch or worktree; cleanup requires a separate provider-aware action.

`cancel-request` is a **read-only convenience** that removes the friction of hand-assembling a
cancellation record: it mints the *unsigned* authorization for the run (correct `run_id`,
`subject`, active `assignment_actor`, a fresh `nonce` and expiry) and prints the exact
`signing_payload` bytes to sign. It does not sign, cancel, or mutate anything — the operator signs
the payload with their Ed25519 lifecycle-authority key, adds the `signature` block to the emitted
file, and runs `cancel --authorization-file` as above. The signing payload is produced through the
same actor/request normalization the verifier applies, so a signature over it verifies by
construction. Like `cancel`, it requires an active assignment holder; an active run whose
assignment has already been released cannot be authorized this way without re-claiming it first.
For legacy persisted assignments, an actor that omits only `human` is treated as the canonical
`human: null` identity during lifecycle authorization construction and live-holder comparison.
This compatibility rule does not rewrite the persisted assignment and does not relax any other
actor field or non-null human identity.
