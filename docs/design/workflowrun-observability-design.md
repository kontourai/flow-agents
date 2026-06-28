# ADR draft + Migration Plan: `WorkflowRun` — Event-Sourced Workflow State for Replay / Trace / Observability

**Status:** DRAFT for owner review (not yet an accepted ADR). Design doc only — no code.
**Date:** 2026-06-27
**Author:** design exploration (read-only)
**Relates to:** ADR 0001 (consume Flow), ADR 0010 (trust bundle), ADR 0012 (liveness), ADR 0013 (context lifecycle), ADR 0016 (three-hard-boundary), ADR 0017 (anti-gaming security model)

---

## 0. TL;DR

Flow Agents already has **four** append-ish event streams and **one mutable control record**, but no single
event log that can *replay a whole session*. This doc proposes modeling a workflow run as an **append-only event
log** with the current sidecars (`state.json`, `acceptance.json`, `evidence.json`/`trust.bundle`, `handoff.json`)
re-derived as **projections (folds)** over that log.

**The most important finding up front (reuse-vs-build, §8):** `@kontourai/flow` **already ships a `FlowRun`
primitive** (`startRun`, `loadRun`, `saveRun`, `evaluateRun`, `projectFlowRun`, `validateRunTransition`,
`createRunWatcher`, a frozen run layout, an evidence manifest). Per ADR 0001 "Flow Agents consumes Flow" this is
where a `WorkflowRun` domain *should* live — **not** as a new bespoke Flow Agents log. But note: Flow's
`FlowRunState` is a **mutable record** (`extends MutableRecord`) with an in-place `transitions[]` array
(`node_modules/@kontourai/flow/dist/contracts/flow-types.d.ts`, `FlowRunState`), **not** a pure event-sourced
fold. So the real decision is **where event-sourcing lives**, not whether to build a parallel log. The honest
recommendation (§9) is: **do the thinnest read-only slice in Flow Agents first** (a hash-chained event log that
*unifies the streams we already write*, plus a `replay`/`trace` command), prove the projection reproduces
today's sidecars byte-for-byte, and only then negotiate with Flow about pushing event-sourcing upstream.

---

## 1. Context — what exists today (grounded)

### 1.1 The mutable control record: `state.json`

`state.json` is written by `initSidecars` (`src/cli/workflow-sidecar.ts:858–873`) and mutated in place by
`writeState` (`src/cli/workflow-sidecar.ts:1109–1110`): every `advance-state` does a read-modify-write
(`{ ...loadJson(state.json), ...status, phase, updated_at, next_action }`). It carries:

- `status` ∈ the 13-value set at `workflow-sidecar.ts:13` (`new`…`accepted`/`archived`)
- `phase` ∈ the 11-value ordered list at `workflow-sidecar.ts:14` (`idea`→`done`)
- `next_action`, `artifact_paths`, `created_at`/`updated_at`

**It is destructive.** Each advance overwrites the prior status/phase; there is no record of *how* the run got
to its current state beyond `updated_at`. ADR 0010 deliberately keeps `state.json` as **lifecycle/control state**
(the "WHAT-step", owned by Flow per ADR 0007) and explicitly *out* of the trust bundle
(`docs/adr/0010-...md:42–46`), and ADR 0010 Phase 4 keeps `state.json` even after the bespoke sidecars are
retired (`docs/adr/0010-...md:113`).

### 1.2 The trust state: `trust.bundle` (derived, already a fold over evidence + events)

`buildTrustBundle` (`workflow-sidecar.ts:260`) and `writeTrustBundle` (`workflow-sidecar.ts:523–563`) turn
checks/criteria/critiques **plus the command-log** into a Hachure `trust.bundle` of **claims + evidence +
events + policies**. This is *already* a projection: claim status is **recomputed from evidence**, not stored —
the Surface module's `deriveClaimStatus({ claim, evidence, events, policies })` is the fold
(`SurfaceModule` interface, `workflow-sidecar.ts` ~155–165). ADR 0010 maps:
`evidence.json`→claims+evidence, `acceptance.json`→claims, `command-log.jsonl`→"evidence/traces the claims
recompute *from* — the event stream behind the bundle", `critique.json`→claims/findings
(`docs/adr/0010-...md:36–40`). As of ADR 0010 Phase 4, `evidence.json`/`critique.json` are retired and the
**`trust.bundle` is the sole verification artifact** (`docs/adr/0010-...md:8`).

**So the trust *sub-domain* is already event-sourced-ish.** What is missing is the same discipline for the
*lifecycle* (`state.json`) and a *single unified* log that ties trust events, lifecycle events, and agent
activity into one replayable timeline.

### 1.3 The append logs that already exist (this is the crux — do NOT add a 5th)

| Stream | File | Writer | Hash-chained? | Scope |
|---|---|---|---|---|
| **Command capture** | `.flow-agents/<slug>/command-log.jsonl` | `evidence-capture.js` (PostToolUse hook) | **YES** — `_chain:{seq,prevHash,hash}` | per-task |
| **Agent events** | `.flow-agents/<slug>/agents/<agent>/events.jsonl` | `recordAgentEvent` (`workflow-sidecar.ts:917–931`) | no | per-agent |
| **Liveness** | `.flow-agents/liveness/events.jsonl` | `appendLivenessEvent` / `livenessLifecycle` (`workflow-sidecar.ts:2383–2387, 2417–2426`) | no | per-root (cross-task) |
| **Surface VerificationEvents** | embedded *inside* `trust.bundle` | `buildTrustBundle` | n/a (bundle is signed at seal) | per-task |
| **Transitions (Flow)** | Flow's `state.json.transitions[]` | `@kontourai/flow` `saveRun` (not yet wired in Flow Agents) | no | per-run |

The hash-chain is the security spine: `command-log.jsonl` records `hash = sha256(prevHash + canonicalJson(record))`
with a genesis sentinel and a serialized read→compute→append critical section under a lock so parallel agents
cannot fork the chain (`scripts/hooks/evidence-capture.js:12–26, 95–122, 357–384`). This is the tamper-evidence
primitive ADR 0017 Layer 1 leans on ("independent capture", `docs/adr/0017-...md:45–48`).

**Reconciliation requirement (§2):** a `WorkflowRun` event log must *subsume or generalize* these, not become
a competing parallel log. ADR 0010 already rejected "a new bespoke stream-to-Console mechanism"
(`docs/adr/0010-...md:128–130`); the same anti-fork instinct applies here.

### 1.4 How a run "seals": checkpoint → sign → deliver

On `advance-state … --status delivered` (`workflow-sidecar.ts:1368–1372`):
1. `sealTrustCheckpoint` (`workflow-sidecar.ts:1489–1527`) builds a Surface trust *report* from the bundle,
   freezes a `checkpointFromReport` derivation, and writes `trust.checkpoint.json` (envelope: slug, status,
   phase, `sealed_at`, `commit_sha`, `checkpoint`).
2. `signCheckpointAttestation` (`workflow-sidecar.ts:1548+`) computes `sha256(trust.checkpoint.json)` as the
   subject, wraps it in an in-toto Statement, and either Sigstore-signs it (CI/OIDC →
   `trust.checkpoint.sig.json`) or writes an unsigned in-toto statement (local →
   `trust.checkpoint.intoto.json`). The checkpoint file is **never modified after its digest is computed**
   (`workflow-sidecar.ts:1609`) — it is the external anchor.
3. `publishDelivery` (`workflow-sidecar.ts:1671+`) copies bundle + checkpoint companions to `delivery/` for the
   CI `trust-reconcile` anchor (ADR 0017 Layer 2, `docs/adr/0017-...md:61–73, 87–90`).

**A sealed checkpoint is the "compiled note" of the run.** The owner's framing — *"raw notes may be less helpful
than the compiled notes or derived deterministic metadata"* — already has a home: the checkpoint is the verified,
signed, derived metadata; the raw event log is the secondary, retrievable detail. The design just needs to make
the **pointer** explicit (§3).

### 1.5 How the gate consumes state (the invariant that must not weaken)

`stop-goal-fit.js` reads `state.json` as the **primary** lifecycle source (`scripts/hooks/stop-goal-fit.js:502,
520`) and reads `trust.bundle` for verdict/checks/critique/criteria (`stop-goal-fit.js:48–49, 544+`). Critically
it **re-derives** claim status from evidence via Surface `deriveClaimStatus` rather than trusting stored status
(ADR 0017 L1, `docs/adr/0017-...md:42–48`), and cross-references claimed passes against the hash-chained
`command-log.jsonl` ("caught false-completion" blocks). The threat model names `state.json.status` as an
**agent-controlled input** (`docs/adr/0017-...md:33–38`) and `config-protection.js` blocks agent writes to
`state.json`/`current.json`/`trust.bundle`/`delivery/trust.bundle` (`docs/adr/0017-...md:56–58`).

**Invariant for this design:** event-sourcing must *strengthen* this, never weaken it. An event log that is
hash-chained and whose lifecycle projection is recomputed (not trusted) closes part of the "`state.json` is
forgeable" residual — but only if the *projection*, not a stored status, is what the gate keys off (§5).

---

## 2. Core idea — the event taxonomy and the projections

### 2.1 Principle

Model the run as an **append-only, hash-chained sequence of events**. The current sidecars become **pure folds**
over that log:

```
state.json       = foldLifecycle(events)
acceptance.json  = foldAcceptance(events)     # criteria + goal_fit
trust.bundle     = foldTrust(events)          # claims+evidence+events → Surface deriveClaimStatus
handoff.json     = foldHandoff(events)
current.json     = foldCurrent(events_across_runs)   # active run pointer
```

A projection is *deterministic and versioned* (this matches ADR 0013's "AGENTS.md is a projection of claims"
framing, `docs/adr/0013-...md:99–104`, and ADR 0010's "claim status recomputed by a pure, versioned function",
`docs/adr/0010-...md:27`). The event log is the source of truth; the sidecars are caches you can delete and
rebuild.

### 2.2 Event taxonomy (proposed)

Every event shares an envelope (reusing the `command-log.jsonl` chain shape, `evidence-capture.js:12–26`):

```jsonc
{
  "type": "PhaseAdvanced",
  "run_id": "<slug or flow run_id>",
  "seq": 42,
  "at": "2026-06-27T12:00:00Z",
  "actor": "tool-worker|local|workflow-sidecar|evidence-capture",
  "source": "advance-state",          // the command/hook that emitted it
  "payload": { ... },                  // type-specific
  "_chain": { "seq": 42, "prevHash": "…", "hash": "sha256(prevHash + canonicalJson(record))" }
}
```

Proposed event types, mapped to today's writers:

| Event | Emitted by today | Payload | Folds into |
|---|---|---|---|
| `SessionStarted` | `ensureSession` / `initSidecars` (`workflow-sidecar.ts:858–906`) | slug, source_request, flow_id, step_id, criteria[] | state.json, acceptance.json |
| `PhaseAdvanced` | `advanceState` (`:1321–1374`) | from_phase, to_phase, status, summary, next_action | state.json, handoff.json |
| `RouteBack` | `advanceState` route-back guard (`:1338–1348`) | from_phase, to_phase, reason, attempt_count | state.json, `transition-attempts.json` |
| `EvidenceRecorded` | `recordEvidence` (`:1209–1223`) | check(kind,status,evidence_refs) | trust.bundle |
| `ClaimMade` | `recordGateClaim` (`:1261–1317`) | claimType, subjectType, status, evidence | trust.bundle |
| `CommandObserved` | `evidence-capture.js:349–384` (**already an event**) | command, observedResult, exitCode | trust.bundle evidence/traces |
| `CritiqueRecorded` | `recordCritique` (`:1381–1396`) | findings[], verdict | trust.bundle |
| `LearningRecorded` | `recordLearning` (`:1752+`) | correction/prevention | learning projection |
| `AgentEvent` | `recordAgentEvent` (`:917–931`, **already an event**) | agent_id, kind, status, summary, ref | per-agent timeline |
| `LivenessSignal` | `livenessLifecycle` (`:2417–2426`, **already an event**) | claim/heartbeat/release, ttl | liveness stream |
| `CheckpointSealed` | `sealTrustCheckpoint` (`:1489–1527`) | checkpoint digest, commit_sha, attestation ref | trust.checkpoint.json (the seal) |
| `DeliveryPublished` | `publishDelivery` (`:1671+`) | delivery paths | delivery/ |

**Note three of these (`CommandObserved`, `AgentEvent`, `LivenessSignal`) are *literally already* append-only
events today.** The taxonomy is mostly *naming and unifying what is already emitted*, plus turning the destructive
`writeState` into `PhaseAdvanced`/`RouteBack` events.

### 2.3 The projection functions (folds that reproduce today's sidecars)

- `foldLifecycle(events) → state.json`: scan events in `seq` order; the latest `PhaseAdvanced`/`SessionStarted`
  sets `status`/`phase`/`next_action`; `RouteBack` events feed `transition-attempts.json`. Reproduces
  `writeState`'s output (`:1109–1110`) exactly, but now derivable *at any seq* (replay).
- `foldAcceptance(events) → acceptance.json`: `SessionStarted.criteria` seeds the list; `EvidenceRecorded`/
  `ClaimMade` referencing a criterion update its status; `goal_fit` derived from the goal-fit claim. Reproduces
  `initSidecars`' acceptance shape (`:865–869`).
- `foldTrust(events) → trust.bundle`: the existing `buildTrustBundle` (`:260`) **already is this fold** — feed
  it the `EvidenceRecorded`/`ClaimMade`/`CritiqueRecorded`/`CommandObserved` events instead of re-reading bundle
  files. Status stays **recomputed** via Surface `deriveClaimStatus` (no change to the trust security model).
- `foldHandoff(events) → handoff.json`: latest summary + next_steps from `PhaseAdvanced` (`:1352`).

**Acceptance test for the whole design:** for any existing `.flow-agents/<slug>/`, replaying its derived event
log must reproduce the current `state.json`/`acceptance.json`/`trust.bundle`/`handoff.json` **byte-identically**
(modulo `updated_at`). This is the migration's correctness oracle (§6, Phase A exit criteria).

---

## 3. The "rebuild the session" capability (replay / trace)

### 3.1 Replay to any point

Because every projection is `fold(events[0..n])`, you can fold to **any `seq`** and get the exact state at that
moment: `replay --at <seq|timestamp>` reconstructs `state.json` + `trust.bundle` as they *were*. This is what the
owner means by *"recreate the session and what happened … corroborating evidence."* Today this is impossible —
`writeState` overwrote it.

### 3.2 Trace / timeline

A `trace` (or `timeline`) command renders the event log as an ordered who-did-what-when:

```
seq  at                    actor          event            detail
1    12:00:00Z  workflow-sidecar  SessionStarted   slug=foo, 4 criteria, flow=builder.build
7    12:03:10Z  tool-worker       CommandObserved  `npm test` → pass (exit 0)
8    12:03:12Z  workflow-sidecar  EvidenceRecorded builder.verify.tests = pass
12   12:05:00Z  workflow-sidecar  PhaseAdvanced    execution → verification
15   12:06:00Z  evidence-capture  CommandObserved  `npm run build` → fail (exit 1)
16   12:06:30Z  workflow-sidecar  RouteBack        verification → execution (implementation_defect, attempt 1)
…
40   12:20:00Z  workflow-sidecar  CheckpointSealed digest=ab12…, signed (CI) / unsigned (local)
```

This *is* the observability/trace role (§4). Flow already ships `renderResume`/`renderSummary`/`projectFlowRun`
(see §8) that could render this if the events live in a `FlowRun`.

### 3.3 Separation but rebuildable — "compiled notes vs raw notes"

Map the owner's framing directly onto existing artifacts:

| Owner's term | Artifact | Property |
|---|---|---|
| **Compiled notes / verified state** | `trust.checkpoint.json` (+ `.sig`/`.intoto`) and the `trust.bundle` it seals | signed, derived, the thing the gate + CI trust |
| **Derived deterministic metadata** | the projections (`state.json`, `acceptance.json`) | recomputable, versioned folds |
| **Raw notes / corroborating evidence** | the full event log (`run-events.jsonl`) | secondary, retrievable, hash-chained |
| **The pointer** | `event_log_ref` + `event_log_head_hash` fields added to the checkpoint envelope (`:1506–1517`) | sealed state points at the raw log without inlining it |

So: the sealed checkpoint carries a **pointer** (`event_log_ref` + the head chain hash) to the raw event log.
*"If an agent (or anyone) asks, we have a pointer to this part as it's less relevant to the verified state but
still retrievable."* The verified state travels light (checkpoint + bundle to CI per ADR 0017 delivery
transport, `docs/adr/0017-...md:87–90`); the raw log stays local/retrievable. This mirrors ADR 0010's
"local file is the source of truth; Console is an optional projection" split (`docs/adr/0010-...md:57–66`).

---

## 4. Observability / trace role — what a consumer gets

- **Agent (or future session):** ADR 0013's "gleaning in-progress work" (`docs/adr/0013-...md:54–65`) gets a
  real timeline instead of a flattened `state.json`. It can *replay* a prior session to see intent + verified
  facts, respecting claim status (the ADR 0013 safety line).
- **Human / owner:** "why did this phase advance?" → the `PhaseAdvanced` event + the `EvidenceRecorded`/
  `ClaimMade` events that preceded it, in order. "Why did the gate block?" → replay to the gate's `seq` and
  inspect the exact bundle it saw.
- **Future Console:** ADR 0010 already designates Surface as the projection owner
  (`docs/adr/0010-...md:57–66`); `@kontourai/flow` already ships console projections
  (`projectFlowRun`, `FlowConsoleProjection`, `startFlowConsoleServer` — §8). The event log feeds these for free.
- **Debugging a gate decision:** the killer feature. Because the gate re-derives from evidence, replaying the
  event log to the exact `seq` the gate ran reproduces its verdict deterministically — a true debugger for the
  trust gate.

---

## 5. Trust / security invariants preserved (ADR 0017 must not weaken)

| ADR 0017 invariant | Source | How event-sourcing preserves / strengthens it |
|---|---|---|
| Gate **re-derives** verdict from evidence, never trusts stored status | `docs/adr/0017-...md:42–48` | `foldTrust` *is* the re-derivation (Surface `deriveClaimStatus`). Unchanged. The gate keys off the **projection**, not a stored `status`. |
| **Independent, hash-chained** capture | `evidence-capture.js:95–122`; `docs/adr/0017-...md:45–48` | The event log **reuses the same `_chain` construction**. Generalizing the chain to *all* events extends tamper-evidence to lifecycle + agent events, which today are unchained. **Net strengthening.** |
| `state.json` is agent-forgeable → don't trust it | `docs/adr/0017-...md:33–38, 98` | A *derived, chained* lifecycle projection is harder to forge silently than a free-form mutable file: tampering breaks the chain. The gate should treat the **fold output** as authoritative, and `config-protection.js` must additionally protect `run-events.jsonl` (add it to the protected set, `docs/adr/0017-...md:56–58`). |
| Checkpoint seals + signs; CI reconciles | `:1489–1527, 1548+`; `docs/adr/0017-...md:61–90` | `CheckpointSealed` event + the pointer (§3.3) make the seal an *event over the log*; the signed checkpoint digest still anchors externally. CI `trust-reconcile` is unchanged (it reconciles the bundle, which is still a fold). |
| External CI anchor is the real boundary | `docs/adr/0017-...md:113–130` | Unchanged. Event-sourcing is a *local* observability/integrity gain; it does **not** claim to replace the CI anchor. Be explicit about this so the design isn't oversold. |

**Hard rule:** the event log is **append-only and chained**; "edit history" = append a compensating event, never
rewrite. Any projection that disagrees with a fresh fold is a tamper signal. The anti-gaming regression suite
(ADR 0017 L4, `docs/adr/0017-...md:79–85`) must gain a test that asserts "a hand-edited event log breaks the
chain and the gate notices."

---

## 6. Migration plan — phased, honoring "no legacy / no fallbacks"

Standing constraint (owner, verbatim): *"long term.. no legacy or fallbacks please.. fine if you're just using
it in execution transition."* So dual-write is allowed **as transition scaffolding**, but the **end state has
zero `state.json`-as-source-of-truth fallback**. Each phase is proof-gated (mirroring ADR 0010's proof-gated
phases, `docs/adr/0010-...md:84–115`) — keep `prove-capture-teeth` and the anti-gaming suite green throughout.

### Phase A — Emit the unified event log (additive, read-only, reversible)
**Ships:** every existing writer *also* appends a typed, hash-chained event to `run-events.jsonl`
(`SessionStarted` from `:858`, `PhaseAdvanced`/`RouteBack` from `:1321–1348`, reuse the already-emitted
`CommandObserved`/`AgentEvent`/`LivenessSignal`). Sidecars stay the source of truth. **No behavior change.**
**Exit criteria:** `replay`/`trace` command exists (read-only); folding the event log reproduces the live
sidecars byte-identically for every task in `.flow-agents/`. **Reversible:** delete the new file + command.

### Phase B — Switch projections to be the source of truth (dual-write scaffolding)
**Ships:** `writeState`/`writeTrustBundle`/etc. are reimplemented as `append event → fold → write sidecar`. The
sidecars become **caches written from the fold**, not authored directly. The gate and CI still read the sidecar
files (no consumer change yet). This is the *"using it in execution transition"* the owner OK'd.
**Exit criteria:** a `--rebuild` flag regenerates every sidecar purely from events and matches; an integrity
check (`fold(events) == sidecar`) runs in the anti-gaming suite. **Reversible:** flip the writer back to direct.

### Phase C — Move consumers onto the projection API; REMOVE the mutable writes (clean end state)
**Ships:** the gate (`stop-goal-fit.js`) and CI (`trust-reconcile.js`) read via the projection/fold (or a
generated read-model), not by parsing a hand-authored `state.json`. Then **delete** the direct `writeState`
mutation path and the "`state.json` is primary" reads (`stop-goal-fit.js:502, 520`). `state.json` either (a)
disappears in favor of the fold, or (b) remains strictly as a **generated, read-only cache** of `foldLifecycle`
with no independent authority. **No fallback to a hand-written `state.json` remains.**
**Exit criteria:** grep shows no code path writes lifecycle state except via an event; `config-protection.js`
protects `run-events.jsonl`; the anti-gaming suite proves a tampered log is caught. **This is the legacy-free
end state.**

### Phase D — (negotiated) push event-sourcing upstream into Flow's `FlowRun`
**Ships:** per ADR 0001, the generic run/event kernel belongs to Flow. If Flow accepts an append-only event log
under `FlowRun` (today it's a mutable `state.json` + `transitions[]`, §8), Flow Agents *consumes* it and deletes
its bespoke log entirely — the ultimate "no fork." **This is a cross-repo decision, an open question (§7), not a
commitment of this ADR.**

**End state (zero legacy):** one hash-chained event log per run; all sidecars are generated projections or gone;
the gate/CI key off re-derived projections; the checkpoint points at the raw log; no hand-authored mutable
`state.json` with independent authority anywhere.

---

## 7. Risks / open questions / smallest first slice

### 7.1 Thinnest valuable first slice (recommended)
**Phase A only, scoped to read-only.** Concretely: emit `run-events.jsonl` from the writers that *don't already*
emit events (`SessionStarted`, `PhaseAdvanced`, `RouteBack` — i.e. wrap `writeState`/`advanceState`), unify the
three existing event streams *by reference* (don't move them yet), and ship a `workflow-sidecar trace <dir>` +
`replay --at <seq>` read-only command. **Source of truth does not change.** This delivers the owner's
"recreate the session" value immediately, is fully reversible, touches no security-critical consumer, and
produces the correctness oracle (fold == sidecar) that de-risks every later phase. **Smallest demo:** `trace`
on an existing finished task in `.flow-agents/` showing its real timeline incl. the route-back and the seal.

### 7.2 Top open questions for the owner
1. **Reuse vs build — where does event-sourcing live (ADR 0001 boundary)?** Flow already owns Flow Runs
   (`docs/adr/0001-...md:30–36`) and ships a `FlowRun` primitive — but it's *mutable state + a transitions
   array*, not an event-sourced fold (§8). Do we (a) build the event log in Flow Agents and keep it (violates
   "consume Flow" a bit), (b) build it in Flow Agents now and push it upstream later (Phase D), or (c) get Flow
   to add event-sourcing first and block on that? This is *the* decision; everything else follows.
2. **One log or keep the streams separate-but-indexed?** Do we physically merge `command-log.jsonl` +
   `agents/*/events.jsonl` + `liveness/events.jsonl` into one `run-events.jsonl` (cleaner replay, but
   `command-log` is the ADR 0017 *independent* capture truth source — merging it with sidecar-written events may
   weaken its independence), or keep them physically separate and merge *only at read/replay time* via a unified
   index? Leaning **separate-but-indexed** to preserve the independence ADR 0017 L1 relies on.
3. **Does the gate key off the fold or the cached sidecar in the end state?** If the gate folds the event log
   live, that's the strongest integrity story (tamper breaks the chain) but adds a fold to the hot Stop-hook path
   (ADR 0010 already flagged hook weight as a cost, `docs/adr/0010-...md:77–82`). If it reads a generated cache,
   we need the integrity check to run somewhere authoritative. Which?

### 7.3 Other risks (eyes open)
- **Two source-of-truth files during Phase B** (event log + sidecar cache) is exactly the kind of dual-write the
  owner dislikes; it's only acceptable because it's bounded transition scaffolding with a deletion deadline
  (Phase C). Name the deadline or it becomes permanent legacy.
- **Replay determinism depends on projection-version pinning.** If `buildTrustBundle`/Surface `deriveClaimStatus`
  change, replaying old events may yield a different bundle. Need to record `statusFunctionVersion`
  (already exposed on the Surface module) in events, as ADR 0010 already treats status as a *versioned* function.
- **`command-log` independence vs unification.** Folding sidecar-authored events and the independent capture into
  one chain could let a compromised sidecar writer influence the capture chain. Keep them separate (Q2).
- **Cost/benefit honesty:** this is a sizable refactor of the single most security-sensitive subsystem (the one
  ADR 0017 says "twice broke the capture loop from haste", `docs/adr/0010-...md:80–82`). The read-only first
  slice delivers ~80% of the *observability* value at ~10% of the risk. Resist doing Phases B–C until the owner
  confirms the §7.2 Q1 boundary.

---

## 8. Reuse vs build — `@kontourai/flow` already has a `FlowRun` (this is decisive)

Per ADR 0001 "Flow owns Flow Definitions, **Flow Runs**, steps, gates, transitions, gate evidence, exceptions,
continuation, Flow Reports" (`docs/adr/0001-...md:30–36`) and "Flow Agents has to map existing sidecars into
Flow concepts over time" (`docs/adr/0001-...md:61`). The installed `@kontourai/flow` package **already exports a
run primitive** (`node_modules/@kontourai/flow/dist/index.d.ts`):

- **Run lifecycle:** `startRun`, `loadRun`, `saveRun`, `evaluateRun`, `listRuns`, `scaffoldDemoRun`
- **Transitions:** `validateRunTransition`, `validateTransitionRequest`, `validateEvaluationTransition`,
  `validateRunStateIdentity`, `routeBackAttempt`/`routeBackDecision`/`routeTargetForReason`
- **Projection / reporting:** `projectFlowRun`, `projectFlowRunFromFiles`, `renderResume`, `renderSummary`,
  `renderMarkdownReport`, `reportJson`, plus Console projections (`FlowConsoleProjection`,
  `startFlowConsoleServer`)
- **Watch / observe:** `createRunWatcher`, `RunWatcher`
- **Run layout + evidence manifest:** `FLOW_RUN_LAYOUT` (frozen), `FLOW_RUN_STATE_FILE` (`state.json`),
  `FLOW_RUN_EVIDENCE_DIR` (`evidence`), `FLOW_RUN_EVIDENCE_MANIFEST_*`, `FLOW_RUN_REPORT_{JSON,MARKDOWN}_FILE`,
  `runDir`, `assertSafeRunId`

**But the shape is state-based, not event-sourced.** `FlowRunState extends MutableRecord` with
`gate_outcomes: GateOutcome[]` and `transitions: MutableRecord[]` accumulated *in place*
(`node_modules/@kontourai/flow/dist/contracts/flow-types.d.ts`, `FlowRunState`). It is a richer mutable
`state.json` (it keeps a transitions log) — closer to event-sourcing than Flow Agents' current `state.json`, but
**not** a pure append-only event log you can fold to any point. Flow Agents does not yet wire its sidecars to
this (`@kontourai/flow` is consumed today only for kit-container validation, `src/flow-kit/validate.ts:94–115`,
and FlowDefinition routing).

**Implication for this design:**
- **Do not build a bespoke parallel run/event domain** that ignores Flow's `FlowRun` — that's the exact
  consume-never-fork violation ADR 0001/0010 warn against.
- The honest path: (1) the **thin read-only slice in Flow Agents** (§7.1) using the existing chain primitive,
  which is cheap and reversible; (2) in parallel, take the **event-sourcing-vs-mutable-`transitions[]`** question
  to Flow, because the right long-term home for an append-only `WorkflowRun` event log is *inside* `FlowRun`
  (Phase D). If Flow adds the event log, Flow Agents consumes it and deletes its own — the cleanest legacy-free
  end state and the one most faithful to ADR 0001.

---

## 9. Recommendation

1. **Ship the read-only first slice (Phase A):** unify the timeline, emit `run-events.jsonl` (reusing the
   `evidence-capture.js` hash-chain), add `trace` + `replay --at`. Delivers the owner's "recreate the session"
   value now, fully reversible, no consumer/security change.
2. **Treat the projection-fold == sidecar equality as the correctness oracle** for everything after.
3. **Resolve §7.2 Q1 (where event-sourcing lives) with the owner + Flow before Phases B–C.** Because Flow already
   owns Flow Runs and ships a `FlowRun` primitive, the likely-correct end state is *event-sourcing inside Flow's
   `FlowRun`, consumed by Flow Agents* — not a permanent bespoke Flow Agents log.
4. **Preserve ADR 0017 by construction:** keep the capture chain independent, make the gate key off the
   re-derived projection (not stored status), protect `run-events.jsonl`, and add a "tampered-log-is-caught"
   test to the anti-gaming suite. Sell event-sourcing as a *local integrity + observability* gain — **not** as a
   replacement for the external CI anchor, which remains the real boundary (`docs/adr/0017-...md:113–130`).

---

## Appendix — key file:line references

- State machine: `src/cli/workflow-sidecar.ts:13` (statuses), `:14` (phases)
- `state.json` writes: `initSidecars` `:858–873`; `writeState` `:1109–1110`
- `advance-state` + route-back + terminal seal: `:1321–1374` (route-back `:1338–1348`, seal `:1368–1372`)
- Agent events (already append-only): `recordAgentEvent` `:917–931`
- Liveness stream (already append-only): `:2382–2387, 2417–2426`
- Trust bundle fold: `buildTrustBundle` `:260`; `writeTrustBundle` `:523–563`; Surface module `deriveClaimStatus` (~`:155–165`)
- Checkpoint seal / sign / deliver: `sealTrustCheckpoint` `:1489–1527`; `signCheckpointAttestation` `:1548+` (digest immutability `:1609`); `publishDelivery` `:1671+`
- Command-log hash chain (already append-only): `scripts/hooks/evidence-capture.js:12–26, 95–122, 357–384`
- Gate state/bundle reads: `scripts/hooks/stop-goal-fit.js:48–49, 502, 520, 544+`
- ADR 0001 (Flow owns Flow Runs): `docs/adr/0001-...md:30–36, 61`
- ADR 0010 (bundle fold; state.json stays lifecycle; Phase 4): `docs/adr/0010-...md:27, 36–46, 57–66, 113`
- ADR 0013 (projection-of-claims; gleaning): `docs/adr/0013-...md:54–65, 99–104`
- ADR 0017 (re-derive; chain; state.json forgeable; CI anchor): `docs/adr/0017-...md:33–48, 56–58, 61–90, 113–130`
- `@kontourai/flow` FlowRun primitive: `node_modules/@kontourai/flow/dist/index.d.ts` (exports); `FlowRunState` in `.../contracts/flow-types.d.ts`; `FLOW_RUN_LAYOUT` in `.../runtime/flow-files.js`
- Flow consumed today only for validation/routing: `src/flow-kit/validate.ts:94–115`
