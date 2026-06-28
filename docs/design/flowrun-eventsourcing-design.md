# DESIGN DOC: Evolving Flow's `FlowRun` to be EVENT-SOURCED

**Status:** DRAFT for owner / Flow-maintainer review. Design only — no Flow source modified.
**Date:** 2026-06-27
**Repo:** `/Users/brian/dev/github/kontourai/flow`
**Branch studied:** `feat/emit-trust-bundles` @ 269ae97 (in-flight; one commit ahead of `origin/main`).
**Relates to:** Flow ADR 0001 ("Flow owns Flow Runs / transitions"), the in-flight trust-bundle emission work, and the companion consumer design `scratchpad/workflowrun-design.md` (Flow Agents side).

---

## 0. TL;DR — the three load-bearing findings

1. **`FlowRun` is NOT partway event-sourced.** The prompt's premise that `flow-run-store.ts:~85` already holds a run `events[]` array is a **false lead**: that `events: [...]` at `src/runtime/flow-run-store.ts:85-96` is the **demo acceptance-bundle fixture** — a Hachure *TrustBundle*'s `events` field (claims/evidence/policies/events) written into `scaffoldDemoRun`. It has nothing to do with `FlowRunState`. The actual persisted run state (`schemas/flow-run.schema.json:7`, `src/contracts/flow-types.ts:83-97`) has **no `events[]` at all**. It is a **mutable record** with three accumulated arrays — `gate_outcomes[]`, `transitions[]`, `exceptions[]` — plus a **stored** `status` and `current_step` that are set imperatively. So this work is **"introduce an event log,"** not "promote `events[]` to source of truth."

2. **`status`/`current_step` are stored, not folded.** `applyEvaluation` (`src/gates/flow-gates.ts:237-320`) mutates `state.status`, `state.current_step`, pushes to `state.transitions`, and merges `state.gate_outcomes` **in place**, then `saveRun` overwrites `state.json` (`flow-run-store.ts:209-214`). The projection (`projectFlowRun`, `src/console/console-projection.ts:577-607`) **reads the stored `state.status`/`state.transitions` directly** (`:585, :591`) — it re-shapes mutable state, it does not fold. **`transitions[]` is the closest thing to an event log that exists today**, but it is a *derived byproduct* of mutation, not the source of truth.

3. **The in-flight branch matters two ways.** `feat/emit-trust-bundles` (a) **adds** `writeTrustBundles` into `saveRun` (`flow-run-store.ts:193-214`) — emitting derived Hachure trust bundles per-gate + run-level under `<run>/trust/`; this is an **emission/projection** pattern the event log should align with, not collide with — and (b) **removes** `reDeriveBundleReports` + the per-evidence **`inquiry_records`** append-only audit series (deleted at `flow-run-store.ts` and `flow-types.ts` in the diff). Those `inquiry_records` were *"append-only series of point-in-time inquiry records … event high-water mark"* — i.e. the **one genuinely event-sourced-shaped structure in the codebase was just deleted on this branch.** The design must not resurrect it; it must reintroduce that discipline at the **run** level instead of the per-evidence level.

**Recommendation:** the thinnest valuable slice is to **add an append-only `events[]` log to `FlowRunState`, written by the existing mutators as a side-channel, with `transitions[]` redefined as a fold over it** — and prove fold-equality against today's `transitions[]`/`status`. Defer hash-chaining and "delete the mutable writes" to later phases gated on owner decisions.

---

## 1. Current-state map (grounded in file:line)

### 1.1 What persists today — `FlowRunState`

Schema `schemas/flow-run.schema.json` requires (`:7`): `schema_version` (const `"0.1"`, `:12`), `run_id`, `definition_id`, `status`, `current_step`, `gate_outcomes`, `transitions`, `exceptions`. TS mirror at `src/contracts/flow-types.ts:83-97`. Initial value at `src/definition/flow-definition.ts:350-368`: `status:"active"`, `current_step:firstStep.id`, empty `gate_outcomes/transitions/exceptions`. **No `events[]` field anywhere.**

| Array / field | What it holds today | Where written | Source of truth? |
|---|---|---|---|
| `status` (string enum, schema `:36`) | Current lifecycle status (`active`/`blocked`/`needs_decision`/`completed`/`failed`/`accepted_by_exception`) | set imperatively in `applyEvaluation` (`flow-gates.ts:253, 255, 289, 313`), `acceptException` (`flow-run-store.ts:349`) | **STORED** (not derived) |
| `current_step` (schema `:38`) | Current step id; open gates derived from it | `applyEvaluation:252, 290`; `initialState:361` | **STORED** |
| `gate_outcomes[]` (schema `:56-60`, `:73-110`) | Latest decision **per gate** — `mergeGateOutcome` *replaces* any prior outcome for the same `gate_id` (`flow-gates.ts:232-235`). One row per gate, **last-write-wins, not append-only.** | `applyEvaluation:239` | derived-ish but **collapsed** (history lost) |
| `transitions[]` (schema `:61-65`, `:111-135`) | **Append-only-ish** history of step movements: each pass/block/route-back pushes a `{from_step,to_step,status,reason,at,gate_id,…}` row (`flow-gates.ts:244, 257, 279, 291`). Carries `type:"route_back"`, `attempt`, `route_reason`, `limit_exceeded`, `classifier`, `diagnostics`, `analytics`. | `applyEvaluation` only | **this is the de-facto event log**, but it is a *byproduct* of mutation and only covers transitions (not evidence/exception/seal events) |
| `exceptions[]` (schema `:66-70`, `:137-148`) | Accepted exceptions `{id,gate_id,reason,authority,accepted_at}` — append-only | `acceptException` (`flow-run-store.ts:341-348`) | append-only, but separate stream |
| evidence | `evidence-manifest.json` (separate file), append via `attachEvidence` (`flow-run-store.ts:252-312`); `run.manifest.evidence.push` (`:309`) | append-only, separate file | separate stream |

### 1.2 How status/projection are derived

- `evaluateRun` (`flow-run-store.ts:314-336`): loads run, evaluates open gates via `evaluateGate` (pure, `flow-gates.ts:133-230`), validates the transition (`validateEvaluationTransition`), then calls **`applyEvaluation`** which **mutates** state, then `saveRun`.
- `applyEvaluation` (`flow-gates.ts:237-320`) is the single chokepoint that turns a gate outcome into: a merged `gate_outcomes` row, a pushed `transitions` row, and **assignment of `status`/`current_step`/`next_action`/`updated_at`**. This is exactly the imperative state machine an event-fold would replace.
- `projectFlowRun` (`console-projection.ts:577-607`) reads **stored** `state.status` (`:591` via `projectRunIdentity`), `state.current_step` (`:594`), `state.transitions` (`:585`), `state.gate_outcomes` (via `projectGate`), `state.exceptions` (`:586`). **The projection is a re-shaping of stored mutable fields — `status` is NOT a fold.**
- `reportJson`/`renderSummary`/`renderResume` (`src/reports/flow-reports.ts:16, 124, 164`) likewise read `state.status`/`state.current_step` directly (`:23, :25, :127, :169`).

**Verdict:** Flow today is a classic **mutable state-machine record**. `transitions[]` + `exceptions[]` + the evidence manifest are *append-ish side records*; `status`/`current_step`/`gate_outcomes` are *destructively overwritten*. There is **no single ordered event log** and **no fold** producing `status`. This is meaningfully *less* event-sourced than the prompt assumed, and the one append-only audit structure (`inquiry_records`) was **removed on this branch** (§1.3).

### 1.3 What `feat/emit-trust-bundles` changed (the in-flight diff — `git diff origin/main..HEAD`)

The single commit `269ae97 feat: emit per-gate and run-level trust bundles (recursive trust)` does two things relevant here, plus a large console-UI/reports deletion (out of scope):

**(a) ADDS emission into the save path.** `writeTrustBundles` (`flow-run-store.ts:193-207`) now runs inside `saveRun` (`:213`): it builds a run-level Hachure trust bundle via `buildFlowTrustBundle({state})` and one per `gate_outcome` via `buildGateTrustBundle` (`src/gates/flow-trust-emit.ts:173-294`), writing them under `<run>/trust/run.json` and `<run>/trust/<gate>.json` (`src/runtime/flow-files.ts:14-36`). **These bundles are pure folds over `state.gate_outcomes`** (`flow-trust-emit.ts:201, 208-214`) — i.e. Flow already adopted the pattern "derive an inspectable artifact from run state on every save." An event log is the **same pattern, one level deeper** (derive the bundle from the *log* instead of from the collapsed `gate_outcomes`).

**(b) REMOVES the per-evidence append-only audit series.** The diff deletes `reDeriveBundleReports` (was in `flow-run-store.ts`) and the `inquiry_records?` field on `FlowEvidenceEntry` (`flow-types.ts:63-73` — the comment described it as *"Append-only series of point-in-time inquiry records (Surface DerivationCheckpoints), one per re-derivation … status-by-claim + statusFunctionVersion + asOf + event high-water mark"*). It also drops `freshness_transitions` from `evaluateRun`'s return (`flow-run-store.ts:335`) and the `checkpointFromReport, diffFreshness` imports.

**Why this matters for sequencing:** the branch is moving Flow toward **"state in → derived trust artifacts out"** and **away from** a per-evidence append log. The event-sourcing design must (i) **build on the emission pattern** (the event log becomes the *input* to `buildFlowTrustBundle`, replacing the collapsed `state.gate_outcomes`), and (ii) **reintroduce append-only audit discipline at the RUN level** — the thing `inquiry_records` was reaching for, but cleanly, as the run's source of truth rather than a per-evidence sidecar. Do **not** re-add `inquiry_records`; that would re-create the very fork this branch just removed.

### 1.4 Flow's documented run-model stance (ADR 0001)

`docs/adr/0001-flow-as-process-transparency-layer.md:21-27`: **Flow owns** Flow Runs, steps, gates, Transitions, gate evidence, exceptions, continuation. `:71` rejects modeling process state in Surface because "Surface models trust state, not process-specific semantics such as steps, gates, transitions, and continuation." **There is no ADR on event-sourcing the run.** So introducing an event log is a *new architectural decision* that should land as its own Flow ADR — it is squarely inside Flow's owned surface per 0001, which is the right home (consistent with the consumer doc's §8 conclusion that event-sourcing belongs in `FlowRun`, not bespoke in Flow Agents).

---

## 2. Target model — event log as source of truth, `transitions[]`/`status` as folds

### 2.1 Principle

Make `FlowRunState.events[]` an **append-only ordered log** the run's source of truth. Everything else becomes a **deterministic fold**:

```
status         = foldStatus(events)        // replaces stored state.status
current_step   = foldCurrentStep(events)
transitions[]  = foldTransitions(events)   // EXACTLY today's transitions rows, derived
gate_outcomes[]= foldGateOutcomes(events)  // last-write-wins per gate, derived
exceptions[]   = foldExceptions(events)
trust bundles  = buildFlowTrustBundle(foldGateOutcomes(events))   // unchanged emission, fed by the fold
```

This is an **evolution of `applyEvaluation`**, not a rewrite: `applyEvaluation`'s existing branches (`flow-gates.ts:241-314`) become the **reducer cases** of `foldStatus`/`foldTransitions`. The mapping is nearly mechanical because the transition rows it pushes already carry the full causal payload.

### 2.2 Event taxonomy (reconciled with what exists)

Every event shares an envelope. **Reuse the `transitions[]` row shape** so the fold to `transitions[]` is near-identity:

```jsonc
{
  "seq": 7,                       // monotonic per run
  "type": "Transitioned",
  "at": "2026-06-27T12:00:00Z",   // already on every transition (schema :134)
  "actor": "flow",                // emitter; cf. trust-emit actor:"flow" (flow-trust-emit.ts:158)
  "source": "evaluateRun",        // the operation that emitted it
  "payload": { /* type-specific */ }
  // "_chain": {...}  // OPTIONAL, Phase 3 — see §3
}
```

| Event type | Maps to today | Emitted at | Folds into |
|---|---|---|---|
| `RunStarted` | `initialState` (`flow-definition.ts:350-368`) | `startRun` (`flow-run-store.ts:157-172`) | seeds `status:"active"`, `current_step`, identity |
| `GateEvaluated` | a `GateOutcome` (`flow-gates.ts:133-230`) | `evaluateRun` per gate (`flow-run-store.ts:319-333`) | `gate_outcomes[]` (last-write-wins per `gate_id`) |
| `EvidenceAttached` | manifest push (`flow-run-store.ts:309`) | `attachEvidence` | evidence projection (manifest stays its own file initially) |
| `Transitioned` (pass) | `transitions.push{status:"allowed"}` (`flow-gates.ts:244-251`) | `applyEvaluation` pass branch | `transitions[]`, advances `current_step`, `status` active/completed |
| `Blocked` | `transitions.push{status:"blocked"}` non-route (`flow-gates.ts:279-287`) | block branch | `transitions[]`, `status:"blocked"` |
| `RoutedBack` | `transitions.push{type:"route_back"}` (`flow-gates.ts:288-311`) | route-back branch | `transitions[]`, `current_step:=route_back_to`, `status:"active"`, attempt counting |
| `ExceptionAccepted` | `exceptions.push` (`flow-run-store.ts:341-348`) | `acceptException` | `exceptions[]`, `status:"accepted_by_exception"` |
| `RunSealed` *(new)* | — (no equivalent today) | a future `sealRun`/delivery | terminal marker + head pointer for checkpoints (§4d) |

**Reconciliation note:** `GateEvaluated` and `Transitioned`/`Blocked`/`RoutedBack` are *distinct* events even though `applyEvaluation` does both in one call — the gate **decision** and its **effect on the run** are separate facts (the consumer doc wants the gate decision replayable independently). The fold re-derives `gate_outcomes[]` from `GateEvaluated` and `transitions[]` from the `Transitioned/Blocked/RoutedBack` family. This is the cleanest split and keeps `evaluateGate` (pure, already side-effect-free) unchanged.

**`attempt`/`limit_exceeded` route-back counting** currently reads `state.transitions` (`flow-definition.ts:415` `priorMatches`). After the change it reads `foldTransitions(events)` — identical data, so route-back cascade behavior (and the route-back tests) are preserved by construction.

### 2.3 Schema evolution

Add `events[]` to `schemas/flow-run.schema.json` (currently `additionalProperties:false`, `:8`, so this is a required, deliberate edit). Two viable shapes — **owner/maintainer decision**:

- **(A) Additive, bump `schema_version` 0.1→0.2:** `events[]` becomes **required**; `transitions[]`/`gate_outcomes[]`/`status` remain in the persisted file but are documented as **derived caches** (regenerated on save from the fold). Old `0.1` runs lack `events[]` → see migration §5.
- **(B) Pure log, defer:** persist **only** `events[]` (+ identity), drop the derived arrays from disk entirely, regenerate on read. Cleaner end state, bigger blast radius (every reader of `state.transitions`/`state.status` must go through the fold). This is the **zero-legacy end state** but should not be the first slice.

---

## 3. Tamper-evidence — should the log be hash-chained?

The consumer (ADR 0017, per `scratchpad/workflowrun-design.md` §5) leans on the flow-agents `command-log.jsonl` hash chain (`hash = sha256(prevHash + canonicalJson(record))`) as its tamper-evidence spine. If Flow Agents will *trust this log as a tamper-evident record*, the Flow event log should support an **optional** `_chain` per event with the **same construction** so the two integrity stories compose.

**Recommendation: design the envelope to carry an optional `_chain`, but do NOT couple Flow to flow-agents specifics.**
- Flow already imports `createHash` from `node:crypto` (`flow-run-store.ts:1`, used in `sha256File:216-219`), so the primitive is in-repo — no new dependency.
- Keep chaining **opt-in / Phase 3**: a plain monotonic `seq` (cheap, always on) gives ordering and replay; the `_chain` adds tamper-evidence when a consumer needs it. This avoids forcing Flow to adopt flow-agents' security posture before there's a Flow-side reason to.
- **Decouple by interface, not import:** Flow defines its own `hashEvent(prevHash, event)` over a canonical JSON of the Flow envelope. Flow Agents, if it wants one chain spanning both, reconciles at read time — it does **not** require Flow to chain into flow-agents' genesis. This honors "Flow owns Flow Runs" (ADR 0001) without importing a flow-agents-specific contract.
- **Open question for maintainers (§7 Q3):** does Flow *want* tamper-evidence as a first-class run property, or is that a flow-agents concern that should stay in the consumer? The `inquiry_records` removal (§1.3) suggests Flow is currently *trimming* audit-series complexity, so pushing a mandatory chain upstream now would cut against the branch's direction. Hence: **ship chaining as opt-in, let the consumer drive whether it becomes mandatory.**

**Hard rule (if adopted):** append-only; "edits" are compensating events, never rewrites; any fold that disagrees with a re-fold is a tamper signal. Add a Flow test asserting "a hand-edited event breaks the chain / changes the fold."

---

## 4. Consumer contract for Flow Agents (Flow stays the owner)

Flow Agents consumes Flow's run primitive (ADR 0001 `:41`, "Flow Agents will be the first consumer of Flow"). Proposed additions to Flow's public API (`src/index.ts` already exports `startRun`/`loadRun`/`saveRun`/`evaluateRun`/`projectFlowRun`/`projectFlowRunFromFiles` `:161-162`):

**(a) Append events** — `appendRunEvent(runId, event, {cwd})`: validates type+payload, assigns `seq` (and `_chain` if enabled), persists, returns the stored event incl. head hash. The existing mutators (`evaluateRun`, `acceptException`, `attachEvidence`) become **internal callers** of this — Flow Agents normally appends *indirectly* by calling those, and only uses `appendRunEvent` directly for flow-agents-specific event types if Flow allows an extensibility escape hatch (open question §7 Q4).

**(b) Get projected state** — `projectFlowRun` / `projectFlowRunFromFiles` (already exist, `console-projection.ts:577, 609`) become **fold-backed**: same output shape (`FlowConsoleProjection`), but `status`/`transitions` come from the fold, not stored fields. **Consumer-transparent** — no Flow Agents change required to get the new guarantee.

**(c) Replay / trace** — `replayRun(runId, {atSeq|atTime})` → projected state as-of a point; `traceRun(runId)` → the ordered event timeline. These are the new capabilities the consumer doc's §3 ("rebuild the session") needs; they fall out for free once `status` is a fold. Render reuses `renderResume`/`renderSummary` (`flow-reports.ts:124, 164`).

**(d) Run head hash for a checkpoint pointer** — `getRunHead(runId)` → `{seq, headHash}`. This is the **"compiled vs raw notes" pointer** the consumer doc §3.3 wants: Flow Agents stores `event_log_ref + head_hash` in its sealed checkpoint, travels light, and can prove the raw log is unmodified later. Emit a `RunSealed` event (§2.2) capturing the head at seal time.

All four keep Flow as **owner of the model and the fold**; Flow Agents only **appends (indirectly) and reads**. No flow-agents trust/security types leak into Flow.

---

## 5. Migration plan — phased, honoring "no legacy / no fallbacks"

Standing owner rule: long-term **no legacy or fallbacks**; dual-keep is acceptable **only as execution-transition scaffolding** with a deletion deadline; end state = **`events[]` is the sole authority, `transitions[]`/`status` derived, no mutable field with independent authority.**

### Phase 0 — Coordinate with `feat/emit-trust-bundles` (prerequisite)
Land **on top of** 269ae97 (do not branch from `origin/main`). Shared file is `flow-run-store.ts` (both touch `saveRun`/`evaluateRun`). Sequence: let the trust-emit branch merge first (or rebase onto it), then this work treats `writeTrustBundles` as the **first consumer of the fold** (feed `buildFlowTrustBundle` from `foldGateOutcomes(events)` instead of `state.gate_outcomes`). **Do not re-add `inquiry_records`** — the run event log supersedes it.

### Phase 1 — Emit the event log (additive, reversible, no behavior change)
**Ships:** `appendRunEvent` + a typed `events[]` written **alongside** the existing mutations. `applyEvaluation` (`flow-gates.ts:237-320`) additionally appends `GateEvaluated`/`Transitioned`/`Blocked`/`RoutedBack`; `acceptException` appends `ExceptionAccepted`; `startRun` appends `RunStarted`. **Stored `status`/`transitions`/`gate_outcomes` remain the source of truth.** Schema gets `events[]` (option A, §2.3).
**Exit criteria:** `foldTransitions(events)` reproduces `state.transitions` **byte-identically** (modulo `updated_at`/`at` timestamps), and `foldStatus(events) === state.status`, for every run in `.flow/runs/` and the route-back/exception test suites. This **fold==stored equality is the correctness oracle** for all later phases. Add `replayRun`/`traceRun` (read-only).
**Reversible:** delete `events[]` writes + the two new functions.

### Phase 2 — Flip source of truth to the fold (dual-write scaffolding, bounded)
**Ships:** `saveRun` writes `transitions`/`gate_outcomes`/`status` **as a cache generated from the fold** (not from in-place mutation). `applyEvaluation` is refactored to *only* append events; the derived arrays are regenerated by folding. Readers unchanged (still read the cached fields). `writeTrustBundles` reads the fold. A `--rebuild` path regenerates every derived field purely from `events[]` and must match.
**Exit criteria:** an integrity check `fold(events) == persisted-derived-fields` runs in CI; `--rebuild` is byte-stable. **Name the deletion deadline here** (Phase 3) so the dual-write doesn't become permanent legacy.
**Reversible:** flip `saveRun` back to direct mutation.

### Phase 3 — Remove mutable authority; (optional) chain (zero-legacy end state)
**Ships:** delete the imperative `state.status = …` / `state.transitions.push(…)` assignments. `projectFlowRun`, `reportJson`, `renderResume`, route-back counting (`flow-definition.ts:415`) all read **via the fold**. Choose schema option B (persist only `events[]` + identity, derive the rest on read) **or** keep the derived fields strictly as a **generated read-only cache with no independent authority**. Optionally enable `_chain` (§3) + add the tamper-detection test. `getRunHead`/`RunSealed` shipped for the checkpoint pointer.
**Exit criteria:** grep shows no code path assigns `status`/`transitions` except by appending an event; the fold is the only authority; `schema_version` bumped; consumer (Flow Agents) reads projections/replay only.
**This is the legacy-free end state.**

**Reversibility summary:** Phase 1 fully reversible; Phase 2 reversible (flip the writer); Phase 3 is the commitment point (deletes the mutable path) — gated on the Phase-1 oracle being green across all runs/tests and the §7 open questions resolved.

---

## 6. Coordination with `feat/emit-trust-bundles` (explicit)

- **Branch base:** build on 269ae97, not `origin/main`. The branch deletes a lot of console-UI/reports/test files (`git diff --stat`: ~6k deletions) — do **not** reintroduce them; scope this work to `flow-run-store.ts`, `flow-gates.ts`, `flow-types.ts`, `schemas/flow-run.schema.json`, and new event/fold modules.
- **Shared files & conflict surface:** `flow-run-store.ts` (`saveRun:209-214`, `evaluateRun:314-336`) and `flow-gates.ts` (`applyEvaluation`). Both branches edit `saveRun`. Resolution: the event-log work **inserts** an append step in `applyEvaluation`/`saveRun` and **redirects** `writeTrustBundles`' input from `state.gate_outcomes` to the fold — additive, low conflict if rebased after trust-emit lands.
- **Direction alignment:** trust-emit = "derive inspectable artifacts from run state on save." Event-sourcing = "make the log the run state, derive everything (including those artifacts) from it." They **compose**: the trust bundle becomes a *second-order fold*. The one thing to **not** do is revive `inquiry_records` (deleted on this branch) — the run event log is its successor at the right altitude.

---

## 7. Thinnest first slice + open questions

### 7.1 Recommended thinnest first slice (Phase 1, scoped)
**Add `events[]` to `FlowRunState` + emit `RunStarted`/`GateEvaluated`/`Transitioned`/`Blocked`/`RoutedBack`/`ExceptionAccepted` from the existing mutators, plus `foldTransitions`/`foldStatus` and a read-only `traceRun`/`replayRun --at <seq>`. Keep stored `status`/`transitions` as the source of truth. Prove `fold(events) == stored` across all `.flow/runs/` and the existing route-back/exception tests.**

Why this is the right first cut: it is **safe** (no behavior change — folds run alongside, asserted equal), **valuable** (delivers the consumer's "recreate the session"/trace need immediately and the head-hash pointer can follow), **reviewable** (one schema field + append calls in the two existing mutators + two pure fold functions + a read-only command; ~no change to `evaluateGate`, gates, or the trust-emit path), and it **produces the correctness oracle** (fold==stored) that de-risks Phases 2-3. Smallest demo: `traceRun` on `./.flow/runs/run.1781102325268/` showing its real timeline derived from `events[]`, with `foldTransitions` matching the persisted `transitions[]`.

### 7.2 Top open questions (owner / Flow maintainers must decide)
1. **Schema strategy (§2.3): additive-with-derived-caches (A) vs pure-log (B)?** A is the safe first slice; B is the zero-legacy end state. Which, and is bumping `schema_version` 0.1→0.2 acceptable now (the const is `"0.1"`, `schema:12`)? *I'm unsure how many external consumers pin the `0.1` const — maintainers must confirm blast radius.*
2. **`GateEvaluated` vs `Transitioned` as separate events, or one combined event?** I recommend separate (gate decision is independently replayable, matches the consumer's gate-debugger goal), but it adds an event type and a fold case `applyEvaluation` doesn't distinguish today (`flow-gates.ts:237-320` does both in one call). Maintainer call.
3. **Does Flow want hash-chaining as a first-class run property, or keep tamper-evidence in the consumer?** The branch just *removed* the `inquiry_records` audit series (§1.3), suggesting Flow is trimming audit complexity — so I lean **opt-in `_chain`, consumer-driven** (§3), but this is genuinely the owner's architectural call about how much of ADR 0017's tamper-evidence belongs upstream in Flow vs in Flow Agents.

### 7.3 Honest uncertainties / risks
- **The prompt's `events[]@~85` premise is wrong** (it's the demo *acceptance-bundle* fixture, `flow-run-store.ts:85-96`); I want to flag this explicitly because the whole "promote vs introduce" framing hinges on it — this is **"introduce a log."** If I've misread and there's a *different* `events[]` the maintainers had in mind, that changes §2.
- **`gate_outcomes[]` is last-write-wins** (`mergeGateOutcome`, `flow-gates.ts:232-235`) — it already *loses* history. Folding from `GateEvaluated` events is strictly *more* information; the only risk is a fold that doesn't reproduce the exact collapsed array order. The oracle (§7.1) catches this.
- **Replay determinism** depends on pinning the fold/evaluator version: if `evaluateGate`/Surface status derivation changes, replaying old events may differ. Record an evaluator/`statusFunctionVersion` on events (the deleted `inquiry_records` tracked exactly this — `flow-types.ts` removed comment — so the need is real). Worth carrying even in Phase 1.
- **Two source-of-truth files during Phase 2** is exactly the dual-write the owner dislikes; only acceptable as bounded scaffolding with the Phase-3 deletion deadline named.

---

## Appendix — key file:line references
- Demo fixture `events[]` (the false lead): `src/runtime/flow-run-store.ts:85-96`
- Persisted run shape: `schemas/flow-run.schema.json:7` (required), `:36` (status enum), `:56-70` (gate_outcomes/transitions/exceptions), `:111-135` (transition row)
- `FlowRunState` TS: `src/contracts/flow-types.ts:83-97`; `GateOutcome`: `:105-113`
- Initial state: `src/definition/flow-definition.ts:350-368`; route-back attempt counting reads transitions: `:415`
- The imperative state machine (becomes the reducer): `applyEvaluation` `src/gates/flow-gates.ts:237-320`; `mergeGateOutcome` (last-write-wins) `:232-235`; pure `evaluateGate` `:133-230`
- Save/evaluate path: `saveRun` `src/runtime/flow-run-store.ts:209-214`; `evaluateRun` `:314-336`; `acceptException` `:338-353`
- Projection reads stored status (not a fold): `projectFlowRun` `src/console/console-projection.ts:577-607` (`:585` transitions, `:591` identity/status, `:594` current_step); reports `src/reports/flow-reports.ts:16, 23, 25, 124, 164, 169`
- In-flight trust emission (build ON this): `writeTrustBundles` `src/runtime/flow-run-store.ts:193-207` (called in saveRun `:213`); builders `src/gates/flow-trust-emit.ts:173-294` (run-level folds `state.gate_outcomes` `:201, 208-214`); layout `src/runtime/flow-files.ts:14-36`
- In-flight REMOVED append-only audit series (do NOT revive): `reDeriveBundleReports` + `inquiry_records` deleted in `git diff origin/main..HEAD -- src/runtime/flow-run-store.ts src/contracts/flow-types.ts`
- Public API surface: `src/index.ts:161-162` (`projectFlowRun`, `projectFlowRunFromFiles`)
- Ownership stance: `docs/adr/0001-flow-as-process-transparency-layer.md:21-27` (Flow owns Runs/Transitions), `:41` (Flow Agents is first consumer), `:71` (process semantics not in Surface)
- Hash primitive already in-repo: `node:crypto createHash` `src/runtime/flow-run-store.ts:1, 216-219`
