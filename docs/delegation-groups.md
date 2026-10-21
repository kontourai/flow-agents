# Delegation groups: contract and durable ledger

This source branch implements [#1113](https://github.com/kontourai/flow-agents/issues/1113) in
separate v1 and v2 APIs. V1 retains the original report-only group ledger. V2 adds derived authority,
allocation and invocation accounting, a durable group controller, Flow/advisory execution wrappers,
mailbox admission and bounded context acknowledgement. Flow still owns readiness, dependencies and
gate evaluation.

Local composition tests do not establish production authentication, isolated writer enforcement,
physical budget/cancellation fidelity, installed Station adoption or publication. Those acceptance
obligations remain open. The sections from **V1 identity and authority** through **V1 verification**
describe the compatibility API; later sections describe the additive v2 source APIs and their limits.

## Public entry points

| Subpath | Purpose |
| --- | --- |
| `@kontourai/flow-agents/delegation-group-contract` | Closed schema 1.0 validators, canonical digests, pure transitions and replay projection |
| `@kontourai/flow-agents/delegation-group` | Transactional service and host/store interfaces |
| `@kontourai/flow-agents/delegation-group-local-file` | `createLocalFileDelegationGroupStore(artifactRoot)` |
| `@kontourai/flow-agents/delegation-authority-contract` | Pure v2 root authority, execution grant and budget validators |
| `@kontourai/flow-agents/delegation-envelope-v2` | Pure v2 envelope narrowing, digests and complete ancestry validation |
| `@kontourai/flow-agents/delegation-dispatch` | Guarded Dispatch invocation with durable result retention and reported-usage settlement |
| `@kontourai/flow-agents/delegation-authority-service` | V2 issuance, allocation, invocation holds and reconciliation |
| `@kontourai/flow-agents/delegation-authority-local-file` | Private host-owned authority storage |
| `@kontourai/flow-agents/delegation-execution` | Runtime receipt binding and authority-bound invocation |
| `@kontourai/flow-agents/delegation-flow-execution` | Flow claim/execution composition |
| `@kontourai/flow-agents/delegation-context-sync` | Bounded no-tools acknowledgement and receipt recovery |
| `@kontourai/flow-agents/delegation-group-v2` | Durable v2 group controller and projection |
| `@kontourai/flow-agents/delegation-group-v2-local-file` | Private host-owned group journal |
| `@kontourai/flow-agents/delegation-group-mailbox` | Current group/assignment mailbox admission |

The same APIs are exported at the package root. Package version and publication are separate from
these source exports. Reference identities are opaque; none grants filesystem access.

## V1 identity and authority

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
current revocation, or confine effects. The compatibility group service accepts only v1 membership; the separate v2 controller composes
the v2 authority service and execution wrappers described below. Metadata is not a compatibility bridge.

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

## V1 transaction protocol

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
They are source diagnostics, not installed-runtime or live-provider acceptance. Flow remains pinned
to canonical reducer version 5.2.0; a 5.2.2 trial failed the coordinator identity check and was reverted.

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
at the ledger boundary. An inconsistent reported total is refused. Candidate estimators are removed
from the internal Dispatch plan, so they cannot suppress an otherwise successful result or hide a
reported cost overrun. The wrapper returns its own `outcome` and `reportedCostUsd`, with the unmodified
internal receipt under `dispatchReceipt`. Cost overrun returns `budget-exceeded` without a result.
`reportedCostUsd` sums settled observations only: failed attempts retain unknown usage and held
reservations. Neither this sum nor the diagnostic Dispatch receipt establishes complete accounting
for those failed attempts, physical cost enforcement, or semantic acceptance.

The v2 execution bridge composes these calls with authority invocation holds and the group controller.
Production host effect fencing and metering remain separate requirements. Tests use the real temporary FileAuthorizationLedger and a
controlled runtime; they do not establish live provider metering or confinement.

## Offline mailbox

The `delegation-mailbox` subpath exports the closed message/identity contract; the separate
`delegation-mailbox-local-file` subpath exports `createLocalFileDelegationMailbox()`. Both are also
root exports. Pending outbox records require explicit delivery; reopen does not send. Delivery and
acknowledgement are transport states, not agreement, gate evidence or ownership transfer.

The required host validator authenticates the caller and both participants' exact group, controller,
member and assignment generations, actor identities, liveness and cancellation state on every action.
The offline adapter cannot establish those facts itself. Its journal retains one request/response per
subject and exact participant pair, at most 256 operations, 4096 UTF-8 payload bytes and one hour per
message. Cancellation fences persist. There is no automatic garbage collection or resend.

Owned paths use private modes and reject links/foreign ownership. Missing ancestors are created
privately without changing existing ancestor permissions. Replacement flushes temporary bytes before
rename; successful observations confirm journal and ancestor directory entries. Failed confirmation
returns unavailable until repaired. Filesystem failure injection and descriptor tracing do not prove
power-loss durability, cross-user confinement or live host authentication.

## V2 admission service in progress

The source-only `delegation-authority-service.ts` increment registers a root authority and exact
root/child ancestry under a transactional store. Every issue, derivation, inspection, cancellation and
effect-admission request calls the authenticated host boundary. Replay rechecks current access.
Sibling allocations partition the parent's token, cost, attempt and lifetime-envelope ceilings;
lifetime child counts cannot reset through replay. Derivation also confirms the exact execution grant
and rechecks expiry after asynchronous host admission. Cancellation is irreversible in the ledger.

The local adapter requires an existing private host-owned root and serializes transactions under a
store-wide lock. Root authority and previously registered envelopes are immutable; execution ids
cannot be reused across authorities in that store. Private unaliased files are flushed before use,
replacement data before rename, and directory entries before return. Reopen confirms durability.
The host must provision and durably establish the root path before constructing this adapter.
Same-uid ownership/mode checks do not protect this root from workers with the same filesystem access.

Invocation ids are reserved once and remain bound across reopen. Each invocation consumes its
own envelope's unallocated attempt/token/cost capacity and active capacity along every ancestor.
Unknown usage holds its allocation even after terminal status is confirmed. Only host-confirmed
terminal accounting releases the active slot; actual spend remains charged. Confirmed usage above
its allocation is retained and closes further derivation, invocation admission and effect admission.
Cancellation stops admission without claiming that existing invocations have terminated.

This increment has source package entry points, but is not yet published or a complete enforcement service. It lacks
Dispatch/group reservation composition, executable effect fencing, and production host authentication. `admitEffect` returns a checked observation, not a transferable
capability or permission to bypass a host effect-time check. Real temporary-store tests establish
reopen, allocation refusal, active-slot/unknown-usage holds, overrun retention, access refusal and persisted cancellation; they do not establish crash,
power-loss, hostile-worker or live-provider enforcement.

## Authority-bound execution in progress

The `delegation-execution` source entry point exports an `executeAuthorizedDelegation()` bridge selects the exact registered runtime/model
receipts and checks required capabilities, tool names and native output-token limiting before
reservation. It requires an explicit output limit within the allocation. Public Dispatch validation
runs with an already-aborted signal and no runtime or ledger, so incompatible plans cannot consume
authority capacity. A pre-aborted caller likewise creates no reservation. Content-addressed tuples
produce bounded Dispatch ids without restricting the service's canonical invocation ids.

One call admits one physical attempt. Explicit retries require fresh invocation ids and consume
new authority capacity. Authority reservation precedes Dispatch reservation; a second effect check
precedes the host's launch fence. The host must enforce that fence across launch and authenticate
its runtime receipts; matching reference text and capability declarations alone do not prove this.

Raw results and thrown failures reach separate awaited host retention callbacks before Dispatch
normalizes them. Retention failures and unknown usage keep holds. Successful usage reconciles into
the authority ledger. A per-dimension overrun that Dispatch can settle returns `budget-exceeded`
without a result. Combined-token or cost capacity overruns can instead make Dispatch refuse settlement;
the bridge reconciles retained usage into authority, then preserves the settlement error. If authority
reconciliation also fails, an aggregate error retains both failures and the original Dispatch cause. An abort request or thrown runtime error does not prove
termination or known zero spend. Durable retention, actual confinement, input/cost ceilings and native
cancellation fidelity still require production host evidence. No installed group executor or Station
consumer is established by this controlled-runtime bridge test.

## Flow execution composition in progress

The `delegation-flow-execution` source entry point exports an `orchestrateDelegationFlow()` wrapper binds unique seats to registered envelopes and
exact Flow run/step/definition identities. Flow supplies ready steps and claims; the wrapper awaits
host lifecycle persistence and claim authentication before preparing or invoking a member. Invocation
ids include the exact claim identity, preventing an interrupted claim from silently launching again.
Member outcomes are retained through the host before the callback returns to Flow evaluation.

This is not a second dependency scheduler or acceptance reducer. The host must use Flow's authorized
evidence operations to submit results; a successful model call does not satisfy a gate by itself.
The controlled-runtime fixture uses an optional expectation, so its completed run proves composition
and lifecycle ordering, not a required gate accepting returned artifacts. A denied claim produces no
authority invocation in that fixture. A host must still enforce assignment/source/worktree fences,
actual tool effects, durable outputs and cancellation. The v2 controller composes group records and
the mailbox validator checks group membership; production mailbox authentication and the Station
consumer remain unqualified.

## Context acknowledgement in progress

The `delegation-context-sync` source entry point exports `syncDelegationContext()`, which uses explicit empty tool authority and the `context-sync`
effect. It sends zero tools, bounds text to 64 KiB, and requires the exact response `ACK SYNC <run-id>`
with zero returned tool calls. A SHA-256 binds each retained receipt to the supplied text. A wrong
response permits one retry only after the first response completed and its usage reconciled. Unknown
invocation/retention/accounting failures retain an incomplete receipt and propagate with their cause,
without an automatic retry. Replay of the same invocation identity is refused by durable admission
and does not overwrite an existing receipt. Receipt publication also requires this caller to have
completed durable invocation reservation: a concurrent preflight refusal cannot replace another
caller's acknowledgement. If receipt persistence fails, the returned persistence error carries an
immutable receipt snapshot and a storage-only retry method; recovery never invokes the model.
Editing a returned receipt copy does not change the snapshot used by recovery. Combined execution
and storage failures preserve both diagnostics; falsy abort reasons remain execution failures.

The host retains the receipt and raw responses; callback delivery is not durable-storage proof.
An acknowledgement is transport/protocol evidence, not understanding, tool confinement or a gate.
The Station folded-context UI and production no-tools host remain unconnected. The current controlled
fixture covers one wrong response followed by the exact acknowledgement, not live context recovery.

The authority adapter also reserves 256 journal bytes for each unresolved usage record before
admission. This covers its later canonical three-integer usage record without allowing unrelated
ledger growth to consume settlement space. Boundary injection tests establish refusal before a new
reservation, not a literal near-16-MiB storage or power-loss result.

## V2 durable group controller

The source subpaths `delegation-group-v2` and `delegation-group-v2-local-file` export
`createDelegationGroupControllerV2()` and its local store. The controller provides create/get/list/events,
cancel/run and authenticated terminal reconciliation. It freezes the root authority reference,
controller generation, policy, topology and exact seat envelopes/allocations. Flow definition identity
text retains its public bytes, including semantic-version build metadata.

Operations bind canonical intent, operation identity, expected revision and controller fence.
Reads and replays require current host authorization. Intent and invocation linkage persist before
launch; reopen and replay never dispatch automatically. Independent groups are bounded report-only
advisory execution. Flow groups use the existing claim wrapper and Flow-owned dependencies/evaluation.
Raw dissent and failures remain retained observations; group acceptance remains unassessed.

Cancellation persists closed admission, then cancels authority and requests descendant cancellation.
A crash or lost acknowledgement across these operations leaves cancellation pending. Replaying a
request does not repeat uncertain external effects. Terminal reconciliation requires confirmed
terminal/accounting state and host proof for the exact invocation and descendants. Unadmitted seats
or missing invocation links remain conservatively unproven; no zero-usage inference resolves them.

The local store permanently binds an authority to one group within that store and escrows future
record capacity. Cross-store custody, actual actor/liveness, launch confinement, physical cancellation,
live assignment authorization and missing-output recovery remain host responsibilities. There is no takeover,
route-back seat reexecution, compaction or automatic redispatch in this increment. These source APIs
are not yet a published package or a Station group launch feature.

## Group mailbox admission

The `delegation-group-mailbox` source entry exports `createDelegationGroupMailboxValidator()` for
the offline mailbox's required host seam. It authenticates the caller before group lookup, then holds
a host membership fence while reading current group/authority state and resolving both participants'
live assignments. Exact seat envelope generations/digests, controller binding, and every mailbox
identity field must match. Group cancellation, authority cancellation and proven terminal groups refuse
messages; stale assignment generations cannot deliver or read retained messages.

The host must implement actual caller authentication, current liveness, group generation and the
membership/cancellation fence. A no-op fence or caller-supplied identity resolver does not enforce
those properties. This composition neither grants tool/filesystem access nor turns transport ACKs
into acceptance. The real-store fixture uses controlled host identities, not deployed authentication.
