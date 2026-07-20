# Public Workflow CLI

Flow Agents exposes its supported consumer workflow surface through the primary package binary.
Consumer repositories do not need a `package.json`, a local dependency, or a repository-owned
writer script.

Use an exact package version from an isolated npm prefix. This prevents a repository-local
dependency with the same version from intercepting the command. Generated workflow actions and
doctor remediation include this isolation automatically:

```bash
flow_agents() (
  root=$(mktemp -d) || exit 1
  trap 'rm -rf "$root"' EXIT HUP INT TERM
  npm exec --yes --prefix "$root" \
    --package=@kontourai/flow-agents@3.6.0 -- flow-agents "$@"
)

flow_agents workflow start \
  --flow builder.build \
  --work-item provider:work-item-123 \
  --assignment-provider example-provider \
  --effective-state-json .kontourai/flow-agents/provider-assignment.json

flow_agents workflow status --json

flow_agents workflow evidence \
  --session-dir .kontourai/flow-agents/example \
  --expectation implementation-plan \
  --status pass \
  --summary "Implementation plan recorded." \
  --evidence-ref-json '{"kind":"artifact","file":".kontourai/flow-agents/example/example--plan-work.md","summary":"Reviewed implementation plan with Definition Of Done and task-to-criterion mapping."}' \
  --evidence-ref-json '{"kind":"artifact","file":".kontourai/flow-agents/example/acceptance.json","summary":"Stable acceptance criteria and required evidence."}' \
  --evidence-ref-json '{"kind":"artifact","file":".kontourai/flow-agents/example/handoff.json","summary":"Execution handoff and next action."}'

flow_agents workflow critique \
  --session-dir .kontourai/flow-agents/example \
  --verdict pass \
  --summary "Report-only review found no blocking findings." \
  --artifact-ref ".kontourai/flow-agents/example/example--deliver.md" \
  --lane-json '{"id":"code-review","status":"pass","summary":"The delivered implementation was reviewed.","evidence_refs":[{"kind":"artifact","file":".kontourai/flow-agents/example/example--deliver.md","summary":"Reviewed delivery report and changed scope."}]}'
```

`builder.build` accepts the stable, human-readable Work Item reference emitted by the selected
provider adapter. Flow Agents persists that exact reference as the run subject; it does not infer
provider identity from a GitHub-shaped string. Pass the resolved `--assignment-provider`; non-local
providers also pass their standard assignment status result through `--effective-state-json`.
Flow Agents verifies that the current actor is the confirmed holder, retains that provider result
as selected-work evidence, and creates a local runtime lease mirror for atomic session mutation.
A direct local request can resume an existing bound session, but the public CLI does not invent a
provider or create an unresolvable local binding.

`builder.shape` uses a caller-supplied, safe slug. Derive it from a selected
title using lowercase ASCII words separated by single hyphens. Never inject raw
request text into a shell command or use it as a slug:

```bash
flow_agents workflow start --flow builder.shape \
  --task-slug onboarding-alerts \
  --summary "Shape onboarding alerts into independently actionable slices."
flow_agents workflow status --session-dir .kontourai/flow-agents/onboarding-alerts --json
```

For `tests-evidence`, supply one criterion object for every accepted criterion
and one or more substantive commands that were actually run. Repeat `--command`
when criteria require different checks. Every command needs a matching
top-level command reference, and every passing criterion must cite at least one
of those exact commands. A passing observation must also report a positive executed-test or
assertion count; a successful zero-test run is rejected. Do not use placeholders such as `true`
or a version command as behavior proof:

```bash
flow_agents workflow evidence \
  --session-dir .kontourai/flow-agents/example \
  --expectation tests-evidence \
  --status pass \
  --command "npm test" \
  --summary "The project test command passed for the implemented criterion." \
  --evidence-ref-json '{"kind":"command","excerpt":"npm test","summary":"Exact substantive project test command recorded for this verification result."}' \
  --criterion-json '{"id":"<criterion-id>","status":"pass","evidence_refs":[{"kind":"command","excerpt":"npm test","summary":"Exact substantive project test command run for this criterion."}]}' \
  --evidence-ref-json '{"kind":"artifact","file":".kontourai/flow-agents/example/example--plan-work.md","summary":"Accepted criterion and verification mapping."}'
```

The public lifecycle verbs are `pause`, `resume`, `release`, `cancel`, and `archive`. Pause,
resume, and release require the current assignment actor and an explicit reason. `critique`
records the `clean-critique` claim but does not independently attach it to Flow or advance a gate. Cancel and
archive require a signed user/operator authorization file. Flow owns the canonical run
transition; Flow Agents validates assignment and request binding and projects the resulting run.
Critique derives reviewer identity from the calling runtime actor. An active
implementation assignment is required, and its actor cannot review its own
work; the delegated reviewer invokes the command directly under a distinct
identity. The public interface does not accept a caller-selected reviewer
label. Every critique includes an explicit `pass`, `fail`, or `not_verified`
verdict and at least one substantive `--lane-json`. Passing critiques additionally
require local reviewed `--artifact-ref` values and every lane to pass; reviewed
files and the workspace snapshot are
hashed into the stored review target so later implementation changes invalidate
stale clean critiques.

Current local runtime actor IDs provide coordination-level separation, not a
cryptographic identity guarantee. A policy that requires externally attested
reviewer identity must keep that assurance `NOT_VERIFIED` until the runtime
supplies a trusted delegation credential.

## Resolving repaired critique history

`workflow resolve-critique` closes a historical failing or not-verified review
without deleting it or borrowing the earlier reviewer's identity. It is only
available during `builder.build` verification. It requires an Ed25519-signed
user/operator authorization trusted by the protected
`.flow-agents/lifecycle-authority-keys.json` registry. The authorization binds
the exact run, subject, pre-mutation bundle digest, critique IDs and hashes,
expected resolving reviewer, nonce, request time, and expiry. Ambient runtime
identity and actor overrides do not authorize this operation.

Use immutable `metadata.critique_record_id` values from the two trust-bundle
critique records. The resolving critique must be verified, current against the
workspace, later in the writer-issued predecessor hash chain, and cover every
failed or not-verified lane plus every open finding from the earlier critique.
When both reviews target Git worktrees, the resolving commit must descend from
the earlier reviewed commit. The explicit per-lane and per-finding edges are
the policy-defined relationship between the two reviews.

```bash
flow_agents workflow resolve-critique \
  --session-dir .kontourai/flow-agents/example \
  --prior-record-id '<earlier-critique-record-id>' \
  --resolving-record-id '<later-passing-critique-record-id>' \
  --authorization-file critique-resolution.authorization.json
```

The earlier record remains in `trust.bundle` with its original reviewer,
findings, timestamps, `superseded_by` reference, and `critique_resolution`
audit record. Repeating the identical valid request is a no-op. Missing,
ambiguous, circular, stale, equal-snapshot, wrong-subject, or unauthorized
requests fail without changing the bundle.

The signed authorization is consumed once under the subject lock. Resolution
also appends a separately hashed event binding the authorization digest and
exact edge. The local event chain is tamper-evident; deployments requiring
non-repudiation should additionally retain the signed authorization and anchor
the resulting state in their provider-neutral durable audit store.

```bash
flow_agents workflow pause --reason "Waiting for a decision"
flow_agents workflow resume --reason "Decision received"
flow_agents workflow release --reason "Handing work back"
flow_agents workflow cancel --authorization-file cancel.json
flow_agents workflow archive --authorization-file archive.json
```

`workflow status` is read-only. It reads the actor-scoped current-session pointer, the projected
state, and the canonical Flow run without rewriting either store. Its `next_action` is freshly
derived from the canonical run, so a stale sidecar projection cannot misdirect recovery.

## Bounded Continuation Driver

`workflow drive` lets the active implementation assignment run multiple Flow steps without a
human continuation prompt. Flow remains authoritative: the runtime adapter receives the current
projected action, but its `completed` result means only that one model turn ended. The driver
returns `done` only after the canonical Flow run is terminal.

The adapter command is an explicit JSON argv file whose executable must be an absolute path. Flow
Agents invokes it directly without a shell, writes one versioned continuation-turn request to stdin, and requires exactly one
JSON result on stdout:

```json
{ "argv": ["/absolute/path/to/runtime-adapter", "--profile", "builder"] }
```

```json
{ "status": "completed", "summary": "Turn ended; synchronize canonical evidence." }
```

A completed result may also include a generic JSON `evidence` object of at most 65,536 bytes. Flow
does not interpret its domain semantics. Trust-sensitive callers can ask the long-lived driver to
attest the exact request/result sequence it observed by providing a one-time Ed25519 private key:

```bash
flow_agents workflow drive \
  --session-dir .kontourai/flow-agents/example \
  --adapter-command-file .kontourai/flow-agents/runtime-adapter.json \
  --evidence-signing-key-file /absolute/protected/one-time-ed25519-private.pem \
  --max-turns 6 \
  --json
```

The key file must be an absolute canonical regular file. The driver reads it no-follow and unlinks it
before any adapter starts, retains the key only in driver memory, and adds an
`evidence_attestation` to the final JSON outcome. That attestation carries the public key, a base64
payload containing the canonical outcome and ordered adapter requests/results, and an Ed25519
signature over the exact payload bytes. Consumers must compare the public key with the key they
pinned before launch, verify the signature, and then validate any evidence-specific schema. Without
this optional flag, the released outcome shape and behavior are unchanged.

An adapter may instead park on a process or deadline. A pending barrier is persisted and does not
consume another turn when `workflow drive` is invoked again:

```json
{ "status": "wait", "barrier": { "kind": "pid", "pid": 12345 }, "summary": "Waiting for the verification process." }
```

```bash
flow_agents workflow drive \
  --session-dir .kontourai/flow-agents/example \
  --adapter-command-file .kontourai/flow-agents/runtime-adapter.json \
  --context-policy fresh \
  --max-turns 6 \
  --turn-timeout-ms 900000 \
  --barrier-wait-ms 300000 \
  --json
```

`--context-policy warm` remains the default and requests one new adapter context for the mission,
then resumes it. `--context-policy fresh` requests a new context for every bounded Flow action. Both
policies pass the same canonical gate-action handoff and preserve the same Flow gates, evidence rules,
mission budget, and adapter authority. The selected policy is persisted with the mission and cannot be
changed on resume. Adapters must honor the request's `context_strategy.thread` value and must not infer
context routing from model names. This is a context-management capability, not permission to drop gates,
invent evidence, or replay a prior transcript into a nominally fresh context.

Driver state and its append-only event stream live under
`.kontourai/flow-agents/<slug>/continuation-driver/`. The mission turn count survives reinvocation;
subsequent invocations must use the same `--max-turns` value. The request contains the
canonical run id, definition id, current step, projected `next_action`, iteration, and budget. Builder
turns additionally carry one bounded top-level `gate_action_envelope` with immutable skill identities,
declared artifacts/evidence, requirement satisfaction and unresolved ids, typed public
`workflow.evidence`/`workflow.critique` argv or product-operation bindings, one-turn stop semantics,
product-declared implementation policy, and prior canonical progress/stagnation. Parameter values are
appended as separate argv entries; adapters must not perform string substitution into a shell command. The
envelope is request-only and is not duplicated in projected `next_action` or durable `state.json`. It
does not mutate or replace the runtime system prompt. Adapter errors are recorded as failed turns
and fail open to canonical resynchronization and the next bounded turn; they cannot bypass the
persisted mission budget. The Builder Flow projection supplies the canonical continue/wait/done/failed
disposition, so the generic driver does not duplicate Flow lifecycle semantics. Human-decision and
paused Flow states park, while remediable blocked and accepted-exception states continue; failed Flow
runs stop as failed. Assignment ownership is revalidated before every adapter
turn. A session-scoped process lock rejects concurrent drivers and safely removes unique lock files
left by exited owners. The adapter argv plus the content digests of its executable and absolute
regular-file arguments are bound to the mission on first invocation and rechecked before every turn.
Adapter process groups are terminated after every non-wait result. In addition,
state rollback or deletion is rejected when its append-only event history proves turns already
started. These local coordination records detect accidental or in-process rollback; they are not a
cryptographic boundary against a process that can rewrite the entire artifact directory.

An operation mutation is a structured product protocol, not necessarily a directly executable CLI
command. In particular, `publish-change` identifies the provider capability `pull_request.create`,
its bounded parameters, the required provider result, and `publish-change.result.json` as its dedicated
result artifact. This release has no authenticated ChangeProvider executor. The operation therefore
reports `external_capability_required` and `external_verification_required`, exposes no completion
mutation, and parks the continuation. A locally authored result is not provider evidence. The installed
`flow-agents publish-change` helper renders and validates publish artifacts and provider checks; it does
not create a pull request and must not be treated as the operation executor.

Immediately before spawning an adapter turn, the driver writes a transient, schema-versioned
`active-turn.json` beside its mission state and passes a raw 32-byte turn secret plus the path-safe,
signed run id in `FLOW_AGENTS_CONTINUATION_TURN_SECRET` and
`FLOW_AGENTS_CONTINUATION_RUN_ID` to that child. Only the secret's SHA-256 is persisted in the signed
record. The driver's schema-1-compatible mission state separately stores the ephemeral public-key
digest before the adapter starts, so replacing and correctly re-signing the entire active-turn
record with another key does not replace the signer anchor. The driver clears that digest with the
active-turn step on every completion, error, cleanup, terminal, waiting, and budget path. It replaces
every inherited continuation capability variable but preserves ordinary
`FLOW_AGENTS_ACTOR`. The shared actor
resolver remains ordinary: it never accepts continuation data as an identity override. When an
assignment-gated public workflow command finds that ordinary resolution does not match, it may use
only a live signed active-turn record bound to the exact session, turn secret, run id, assignment file and
actor struct, mission, adapter identity, expiry, and driver lock; it returns the signed assignment
identity only for that active-turn evidence gate. Pause, resume, release, cancel, and archive remain
control-plane operations: they require ordinary actor identity or their existing explicit external
authority and never accept this turn capability. The private key remains only in the driver process.
The Stop hook resolves the signed run id under the canonical artifact root and fully validates that
exact session before consulting ordinary current pointers. Once the base signed turn remains valid,
that exact session stays selected even if canonical Flow has become paused, blocked, completed, or
another canonical disposition; Stop never falls back to a conflicting actor or global pointer. It
securely validates canonical state against the run's definition and treats only canonical `active`
as authority to make the ordinary unfinished
canonical-gate warning advisory so the adapter can return control to the driver. It never advances
a Flow gate, releases assignment or liveness for a continuation-owned nonterminal run, or relaxes evidence, integrity, false-completion,
malformed-state, or configuration blocks. The record is removed when the child completes, errors,
or times out; parent identity changes leave it to expire instead of unlinking through a replacement.

This is cooperative same-user protection, not cryptographic filesystem isolation from a hostile
same-UID process. A same-UID process that can rewrite both mission state and authority records or
control the driver process remains outside this boundary. Within the cooperative boundary, the
mission digest anchors the driver's ephemeral signer, while descriptor reads, final-path inode rechecks, and realpath/device/inode parent
rechecks detect practical replacement races. Active-turn and lock records are capped at 16 KiB;
canonical assignment and continuation mission records are capped at a conservative 1 MiB so valid
provider metadata is not rejected. PID liveness is best-effort only: PID reuse and same-UID process control remain outside this
local coordination boundary.

The event stream records `turn_completed`, `gate_not_advanced`, `turn_failed`, and best-effort
`authority_cleanup_failed`. Cleanup failures are audited but do not replace the adapter or canonical
outcome. Failed turns carry
`failure_kind` of `timeout` or `adapter_error`; a completed adapter turn whose canonical run remains
active at the same current step records `gate_not_advanced`. These events describe driver execution only and do not
change canonical Flow state. Adapter-returned `evidence` is not interpreted as gate evidence; only
the public `workflow evidence` path can attach evidence for Flow evaluation. Same-step canonical
evidence or declared-artifact hash changes are recorded as progress, while repeated no-progress turns are
classified as possible stagnation and then stagnant without fabricating a gate outcome.
Progress uses run-wide canonical evidence/artifact manifests and resumes
from the durable `last_progress` baseline after interruption or reinvocation. Kit metadata, skill source,
and observed artifact reads are bounded descriptor-stable regular-file reads that reject symlinks and
identity changes.
Request-facing declared and required artifacts exclude control `state.json`, even where legacy kit
ownership metadata retains it.
Kit validation and envelope construction both cap an action at 16 skills and a flow at 128 distinct
observable file artifacts, excluding virtual trust-bundle refs and control artifacts consistently.
Synchronization measures an interrupted, waiting, terminal, or callback-failed turn before clearing
its recovery marker. Evidence-free canonical gate evaluation is limited to accepted exceptions and
gates whose effective expectations are all optional; ordinary missing-required gates remain unevaluated.
Signed drives reserve aggregate attestation capacity before adapter execution when another bounded
signed result cannot fit.
The complete serialized adapter result is capped at 74,000 bytes, and preflight reserves that exact
maximum plus the actual request and JSON structure. Accepted request/result pairs and measured progress
are journaled durably before the active marker is cleared. Restart idempotently completes missing audit
writes, and signed attestation fails closed when persisted accepted events lack journal coverage.

## Compatibility Doctor

Run doctor through the exact isolated package helper defined above:

```bash
flow_agents workflow doctor --json
```

The report distinguishes the executing CLI from a repository-local dependency and reports the
workflow/writer contract, installed hook and writer package, active Kits, Builder Kit content,
Flow runtime and definition, workflow-state schema, and trust-bundle schema. Incompatible or
missing installed components produce a nonzero exit and an exact, version-pinned `init` command
that preserves the recorded runtime and active Kits.

The package may use lower-level writer modules internally. They are not a
supported consumer or skill surface. Consumer guidance and Builder skills use
`flow-agents workflow` exclusively.
