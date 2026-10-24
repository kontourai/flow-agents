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
| `@kontourai/flow-agents/delegation-flow-runtime` | Host-to-delegation Flow runtime reference compatibility check |
| `@kontourai/flow-agents/delegation-context-sync` | Bounded no-tools acknowledgement and receipt recovery |
| `@kontourai/flow-agents/delegation-group-v2` | Durable v2 group controller and projection |
| `@kontourai/flow-agents/delegation-group-v2-local-file` | Private host-owned group journal |
| `@kontourai/flow-agents/delegation-group-mailbox` | Current group/assignment mailbox admission |

The same APIs are exported at the package root. Package version and publication are separate from
these source exports. Reference identities are opaque; none grants filesystem access.

## Embedding a Flow runtime

A host that also imports `@kontourai/flow` calls the synchronous
`assertDelegationFlowRuntime({ loadRun, withRunMutationLock })` from
`@kontourai/flow-agents/delegation-flow-runtime` before Flow-bound retention,
issuance, claims or continuation effects. Supply the host's actual static public
Flow imports, never request fields or wrappers. Both references must match the
private Flow bindings used by delegation rounds and the multi-cursor scheduler.
A mismatch throws `DelegationAdmissionError` with code
`delegation_flow_runtime_mismatch`; no supplied function is invoked. There is no
fallback, version/path inference, or transferable success token.

Separate module copies can have different process-local lock registries even at
the same version. This check rejects those mismatched references. Normal named
re-exports and deduplicated bundles preserve reference identity; wrappers,
independent chunks, HMR replacements or other realms can conservatively refuse.
The assertion checks this trusted-host composition, not a hostile host or every
possible bundler transformation. It is not universal kernel attestation,
authority, a claim or provider qualification. Existing currency, budget and final
claim fences remain required. An embedding must separately prove the check is
used before effects and exercise its final installed/bundled Flow path.

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

V2 `max_cost_micros` and invocation `costMicros` are integer millionths of USD.
Reservations and known usage round fractional micros upward; the execution bridge uses
`ceil(costUsd * 1_000_000)` for known usage. These values do not perform currency
conversion. A host with another currency or incomplete tariff/usage evidence cannot
settle it as zero USD: retain unknown capacity until authoritative reconciliation.

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
  attempt, including every underlying Dispatch fallback/retry and token/cost allocation. This v1
  host callback does not itself compose physical execution or reconcile usage. The current checkout
  pins Dispatch and Relay 0.7.1; the v2 execution bridge described below composes Dispatch reservation
  with authority accounting and retains unknown usage conservatively.

  Historical controlled-runtime probes of 0.7.1 established shared-authorization contention and
  duplicate-invocation refusal after reopen. They also found that raw usage `{}` could settle a
  Dispatch reservation as zero tokens. Those probes establish neither provider billing nor native
  enforcement. A settled receipt alone therefore cannot establish complete actual usage; the current
  bridge requires observed input/output figures and cost before reconciling known accounting.
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
The initial Flow 5.2.0 fixtures exercise `startRun`, `claimReadyStep`, `loadRun`,
`projectReadyStepFrontier`, and `validateDurableStepClaim` through group admission. Precise fsync EIO
injection over real temporary paths exercises pre-rename preservation and post-rename unavailable/read
repair. These checks do not simulate power loss or establish hardware/filesystem crash guarantees.
They are source diagnostics, not installed-runtime or live-provider acceptance. The package now pins
Flow 5.2.2 alongside the privileged coordinator and its independently locked staged closure. A
previous dependency-only trial failed the coordinator's 5.2.0 identity check; the migration updates
the package/release pin and closure digest together while preserving the reducer's 1.3.8 identity.
The installed lifecycle harness retains exact 5.2.2 admission and FIFO interoperability checks.
This alignment does not establish a consuming host's shared-module composition or live execution.

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

The underlying source entry points are exported in installed 9.3; that alone does not approve a provider. The execution bridge and v2 group
controller compose authority reservations, Dispatch and group records as described below.
Production host authentication and executable effect fencing remain host responsibilities.
`admitEffect` returns a checked observation, not a transferable capability or permission to bypass
a host effect-time check. Real temporary-store tests establish
reopen, allocation refusal, active-slot/unknown-usage holds, overrun retention, access refusal and persisted cancellation; they do not establish crash,
power-loss, hostile-worker or live-provider enforcement.

## Authority-bound execution in progress

The `delegation-execution` source entry point exports `executeAuthorizedDelegation()`, which selects the exact registered runtime/model
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
the authority ledger. Published 9.3 `DelegationDispatchOutcome`, `DelegationExecutionHost`,
`dispatchDelegation()` and `executeAuthorizedDelegation()` retain their original contracts and
Relay dollar bridge. Existing group, Flow and context-sync entrypoints keep that default.

The additive source API is `dispatchDelegationAccountingV1()` and
`executeAuthorizedDelegationAccountingV1()`. Its execution host explicitly declares
`accountingProtocol: "retained-tariff-v1"`; `retainResult` returns
`DelegationRetainedAccountingV1` (`inputTokens`, `outputTokens`, `costMicros`,
`costBasis: "tariff-upper-bound"`), `null` for an unknown hold, or `undefined` to
select the legacy Relay-USD bridge. It must durably retain raw evidence, tariff
identity and cost basis before returning. This callback neither issues authority nor verifies billing.

Dispatch's dollar ledger receives `delegationAccountingDollarsV1(micros)`, a
conservative upward-rounded view. The authority ledger retains the original integer;
there is no USD reverse conversion on this path. Reservation and settlement use the
same helper. Direct dispatch callers must reserve sufficient headroom with it. Its
domain is nonnegative safe integers through 10^12 micros. This per-amount guarantee
does not prove exact conservative accumulation of arbitrary floating-point sums.

`DelegationDispatchAccountingOutcomeV1` separates `accountedCostUsd` from optional
`reportedCostUsd`. Exact tariffs leave reported dollars absent, with
`costBasis: "tariff-upper-bound"`. Raw Relay results are preserved: an existing
`usage.costUsd` remains raw provider evidence, but this accounting path neither
fabricates it from the tariff nor uses it as the tariff's reported dollar cost. An unsettled attempt makes the outcome
basis `"unknown"`; the accounted tally contains only settled amounts. It is not zero
spend for held attempts. `null`, invalid measurements, failed retention or settlement
preserve the appropriate holds. `undefined` keeps legacy measurement behavior.

`createDelegationGroupControllerAccountingV1()` carries this protocol through its
guarded execution host and both group and Flow outcome retention callbacks.
`orchestrateDelegationFlowAccountingV1()` uses the existing Flow scheduler and durable
claims; `syncDelegationContextAccountingV1()` keeps the existing bounded acknowledgement
and receipt protocol. Their new host types accept the truthful accounting outcome.
Admission, group journals and Flow readiness are shared with the default path, not reimplemented.
These additive APIs are an unpublished candidate. The underlying 9.3 source exports
and public pricing do not establish actual provider approval or Station adoption.

A per-dimension overrun that Dispatch can settle returns `budget-exceeded`
without a result. Combined-token or cost capacity overruns can instead make Dispatch refuse settlement;
the bridge reconciles retained usage into authority, then preserves the settlement error. If authority
reconciliation also fails, an aggregate error retains both failures and the original Dispatch cause. An abort request or thrown runtime error does not prove
termination or known zero spend. Durable retention, actual confinement, input/cost ceilings and native
cancellation fidelity still require production host evidence. No installed group executor or Station
consumer is established by this controlled-runtime bridge test.

## Flow execution composition in progress

The `delegation-flow-execution` source entry point exports `orchestrateDelegationFlow()`, which binds unique seats to registered envelopes and
exact Flow run/step/definition identities. Flow supplies ready steps and claims; the wrapper awaits
host lifecycle persistence and claim authentication before preparing or invoking a member. Invocation
ids include the exact claim identity, preventing duplicate reservation of that invocation identity.
Recovery of an expired claim can produce a fresh claim id and therefore a different invocation id.
The host must authenticate the current gate attempt and authorize recovery after an ambiguous
launch; this standalone wrapper does not independently prevent another launch under a fresh claim.
The v2 controller separately refuses repeated group runs. Member outcomes are retained through the host before the callback returns to Flow evaluation.

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
request does not repeat uncertain external effects. `reconcileCancellation()` requires the exact
original request and a current host confirmation before recording that the request was observed;
concurrent confirmations return the same requested projection without another send. Terminal reconciliation requires confirmed
terminal/accounting state and host proof for the exact invocation and descendants. Missing invocation links with retained authority holds remain conservatively unproven. For a
cancelled seat with no invocation link or authority invocation, `recordNotLaunched()` requires
revoked authority and an independent host non-launch proof. It records terminal closure without
inventing usage or acceptance. The journal reserves capacity for those proofs.

The local store permanently binds an authority to one group within that store and escrows future
record capacity. Cross-store custody, actual actor/liveness, launch confinement, physical cancellation,
live assignment authorization and missing-output recovery remain host responsibilities. There is no takeover,
route-back seat reexecution, compaction or automatic redispatch in this increment. These source APIs
are source APIs in installed 9.3, not evidence of an approved Station group launch feature.

## Group mailbox admission

The `delegation-group-mailbox` source entry exports `createDelegationGroupMailboxValidator()` for
the offline mailbox's required host seam. It authenticates the caller before group lookup, then holds
a host membership fence while reading current group/authority state and resolving both participants'
live assignments. Exact seat envelope generations/digests, controller binding, and every mailbox
identity field must match. Group cancellation, authority cancellation and proven terminal groups refuse
worker messages; stale assignment generations cannot deliver or read retained messages. Trusted host
time is sampled after live resolution and validates each participant's complete registered ancestry,
including root/envelope expiry and exact grant bindings.

Mailbox cancellation resolves the authenticated controller's own live identity independently of
worker seats. This cleanup path can fence an offline journal after group/authority cancellation or
expiry; it grants no execution authority. Workers cannot borrow a controller identity, and proven
terminal groups still refuse cleanup.

The host must implement actual caller authentication, current liveness, group generation and the
membership/cancellation fence through the subsequent mailbox read/commit. The validator callback
ends before the mailbox store uses its decision; the callback alone is not atomic transport fencing.
A no-op fence or caller-supplied identity resolver does not enforce
those properties. This composition neither grants tool/filesystem access nor turns transport ACKs
into acceptance. The real-store fixture uses controlled host identities, not deployed authentication.

## Draft candidate: checkpoint-authorized group rounds

**Unpublished source candidate for Station #91 / #432 and Flow Agents #1113.**
The initial independent-rounds artifact remains frozen for review. This increment
adds Flow continuation to the same finite controller, immutable root and roster.
Original group-v1/v2 behavior and `orchestrateDelegationFlow` remain unchanged.
Adoption requires upstream review and a new registry artifact before Station
consumes the public subpaths. Station must not import candidate source/build paths.

`@kontourai/flow-agents/delegation-group-rounds` exports
`createDelegationRoundsController`, `validateDelegationRoundsSpec`,
`projectDelegationRounds`, `delegationRoundsCapacity`, their types and bounds.
`@kontourai/flow-agents/delegation-group-rounds-local-file` exports
`createLocalFileDelegationRoundsStore`. Controller methods include `create`, `get`,
`events`, `release`, `recordTerminal`, `cancel`, and the checked continuation
methods `reappraise`, `authorizeRetry`, and `sync` described below.

The spec permanently fixes the group/root/controller, preauthorized seat and
envelope roster, allocation, policy, maximum concurrency, rounds and attempts.
Independent advisory releases retain their initial command shape. Flow topology
adds an exact run/definition/actor and a step ID per seat. Flow policy additionally
fixes `maxEvaluations`, independent of paid attempt capacity. A Flow release binds
a current `flowHead`, checkpoint reference and explicit seat subset. The host
must authenticate the actual caller and authorize that exact subset and action;
a checkpoint reference or transition hash never authorizes itself.

Each Flow selection explicitly chooses one of:

- `{ seatId, mode: "invoke", previousInvocationId, retryRef }`: a new physical
  invocation. The initial attempt has null predecessor/retry reference. A repeated
  seat needs its exact latest invocation, known usage in the existing authority
  service, host proof of physical termination of that invocation and descendants,
  and the hash of the latest relevant Flow route-back or `retry_authorized`
  transition after the original claim. Flow must currently allow the step to be
  claimed. An exhausted route, fabricated reference or stale route cannot admit
  paid work. Every paid attempt has a new claim and invocation ID and consumes
  the same authority/envelope ancestry and lifetime budgets.
- `{ seatId, mode: "evaluate", invocationId }`: no model invocation. This requires
  the latest retained result and physical-terminal proof, known accounting, current
  host confirmation of the retained result, and no intervening Flow invalidation
  of that result's step. After real evidence is attached through Flow, the
  controller uses public `reopenMultiCursorStep` if necessary, then obtains a new
  evaluation claim. The scheduler invokes public `evaluateClaimedStep` directly.
  It neither replays the member invocation nor synthesizes gate evidence. The
  receipt explicitly labels `evaluation-only` and references the retained result,
  source invocation, current claim, real outcomes and exact Flow run head.

Release intent and selected actions persist before claims/effects. Paid attempt
history stores all correlated claim IDs; Flow actions retain full claim snapshots,
transition-count custody, and separate evaluation receipts. Evaluation-only work
adds no invocation or token/cost reservation and uses its declared evaluation
capacity. Raw output, dissent, errors and evidence remain retained observations;
acceptance remains `unassessed`. There is no majority/trust reducer.

The existing public `orchestrateFlowMultiCursor` gains optional `selectReadySteps`,
`beforeClaim`, `withClaimAdmission`, and `onEvaluation` callbacks. Omitted options
preserve its existing behavior. Selection is checked as a unique subset of Flow's
ready frontier before claims. Each released step is consumed at most once per
checkpoint, including after route-back; newly ready or unassigned steps wait for
another explicit checkpoint. A group-store admission fence spans the actual
public claim mutation and any explicit reopen, serialized with group cancellation.
Flow continues to own readiness, resource claims, liveness/renewal, joins,
evaluation, invalidation and retry limits. The new `delegation-rounds-flow.ts`
coordinator composes those operations; it contains no DAG or gate reducer.

`executeAuthorizedDelegation`, Dispatch and the existing authority service still
reserve/reconcile every paid attempt. No group/root/envelope is minted to retry;
no budget or unknown reservation is reset. Known usage releases only unused
reserved tokens/cost. Unknown usage keeps ancestor holds and forbids retry of
that exact invocation. The controlled fixture also carries an older physical
invocation with unknown accounting on the same root through a later authorized
route-back retry of a different, known-terminal seat.

Reads, reconnect and exact replay require current authorization and have no
invocation, claim, reopen, evaluation or cancellation effects. Changed intent
under a key, reused checkpoints and stale controller/revision fail closed.
Interrupted rounds, lost result/evaluation retention, or lost cancellation
acknowledgements remain held. A real Flow evaluation may commit before its
receipt retention fails; replay does not re-evaluate it or resume later work.
There is no ambiguous-round repair, takeover or automatic resend API.

Cancellation first commits closed admission across all rounds, then revokes the
root and requests descendant cancellation. It does not prove physical termination
or release unknown budget.

A fresh `finalizeCancel({ kind: "finalizeCancel", groupId, operationKey,
expectedRevision, controller, cancelOperationKey })` can close a pending
cancellation after an interrupted effect window. It names the original cancel
command, requires the current controller/revision and host authorization, and
idempotently revokes root authority before calling the optional
`host.confirmCancellation(spec, originalCancelCommand)` observation seam. That
seam must read an independently retained request receipt for this exact original
operation; it must not resend interrupts. A missing observation keeps the group
pending and its invocations/unknown usage unchanged. An authorized host must
separately make and durably retain any missing exact descendant cancellation
requests before finalization can acknowledge them. Acknowledgement means
requested, never physically terminated. Finalization and its receipt append are
serialized by the group store; exact replay only reads the committed result.
There is no automatic retry, provider invocation, budget refund or new root.
The existing two cancellation-record allowance covers the original command and
either its direct request receipt or this finalization event.

Host responsibilities remain current caller/custody,
cross-store root exclusivity, atomic physical launch fencing, descendant
termination, and currentness when final results are fetched. The controlled
nonbillable fixtures do not qualify a deployed host or real provider lifecycle.

The filesystem store requires a preexisting private artifact root (0700), private
files (0600), serialized append-only updates, fsync before rename and durability
repair before returning visible state. It binds each root to one group within
that store; cooperative same-host custody excludes hostile same-uid writers.
Bounds are 64 seats, 16 rounds, 128 paid attempts, 128 evaluation-only actions,
64 concurrent actions, 1024 events, 32 KiB per noncreation event and 32 MiB per
journal. Creation escrows two records per declared round, four per possible paid
Flow attempt, two per evaluation-only action and two cancellation records, plus
creation. Independent groups retain two records per attempt. There is no compaction.

### Executed Flow 5.2.0 exhaustion edge

`evaluateClaimedStep(runId, { claim_id, liveness_id, actor, cwd })` returns
`{ settled, outcomes, ...run }`. On the exercised second missing-evidence route
with `route_back_policy.max_attempts: 1`, it records a generic blocked transition
without `type: "route_back"`. A direct public `authorizeRetry` request naming that
transition fails as `flow.retry_authorization.block.invalid`.

Public `evaluateRun(runId, { cwd, gate: "second" })` reappraises that gate and
records the canonical exhausted route-back transition. A fresh authenticated
operator `authorizeRetry` request using its `blocked_transition_ref`, current
`expected_run_head`, target and authority succeeds. A subsequent checkpoint may
then name the returned `retry_authorized` transition for a new paid attempt.
The controller never invents this proof or automatically requests another retry
epoch. The checked controller workflow below authenticates explicit host-driven
reappraisal/authorization and is required for consuming `retry_authorized`. The focused test probes
both the direct refusal and the successful public reappraisal/authorization path.

The continuation sync profile described below integrates the public
`syncDelegationContext` exchange into group history. Post-merge authority/source
renewal, deployed host enforcement, Station UI/runtime adoption and publication
remain open.
Station #91 / #432 and Flow Agents #1113 remain required for that full goal.


### Independent-review repair: definite nonadmission

This increment preserves the frozen initial and Flow-continuation artifacts.
A normally returned scheduler's explicit resource-conflict deferral now produces
`flow_not_admitted`, recording the exact seat, checkpoint, final Flow head and
`resource_conflict` reason. The action has no claim; its planned attempt has
`admission: "not_admitted"`, no claim references, no physical-terminal proof and
no authority invocation. A nonadmission marker is never inferred from an empty
ledger, a failed scheduler, interrupted persistence or an unacknowledged launch.

After the resource is free, a new authenticated checkpoint can select
`{ seatId, mode: "invoke", previousInvocationId: null, retryRef: null,
nonadmissionOf: <exact latest planned ID> }`. It must name the latest durable
nonadmission for that seat. The ledger must still contain no invocation with that
planned ID. The controller issues a new planned ID and lets public Flow claim
current readiness. Both entries stay in history. This is renewed admission after
deferral, not physical retry; no terminal/accounting receipt is fabricated.
Planned entries still consume the immutable group attempt ceiling; the actual
service charges only real reservations. Group/root/budgets and unrelated unknown
holds are unchanged. Exact replay launches nothing. Old journals that lack a
positive deferral record are not automatically repaired from absence.

### Checked exhaustion recovery

Flow 5.2.0's claimed exhaustion compatibility step is now an actual controller
workflow, not an assumed caller sequence. At creation declare finite
`policy.maxRecoveries` (0 by default, at most 16). Both operations below require
fresh checkpoints and current host authorization, immutable definition binding,
current Flow head and live existing envelope authority:

1. `reappraise` names the current generic blocked transition, exact gate and head.
   The controller calls public `evaluateRun`, requires a real canonical exhausted
   `route_back` result and durably retains that result and head.
2. `authorizeRetry` names that completed reappraisal operation and submits a fresh
   public `FlowRetryAuthorizationRequest`. Its blocked reference and expected run
   head must match the durable reappraisal. The controller calls public
   `authorizeRetry` and retains the resulting `retry_authorized` transition.

A later paid release can use a `retry_authorized` reference only if this checked
workflow recorded it. A direct or caller-assumed authorization cannot substitute
for the reappraisal receipt. The host must independently authenticate the actual
external operator request in `request.authority`; these fields do not authorize
themselves. Unknown/pending recovery blocks new releases. Replay does no Flow
mutation. Recovery does not reset limits, replace source grants or mint budgets.

`host.flow.withContinuationMutation` is required for recovery. It must actually
exclude other Flow writers across the expected-head check and public mutation;
`evaluateRun` has no expected-head parameter. The group store concurrently fences
cancellation. A no-op host fence is not production qualification. The fixtures
own unique runs and serialize their explicit recovery calls; no deployed custody
claim is made.

### Accounted continuation context profile

At creation declare `policy.maxSyncs` (0/default leaves the earlier compatibility
profile; positive values up to 32 enable required synchronization). In the sync
profile, every released seat, including the first release, needs a current
acknowledged per-seat sync key. This remains the default (`syncAdmission:
"every-release"`, or omission). Existing groups without positive sync capacity
do not meet the full continuation-sync goal.

A host whose authenticated initial request already supplies source and
instructions can explicitly create the immutable `syncAdmission:
"initial-request"` policy. It permits an initial invoke selection for a seat with
no previous admitted attempt and no sync exchange. Definite resource
nonadmission does not create a physical recipient and retains that initial
eligibility. Once a seat has an admitted attempt or any sync exchange, every
release still requires its exact current acknowledged sync. Evaluation is never
an initial invoke. Failed or unknown sync cannot fall back to the initial path.
The option requires Flow topology and positive `maxSyncs`, changes no budgets,
and cannot be added or changed on replay.

`delegationRoundsSyncIdentity({command, authorityId, envelopeId})` names the
operation-specific ACK token and the two bounded invocation IDs. The controller
uses this same public derivation. Hosts may use it to join a durable pending
command to a final physical reservation; names alone grant no execution, source,
recipient, budget or Flow authority.

`sync({ ..., checkpoint, flowHead, seatId, contextRef })` persists pending intent
before invoking the existing public `syncDelegationContext`. The authenticated
host resolves context bytes; their SHA-256 must match the authorized content
reference. The selected registered envelope must explicitly permit
`context-sync` and have no tool authority. Requests contain no tools and demand
exact `ACK SYNC <operation-specific token>`. Public sync may make at most two
accounted attempts after a completed, known-usage wrong ACK; the host must confirm
physical termination before another same-seat launch. All result/failure and ACK
receipts are retained. Acknowledged completion additionally requires known usage
and independent host proof that the final invocation and descendants terminated.
ACK alone is not termination or semantic understanding.

The receipt retains seat/envelope/content identity, token, attempt count, exact
ACK reason and terminal proofs. Each sync reserves two slots conservatively in
the group's existing attempt ceiling; actual service/Dispatch invocations consume
the same root/envelope budget. No separate sync budget or new group/root is issued.
Wrong ACK, unknown usage or missing terminal proof cannot qualify a release.
Unknown usage holds its reservation; no new sync on that envelope is admitted
until explicitly reconciled through the existing authenticated service.

Release selections provide `syncKey`. It must belong to the same seat and current
completed-round boundary, acknowledge the current Flow head and have a retained
exact ACK. A paid continuation re-loads the authenticated context bytes and places
them in the actual invocation request, avoiding any assumption that a separate
ACK invocation changed model memory. Evaluation-only continuation is also gated
by its seat ACK and remains nonbillable itself; the separate sync exchange is
accounted. Read/replay never resends sync. Lost receipt retention leaves pending
intent, even when actual usage was already reconciled.

Capacity escrow includes two records per declared recovery command and three
per sync command after R3.
The R2 combined declared profile reserved 899 events including creation; R3
headroom below includes prepared sync and grant-adoption events,
within 1024 events and 32 MiB; noncreation records stay bounded at 32 KiB.
Round, attempt and evaluation ceilings remain unchanged. No compaction, takeover,
automatic metadata repair, refund of planned slots or automatic resend is added.

### R3: storage-only finalization and session custody

An exact sync result now creates a durable `sync_prepared` record before the
external receipt sink is called. The versioned snapshot binds the original
command, exact public sync receipt, per-invocation accounting, physical terminal
proofs, context identity, Flow head and authenticated recipient identity. It
reserves a third sync event at creation. A transient receipt-sink failure leaves
that snapshot available to a fresh process through authenticated reads.

`finalizeSync({ ..., syncOperationKey, preparedDigest })` is an explicit storage-only
controller operation. `preparedRoundsSyncDigest` is exported from the public
rounds subpath. Finalization authenticates the current caller and exact command,
compares the snapshot digest and accounting against the authority ledger, retries
only receipt storage, and transactionally appends completion once. It does not
resolve a runtime, generate usage, reserve capacity, send an ACK request or
reevaluate Flow. Failure is retryable with the same identity. Exact replay is
currently authorized and has no external effects. Prior b2dd journals lacking a
prepared record cannot be reconstructed from the generic in-memory Error alone.
A crash before that durable record remains an explicit hold.

The required `host.recipient.resolve` boundary returns a concrete
`DelegationRecipientIdentity` and its physically bound runtime/fence. Identity
includes host ID, recipient/session ID, generation, execution ID, exact current
root/envelope references, runtime/model receipts and an authenticated host session
receipt. The controller verifies grant/host binding and captures it with the ACK.
It compares the same identity before claim admission, at paid runtime resolution,
and across the actual launch fence. A different recipient or generation requires
a new accounted ACK. Paid request byte reinjection remains, but is not used as a
substitute for session identity. The resolver must read the actual trusted session
registry and its returned fence must enforce that identity through launch; an
asserted ID or a no-op callback is not production enforcement.

Paid attempts retain their recipient identity with claim history. Terminal-proof
callbacks receive the prior recipient when known, so replacing a session cannot
silently reassign old physical proof to its successor. Prepared terminal receipts
retain the identities they describe. Controlled tests use distinct ACK-A and
paid-B runtime objects and observe their request bodies; real provider/session
qualification remains separate.

### R3: versioned public grant renewal

The original v2 authority service/store remain unchanged and still refuse changed
root/grant bytes. The additive public subpaths
`@kontourai/flow-agents/delegation-authority-service-v3` and
`@kontourai/flow-agents/delegation-authority-local-file-v3` export
`createDelegationAuthorityServiceV3` and
`createLocalFileDelegationAuthorityStoreV3`. This is a versioned service contract,
not mutation of v2 records. The v3 service exposes the existing issue/derive/
inspect/reserve/reconcile/effect/cancel API, plus `renew` and explicit `importV2`.

A v3 ledger holds immutable authority/grant epochs, one cumulative invocation
ledger, an immutable epoch origin per invocation and monotonic revision. The
current effective epoch is materialized into the actual existing v2 service for
budget, ancestry, reserve, settlement and effect checks. All historical paid
attempts and null-usage holds are included. No budget/retry/DAG reducer is copied.
Old epoch roots, envelopes, source/runtime receipts and authenticated renewal
proofs stay byte-identical; a separate successor epoch carries new versions.

`renew({ schemaVersion: "3.0", authorityId, operationKey, expectedRevision,
previousAuthority, root, envelopes, hostReceipt })` requires:

- Actual current host authentication of the external successor-grant receipt over
  these exact proposed bytes and current source/runtime/principal. A prepared hash
  or a permissive callback is not authority; the service generates no source proof.
- The same root ID, issuer/principal/subject, cancellation lineage, trace, policy,
  authority ceilings, budget/expiry, grant IDs, Flow binding and roster. Epoch
  increases by exactly one. Existing execution/envelope IDs, parent IDs and
  allocation ceilings remain fixed; parent/root content references must validate
  against the successor epoch's actual ancestry.
- Current expected ledger revision, unrevoked authority, bounded renewal capacity,
  current host execution checks for every successor envelope and final receipt/
  expiry rechecks before commit.

The service transaction appends the epoch and keeps every invocation, allocation,
known cumulative usage, unknown hold and terminal state unchanged. New usage is
charged against that cumulative state under the same immutable ceilings. Old
unknown reconciliation uses its original epoch's envelope/root and the required
historical host proof callback, never the successor source by inference. Missing
historical proof refuses reconciliation. Cancellation cannot be reversed. Renewal
replay reauthenticates exact canonical intent and performs no renewal/effects.

The group must then explicitly call
`adoptRenewal({ ..., renewalOperationKey, authority })`. It authenticates the
caller, obtains the exact current service-held renewal and host receipt, and
appends effective grant references only. The original spec, root anchor, roster,
prior claims/ACKs and all spend remain unchanged. Effects refuse between service
renewal and group adoption. `effectiveRoundsSpec` exports the operational host
view while `projection.spec` remains the immutable audit contract. An old ACK's
root/envelope/session identity does not survive renewal: a sync-enabled seat
requires a fresh current ACK.

To prevent implicit reissue, the v3 store refuses a fresh issue when a v2 ledger
for that root exists in the artifact home. `importV2` requires
`host.withV2Transfer`: the host must revoke old-writer custody, hold exclusive
transfer authority and supply the actual current v2 snapshot. The candidate does
not accept caller-prepared ledger bytes as evidence. It preserves the full root,
envelopes, cancellation and invocation snapshot, including unknowns, and leaves
the old file untouched for audit. The old host must deny subsequent writes;
a process/host crash leaves a safe transfer hold rather than restarting v2 with
a fresh budget. Cross-home custody remains the trusted host's responsibility.

Bounds: at most eight renewals (nine epochs), 1 MiB per complete epoch including
its receipt header, 4096 invocations, and 32 MiB authority storage. At creation the
store escrows the remaining declared epochs, invocation/origin headroom and
unknown settlement headroom. Group policy independently declares `maxRenewals`
(up to eight), with one adoption event escrowed per renewal and a record-size
check for the entire effective roster. The maximum combined group profile now
escrows 939 events including creation, within its 1024-event/32-MiB bounds.
No compaction, budget refund, new root, old-grant edit or spec rewrite is added.

The owner fixtures use an independently issued host registry file containing the
actual controlled source state, runtime/principal bindings and explicit external
operator request, rather than treating a caller-created content hash as proof.
They establish bounded public API behavior, not deployed signing/security policy.

This candidate and its public exports are unpublished. Independent R3 review,
root tariff/outcome-version composition, actual host/session/source enforcement,
upstream release and Station runtime qualification remain required. The separate
root tariff and SDK candidates are neither imported nor modified. Retain-result
wrappers return underlying host promises directly and perform no micros/dollars
round trip. The claimed-exhaustion compatibility evidence is explicitly Flow
5.2.0-bound; nothing here establishes behavior of root Flow 5.2.1.

### Exact accounting in bounded rounds

The unpublished rounds controller accepts the explicit host option
`accountingProtocol: "retained-tariff-v1"`. Its independent attempts, paid Flow
rounds and recipient-bound context ACKs all use the AccountingV1 execution
path. `retainResult` must first retain its evidence, then return exact integer
token/micro amounts with `costBasis: "tariff-upper-bound"`, or `null` for unknown
usage. An undefined return retains legacy provider-reported dollar semantics.
Returning tagged accounting without opting in refuses settlement and retains
the allocation; it cannot silently disappear through a void callback.

Round observation and Flow member callbacks receive either the legacy outcome
or the tagged AccountingV1 outcome. Tariff results leave `reportedCostUsd`
undefined and preserve any existing raw Relay cost field without inventing one.
Storage-only sync finalization compares the retained integer accounting; it does
not dispatch again or change its cost basis. These source contracts do not
establish publication, Station adoption or actual provider billing.

### Durable-step binding and legacy gate metadata

For multi-cursor rounds, issue a bound v2 execution grant with `status: "bound"`,
`flow_run_id`, the published `definition` identity, and `flow_step_id`. Omit
`gate_attempt`: Flow has no per-seat gate-attempt value for this pre-claim grant.
A gate route-back attempt describes a particular failed gate decision; it is not
a durable-step claim identity or a general invocation counter.

The optional `gate_attempt` field preserves existing host metadata. When present
it must remain a non-negative safe integer within the contract bound, is hashed
and matched exactly with the selected grant, and cannot change through renewal.
It does not establish readiness, gate acceptance, or current execution authority.
Existing serialized grants and their digests are unchanged. Consumers predating
this optional-field contract reject omission; upgrade the published consumer
before emitting grants without the field. The v1 envelope contract is unchanged.

Rounds creation checks run, definition and step membership before any claim.
Release uses Flow's current frontier and public durable claim admission. Each
execution and final invocation fence validates the actual current claim, while
continuations retain claim identities and require Flow-owned invalidation/retry
transitions. Retry and evaluation-only releases acquire fresh claims without
rewriting the immutable grant. Hosts must still authenticate claims at their
actual effect boundary; this optional metadata supplies no replacement authority.
