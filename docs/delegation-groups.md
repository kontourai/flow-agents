# Delegation groups: contract and durable ledger

This is the first source increment of [#1113](https://github.com/kontourai/flow-agents/issues/1113).
It provides a versioned coordination contract, deterministic projection, host service, and offline
local-file ledger. It does **not** establish the epic's execution acceptance criteria or ship an
executor, mailbox, isolated writer enforcement, or installed-runtime group fixture. The separate
Flow scheduler supports bounded admission, external cancellation, and awaited lifecycle observations;
these hooks are not a composed group executor or authenticated reservation service.

## Public entry points

| Subpath | Purpose |
| --- | --- |
| `@kontourai/flow-agents/delegation-group-contract` | Closed schema 1.0 validators, canonical digests, pure transitions and replay projection |
| `@kontourai/flow-agents/delegation-group` | Transactional service and host/store interfaces |
| `@kontourai/flow-agents/delegation-group-local-file` | `createLocalFileDelegationGroupStore(artifactRoot)` |
| `@kontourai/flow-agents/delegation-authority-contract` | Pure v2 root authority, execution grant and budget validators |
| `@kontourai/flow-agents/delegation-envelope-v2` | Pure v2 envelope narrowing, digests and complete ancestry validation |
| `@kontourai/flow-agents/delegation-dispatch` | Guarded Dispatch invocation with durable result retention and reported-usage settlement |

The same APIs are exported at the package root. Package version and publication are separate from
these source exports. Reference identities are opaque; none grants filesystem access.

## Identity and authority

A group freezes its group id, parent envelope reference, common source, policy revision and digest,
explicit topology, and 1–64 unique seats. Each seat names an independently preauthorized envelope id,
generation and canonical digest, its exact source/worktree binding, and independent work or a Flow
step. Grouping does not mint an envelope or derive authority. The host resolves and authenticates
the exact envelope for the specified group on creation and again on each reservation.

Only root envelopes (`generation: 0`), shared-source report-only membership, and empty mutable
resources are supported. Parent and members must match the group's exact source and policy revision.
They may have distinct preauthorized runtime/model bindings; these remain inside their immutable
envelopes. No envelope field, including correlation, runtime, source or Flow binding, is overwritten.
The local store binds every parent/member envelope id permanently to one group, under its transaction
lock, so creating another group cannot reset spend. Hosts must also prevent reuse across stores.

Recursion and ancestor budgets are explicitly unsupported. Nested groups, child-envelope ancestry,
source diversity, isolated writers, and inferred worktree/session/correlation bindings refuse.
The additive v2 contract describes diversified **derived** children through indivisible, preauthorized
runtime/model/source/worktree/Flow grants. It keeps execution authority separate from the delegation
ceiling: a report-only coordinator can delegate a writer only within an explicitly authorized writer
ceiling and selected grant. Root actor identifies the authorization principal. Exact parent digests,
epochs, spans and complete ancestry are validated; subtree envelope limits include the envelope itself.
Parsing and narrowing do not authenticate issuance, enforce aggregate fanout or reservations, check
current revocation, or confine effects. The current group service still accepts only its v1 membership
contract; v2 service composition remains unfinished. Metadata is not a compatibility bridge.

Topology is either `independent` or an explicit Flow run/definition digest with seat step references.
Flow definition identities retain their native bare 64-character hex digest; group references, policies,
and request digests retain their `sha256:` prefix. There are no local dependency edges or competing
ready-frontier reducer. For Flow work, the host supplies a current loaded definition/state observation,
durable claim, and frontier. The service calls Flow's public `validateDurableStepClaim()` against that
observation, requires the exact claim in its active claim ledger, and compares the frontier against
`projectReadyStepFrontier()` from the same observation. The step-local `claim_base.head` and whole-run
`frontier.run_head` belong to separate contracts and are never compared to each other. Run, definition,
step, actor, expiry, and empty mutable resources must also match. The host remains responsible
for authenticating that these are **current** observations under its execution fence. Caller-provided
claim-shaped JSON alone is not a capability.

## Transaction protocol

Use `groupPolicyDigest()` over the policy excluding its `digest`, and `groupRequestDigest()` over the
request excluding its `request_digest`. Both consume Relay's public canonical JSON/SHA-256 contract.
Unknown properties, non-JSON values, oversized fields and incorrect digests refuse.

Every mutation supplies `operation_id`, canonical request digest, expected ledger revision and
`{controller_id, epoch}` fence. `create` expects revision zero. `take_control` requires the existing
fence, a strictly larger successor epoch, and current host confirmation of the successor ownership.
It changes ledger control only; it cannot fence an external invocation or mutable worktree.

The service runs its entire read/validate/confirm/append transaction under the store lock. Successful
operations and business refusals (such as exhausted ceilings or a closed group) append a decision and
increment the ledger revision. Structural, revision, fence, capability and envelope validation errors
throw before append. Such rejected preconditions are not recorded outcomes. Reusing a recorded
operation id with different intent refuses. Exact replay first calls `confirmController()` with the
original immutable request and the **current** projection/fence. The host must authenticate the current
caller through trusted host context; request metadata and the historical request's controller identity
do not authenticate replay access. Denial throws without yielding a historical result. Authorized replay
returns the **original** outcome and original projection even if the current group has since changed,
expired or cancelled. It does not rerun envelope, readiness, budget or evidence callbacks or reserve
another attempt. `replayed: true` is not
a new dispatch grant. Read the service again for the current projection.

`reserve` atomically allocates an attempt, concurrency slot, input/output tokens and integer cost
micros, and persists a unique dispatch-intent id plus bounded Dispatch plan reference. It never invokes
Dispatch or Relay. Lifetime attempt count and actual spend do not reset on retry. A seat cannot retry
until its previous attempt is terminal **and** fully accounted. Unknown usage also retains its
concurrency allocation. Reservations must fit both group and resolved member-envelope limits.

All newly persisted intents start at `invocation_unknown`: a crash between durable intent and an
external invocation cannot prove whether the effect happened. `invoked` records confirmed invocation
identity. `mark_unknown` records lost contact without erasing that identity or permitting another
invocation attachment. There is no auto redispatch, expired-intent reclaim, timeout refund, or durable
provider invoke-dedup claim. A host must persist intent before any external effect and reconcile an
ambiguous effect through a current authenticated terminal receipt. This increment intentionally
exposes no executable dispatch method.

`terminal` retains bounded output/evidence references and confirmed outcome, while leaving allocation
held. `account` requires a confirmed terminal attempt and complete actual input tokens, output tokens
and cost micros. Missing Relay usage cannot become zero; partial/estimated usage is not accounting.
Complete explicit zero usage is accepted only with host confirmation. Accounting is immutable.
Actual overrun is retained truthfully and closes admission; it cannot be hidden by rejecting the bill.
Any unspent allocation becomes available only after complete confirmed accounting.

`cancel` closes admission in the ledger transaction without waiting for external cancellation evidence.
`cancellation_confirmed` records the host's current cancellation receipt but does not refund outstanding
work. Confirmed terminal **and** accounting receipts are still required to release reservations.
Cancellation neither kills a process nor proves an external effect has ended.

Execution status, join, and acceptance are distinct. A join is ready only when every seat has an
attempt and every attempt is terminal. `join` additionally requires full accounting and closes
admission. Failed members can join: joining reports collected terminal outcomes, not accepted work.
Acceptance always remains `unassessed`. Counts, majority, topology and model output never satisfy a
Flow gate or derive Surface trust. No group operation advances Flow.

## Required host capabilities

`DelegationGroupHost` has no permissive default implementation. The embedding host owns these
checks and must return bounded, authenticated receipt references for the **exact** request:

- `resolveAuthorizedEnvelope(identity, groupId)`: independently authorized, active, immutable envelope
  and exclusive group allocation. Assignment eligibility or correlation is insufficient.
- `confirmController(request, current)`: current controller fencing, including successor ownership for
  takeover. It is called last, immediately before a new ledger decision, and on exact replay against the current
  projection/fence. Replay authenticates access, not renewed admission. It must perform no invocation.
- `confirmReadiness(request, current, seat)`: current independent admission or Flow-owned claimed
  readiness; includes current cancellation/liveness checks. Group topology cannot supply it.
- `confirmBudgetEnforcement(request, current)`: confirmed ability to bound the proposed external
  attempt, including every underlying Dispatch fallback/retry and token/cost allocation. This checkout
  pins Dispatch 0.3.0 and Relay 0.6.0; this service has not composed their receipts into execution
  authorization or reconciled live usage. This gap is version-scoped. Per Brian's dependency inventory,
  public Dispatch 0.7.1 provides `FileAuthorizationLedger`, `ExecutionAuthorization`, and `worstCaseUsage`
  for durable cross-invocation reservation; Relay 0.7.1 provides `costUsd` and `modelSource` provenance.
  Parent-supplied bounded evidence exercised concurrent plans sharing an authorization/root with one
  allowed attempt: one succeeded, one exceeded budget, and one physical invocation occurred. Reopening
  the ledger and repeating the successful invocation id raised `AuthorizationPersistenceError` in
  recovery with `duplicateInvocationRisk: true`, without a second invocation; configured model
  provenance stayed configured. That fake-runtime probe is not provider billing or native-runtime
  proof. A further parent-supplied 0.7.1 probe found that raw `ModelInvocationResult.usage = {}`
  settles Dispatch's reservation with `totalTokens: 0`; with room for two attempts and sufficient cost
  capacity, the next invocation succeeds despite absent token accounting. Therefore neither a zero
  token receipt nor `reservationState: "settled"` proves actual usage when raw source fields are missing.
  The group must retain unknown usage and require complete actual input/output figures and cost.
  A later adapter can refuse incomplete accounting in `AuthorizationLedger.settle` **before** forwarding
  settlement, persisting the observed result for recovery; typed `AuthorizationPersistenceError`
  prevents automatic reinvocation. The later executor should compose the public Dispatch physical
  reservation with group accounting. Dependency upgrades and consumer qualification belong to the parent continuation.
- `confirmEvidence(request, current)`: current invocation/loss, terminal, actual accounting or
  cancellation evidence, bound to the exact attempt and requested immutable references. A raw provider
  string, unverified receipt, estimated cost, or successful cancellation request is insufficient.

`now()` supplies canonical UTC observation time for envelope activation and current claim expiry.
Missing or unconfirmed required capabilities throw before intent persistence. Host callbacks receive
defensive copies and must not execute work. This source fixture supplies a deterministic test host;
it does not qualify any real host's authorization, runtime fencing, cancellation or provider limits.

## Local durability and limits

The local adapter composes the additive `atomicWriteDurableFile()` and `withSubjectLockAsync` under
`<artifactRoot>/delegation-groups/`. Filenames are full SHA-256 hashes of group ids; the separate
store-wide lock makes envelope ownership and ledger append atomic across cooperative processes.
Each file contains the complete append-only event log in canonical JSON plus a newline. Reads validate every request, receipt shape,
revision, outcome and transition; projections are replayed rather than trusted cached state. Corrupt,
unsupported, foreign-owned, symlinked, multiply linked or non-regular ledger files fail closed.
The new writer flushes the temporary file **before** rename, then flushes the parent directory. A failed
temporary-file flush preserves the previous acknowledged ledger. The shared `atomicWriteFile()` keeps
its existing behavior and defaults. After publication the adapter also flushes the ledger directory,
artifact root and root's parent entry before acknowledgement. Replay does not rewrite ledger bytes.
Every ledger read, including replay and cross-group ownership checks, retries file/directory durability
before yielding state. If that repair fails it throws `durability_unavailable`; visible but unacknowledged
accounting cannot release held amounts through a read. Successful repair may expose the already
published decision, after which exact replay recovers its original result without appending again.

The caller must designate a dedicated artifact root owned by the effective user, with an existing
parent directory. Ownership support is required; unsupported platforms refuse. The adapter checks
actual uid ownership and enforces mode 0700 on that root, its group directory and assignment-lock
container; ledger files and temporary replacements use mode 0600. Existing owned store paths have
permissions repaired only after ownership/type/link checks. Ancestors and peer paths are never chmodded.
Symlink roots/directories and foreign roots refuse before permission changes. POSIX modes are the
local access boundary; hosts must also manage ACLs and the authority to choose that dedicated root.
This is a single-host store,
not hostile-directory race protection, distributed consensus, authenticated receipt verification, or
cross-machine execution fencing. A crash leaving a lock requires explicit operator cleanup after
confirming no live owner, following the existing assignment-lock behavior. No automatic stale takeover
is introduced.

There are at most 4,096 attempts, 16,384 ledger decisions, 16 output references per terminal attempt,
32 MiB serialized ledger data, and 1 GiB referenced-object length per reference. Each reference has
an opaque bounded id, SHA-256 digest, byte length and provenance id; there are no paths, raw prompts,
provider strings, or embedded outputs. Integer amounts are at most 10^12 per allocation/accounting;
aggregate sums stay within JavaScript safe integers. Each decision preserves event and byte capacity for confirmed
terminal/accounting of every outstanding attempt and cancellation request/confirmation. New decisions
that would consume this settlement capacity refuse before append. Archival, compaction and administrative
recovery are unsupported; unresolved allocations remain held. Offline ledger bytes are trusted host storage, not signed authority.

## Focused evidence and next slice

The narrow repository test command after `npm run build` is:

```sh
node --import ./src/cli/unit-test-state.mjs --test src/cli/delegation-group.test.mjs src/cli/delegation-envelope.test.mjs
```

The tests reach public service operations over real temporary persistence/reopen, same-process and
separate-process admission contention, exclusive envelope ownership, conflicting replay, lost commit
acknowledgement, ambiguous invocation, cancellation, missing/overrun accounting, all-terminal join,
strict bounds and host capability refusals. Existing envelope v1 validation/narrowing stays unchanged.
Real Flow 5.2.0 fixtures exercise `startRun`, `claimReadyStep`, `loadRun`,
`projectReadyStepFrontier`, and `validateDurableStepClaim` through group admission. Precise fsync EIO
injection over real temporary paths exercises pre-rename preservation and post-rename unavailable/read
repair. These checks do not simulate power loss or establish hardware/filesystem crash guarantees.
They are source diagnostics, not installed-runtime or live-provider acceptance. Flow 5.2.2 consumer
qualification remains with the parent dependency-upgrade continuation.

The fresh-context continuation should start from #1113, `AGENTS.md`, this guide and the exact handoff
commits. Remaining acceptance includes real three-member installed execution and parent/member tree,
Flow-owned DAG scheduling/join/gates, isolated writer lanes with integration ownership, bounded real
liveness/timeout/takeover and mailbox integration, authenticated host callbacks, exact Dispatch/Relay
receipt reconciliation, and coordination efficacy/cost/wall-time evaluation. None is inferred from
this ledger increment. Keep each next slice independently reviewable and serialize shared exports.

## Dispatch accounting boundary

`dispatchDelegation()` composes the published Dispatch authorization ledger with a host-owned
`retainResult` callback. Every candidate requires worst-case token/cost capacity; the plan requires
an authorization identity, invocation identity, and shared token/cost limits. Dispatch reserves before
physical invocation and refuses an ambiguous replay rather than launching again. The host must
validate the plan against authenticated authority and enforce the claimed runtime bounds.

The wrapper awaits durable retention of each raw result before settlement. Retention failure stops
fallback and leaves the reservation unresolved. Settlement requires provider-reported input tokens,
output tokens and cost; absent values remain unknown. Actual cost replaces Dispatch's estimated cost
at the ledger boundary. An inconsistent reported total is refused. The returned Dispatch receipt still
contains Dispatch's estimates and is not the accounting authority or semantic acceptance evidence.

These calls are not yet composed with group attempts, authority issuance, ancestor reservations,
mailbox admission or effect fencing. Tests use the real temporary FileAuthorizationLedger and a
controlled runtime; they do not establish live provider metering or confinement.
