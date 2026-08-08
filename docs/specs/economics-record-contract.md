# `kontour.console.economics` — per-run economics record contract (v0.2)

**Status:** ratified (flow-agents #349). **Kind:** `kontour.console.economics`. **Version:** `0.2`.

## Purpose

Every kit-driven run emits exactly one **per-run economics record** — cost, time,
iterations, and defects caught — so that "flow kits save money and produce more accurate
results" is a **measurable, falsifiable** claim backed by data. This record is the
measurement substrate for the Kit-economics telemetry initiative (I32–I35): it is
consumed by the baseline harness (#350), the small-model headline (#409), and the console
value view (console #117).

## Architecture (console ADR 0003)

- **Call 1 — additive kind on one pipe.** `kontour.console.economics` is a new *versioned
  record KIND* that rides the single authenticated ingress (`ApiSink`, `POST /records`)
  alongside `kontour.console.event`, `.projection`, and `.liveness`. It is **never** a new
  endpoint or a new auth path.
- **Call 2 — tenant is bound from the verified principal.** The `ApiSink` stamps the
  authoritative tenant from the request principal. The emitter MAY carry `tenant_id`
  (from `CONSOLE_TENANT_ID`) for **self-description only**; the emitter is never the source
  of truth for tenancy.
- **Call 3 — immutable fact, rollups are projections.** This record is an **immutable
  per-run fact**. The console-side economics rollups and the value view are **rebuildable
  projections** over the stream of these records. flow-agents emits facts, never a rollup;
  this emitter computes **no cross-run aggregate**.
- **Call 6 — local-first, best-effort.** The record is **always** written to the local log
  channel first; the console POST is a **detached, fail-open** fire that can never block or
  fail a run. Every failure path is a quiet `exit 0`.

## Record shape

```json
{
  "schema": "kontour.console.economics",
  "version": "0.2",
  "run_id": "string",
  "run_correlation": {
    "schema_version": "1.0",
    "correlation_id": "opaque equality key",
    "identities": {}
  },
  "at": "epoch-millis string",
  "task_slug": "string|null",
  "model": "string",
  "pricing_version": "string|null",

  "cost": {
    "input_tokens": 0,
    "output_tokens": 0,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 0,
    "estimated_cost_usd": 0.0,
    "by_model": []
  },

  "time": {
    "wall_clock_s": 0,
    "human_wait_s": 0
  },

  "phases": [
    { "phase": "plan|execute|review|verify|unattributed",
      "input_tokens": 0, "output_tokens": 0,
      "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0,
      "estimated_cost_usd": 0.0, "wall_clock_s": 0 }
  ],

  "iterations": {
    "count": 1,
    "route_backs": 0
  },

  "defects": {
    "gate_fires": 0,
    "findings_by_severity": { "critical": 0, "high": 0, "medium": 0, "low": 0 },
    "caught_false_completions": 0,
    "verification_verdict": "PASS|FAIL|NOT_VERIFIED"
  },

  "tenant_id": "string|null"
}
```

## Field sources

Every field derives from a named telemetry event, usage field, or sidecar file. The emitter
**never re-estimates tokens** — ground truth is the transcript's `.message.usage` blocks,
already parsed by `usage_parse_transcript` (scripts/telemetry/lib/usage.sh) and carried on
the `session.usage` event.

| Field | Type | Source |
| --- | --- | --- |
| `schema` | literal | `"kontour.console.economics"` |
| `version` | literal | `"0.2"` for current producers; the schema still accepts immutable historical `0.1` records |
| `run_id` | string | canonical `run_correlation.correlation_id` when present; otherwise `session.usage .session_id` for explicitly incomplete legacy observations |
| `run_correlation` | object | exact validated envelope from the authenticated `session.usage` event; otherwise an explicit `{status:"incomplete",reason}`. Required for `0.2`; optional only when validating immutable historical `0.1` records. |
| `observation_semantics` | enum | `snapshot`; this record is an immutable observation. Its usage totals are run-scoped only when the source event declares `usage.scope: "run"`, `usage.semantics: "delta"`, and a present baseline. |
| `producer_authority` | enum | `authenticated_runtime_binding`, `fixture_input`, or `unavailable`; consumers must not treat structural correlation as runtime authentication |
| `at` | epoch-millis string | `session.usage .timestamp` (session end) |
| `task_slug` | string\|null | authenticated `session.usage .task_slug`; display metadata only, never a join key |
| `model` | string | `session.usage .usage.model` |
| `pricing_version` | string\|null | `session.usage .usage.pricing_version` (from `pricing.json` `current_version`) |
| `cost.input_tokens` | int | `session.usage .usage.input_tokens` (transcript ground truth) |
| `cost.output_tokens` | int | `session.usage .usage.output_tokens` |
| `cost.cache_creation_input_tokens` | int | `session.usage .usage.cache_creation_input_tokens` |
| `cost.cache_read_input_tokens` | int | `session.usage .usage.cache_read_input_tokens` |
| `cost.estimated_cost_usd` | number | `session.usage .usage.estimated_cost_usd` (derived; recomputable console-side from `pricing_version`) |
| `cost.by_model` | array | `session.usage .usage.by_model`, verbatim |
| `time.wall_clock_s` | int | `session.usage .usage.duration_s` |
| `time.human_wait_s` | int | elapsed time blocked on a human decision (slice-1: `0` if uninstrumented; **never omit the key**) |
| `phases[]` | array | per-phase attribution — see the phase-sum invariant below |
| `iterations.count` | int | deliver-loop passes (plan→execute→review→verify); slice-1 default `1` |
| `iterations.route_backs` | int | verify FAIL → re-plan/re-execute loops; slice-1 default `0` |
| `defects.gate_fires` | int | count of gate fires in the run |
| `defects.findings_by_severity` | object | grouped from `critique.json .critiques[].findings[]` on `.severity` (missing → `low`) |
| `defects.caught_false_completions` | int | claimed-pass ACs contradicted by trusted-backstop re-runs (DISTINCT counter) |
| `defects.verification_verdict` | enum | canonical Builder workflow outcome derived from the latest Flow `verify-gate` result (`PASS`\|`FAIL`\|`NOT_VERIFIED`); missing canonical outcome is always `NOT_VERIFIED`, regardless of artifact verdicts |
| `delegations[]` | array | per-sub-agent delegation facts + derived outcome (#415) — see below; `[]` when `--agents-dir` is absent |
| `signals` | object | harness-capability declaration — what telemetry this runtime exposed (see below + `harness-capability-matrix.md`) |
| `tenant_id` | string\|null | self-description only; the `ApiSink` stamps the authoritative tenant (ADR 0003 call 2) |
| `terminal_status` | enum\|absent | honest run-termination taxonomy (#925) — see below. Present only on `flow_run_record`-produced records today; optional/additive on `0.2`. |
| `tokens_unattributed` | boolean\|absent | `true` when one or more `phases[]` entries carry `null` token fields (no attribution source available for them). Optional/additive on `0.2`. |

## `flow_run_record` mode — deriving from the canonical Flow run store (#922/#925 phase A)

**Problem this repairs.** Every historical record before this change carried `run_id: "unknown"`
(a runtime *session* id, not a Flow run id — unjoinable to `.kontourai/flow/runs/<run-id>/`),
`producer_authority: "unavailable"`, and exactly one `{"phase":"unattributed", ...}` phase entry —
zero of the ~1,180 records on record ever attributed real per-phase cost or an honest terminal
outcome. Root cause: the emitter only ever read the `session.usage` event and the Builder
workflow *sidecar* (`--state`/`--critique`, a task-slug-directory JSON distinct from Flow's own run
store) — it never read the Flow run's own `state.json`, which is the one place a run's real
step-by-step transition history, route-backs, and lifecycle (pause/resume/cancel) actually live.

**The new source.** `economics-record.sh --flow-run-dir <path/to/.kontourai/flow/runs/RUN_ID>`
bypasses the `session.usage`-event path entirely (no positional event / stdin required) and calls
`scripts/telemetry/flow-run-economics.mjs`, which reads `state.json` (validated against
`schemas/flow-run.schema.json`'s shape: `schema_version`, `run_id`, `status`, `current_step`,
`transitions[]`, optionally `lifecycle[]` / `gate_outcome_history[]`) plus checks for
`evidence/manifest.json`. Everything below is **derived, never fabricated**; an unreadable or
malformed run directory yields **no record at all** (fail-open no-op, consistent with the rest of
this emitter), never a guessed one.

- **`run_id`** — the Flow run id (`state.run_id`, the run directory's own basename) — joinable to
  `.kontourai/flow/runs/<run-id>/` directly. `run_correlation` stays an explicit
  `{"status":"incomplete","reason":"..."}` in this mode: no runtime session is known here, and this
  mode never conflates the Flow run id with a session id (per #922's boundary). Binding a real
  session identity into `run_correlation.identities.runtime_session` alongside `flow_run` is
  **out of scope for phase A** — see "What phase A does NOT do" below.
- **`terminal_status`** (#925 taxonomy) — derived from Flow's own `status` enum, honestly:
  `completed`, `canceled`, `failed`, and `accepted_by_exception` map straight across; `active`,
  `blocked`, `needs_decision`, and `paused` all map to **`active_abandoned`** — the run had **not**
  reached a terminal state as of this record's `at` timestamp, and this mode **never** reports such
  a run as `completed`. This is the fault-injected case the eval proves: taking a snapshot of a
  known-active run must never yield `terminal_status: "completed"`.
- **`phases[]`** — one bucket per Builder step actually visited, walked from `transitions[].at`
  timestamps: the interval between transition *i-1* and transition *i* is attributed to the step
  transition *i-1* moved the run **into** (`to_step`, or the unchanged step when a transition
  blocked in place). Route-back re-entries into the same step accumulate onto the **same** bucket
  (a real run's `execute` phase, for example, sums every execute↔verify route-back loop into one
  total). The step active **before the first transition** is never attributed a duration — there is
  no observed entry timestamp for it, and this tool does not estimate one from filesystem metadata
  or a run "start" convention Flow does not itself record. A zero-duration interval (two transitions
  sharing the identical timestamp) is excluded from `phases[]` entirely rather than emitted as a
  phantom `0`-duration entry (`endMs > startMs`, strictly). `input_tokens`/`output_tokens`/
  `cache_creation_input_tokens`/`cache_read_input_tokens`/`estimated_cost_usd` are `null` (not `0`)
  on every phase in this mode, tagged `source: "flow-run-record"` — token attribution is a wholly
  separate, explicit step (see `economics-enrich-tokens.mjs` below), never auto-run here. The
  top-level `tokens_unattributed` is `true` whenever any phase has `null` tokens (always true today,
  since this mode never merges in transcript-derived tokens automatically).
  - **`wall_clock_s` is ACTIVE time, not raw calendar time (#925 review finding 2).** Every raw
    inter-transition window is intersected against the run's real lifecycle pause intervals
    (`derivePauseIntervals`, the same intervals `time.human_wait_s` sums below) and the overlap is
    **subtracted** before attribution. This was confirmed live against a currently-paused production
    run (`kontourai-flow-agents-944`): its `execute` phase's raw calendar span was ~1,256,160s
    (≈14.5 days), of which ~1,256,102s (99.995%) was a single unresumed pause — the genuine execute
    activity before that pause was ~58s. Reporting the raw span as `wall_clock_s` would have told a
    dashboard "the execute phase took 14.5 days," which is not a measurement of work, it is a
    measurement of how long an operator left the run paused. **`phases[].human_wait_s`** is the
    subtracted portion, attributed to whichever phase(s) it overlapped — a per-phase breakdown of
    the same total `time.human_wait_s` reports; it may sum to slightly less than that top-level
    total in the one disclosed edge case where a pause falls in the undropped pre-first-transition
    gap above (no phase window exists yet to attribute it to). `time.wall_clock_s` is the sum of
    `phases[].wall_clock_s` (now genuinely active time), preserving the phase-sum invariant on the
    *active* total, not the raw one.
- **`iterations.route_backs`** — count of `transitions[]` entries with `type == "route_back"`
  (Flow's own route-back ledger entry, `schemas/flow-run.schema.json` transition `$defs`).
  **`iterations.count`** — `route_backs + 1` (the initial pass, plus one additional pass per
  route-back), per this contract's "deliver-loop passes" definition.
- **`defects.gate_fires`** — from the append-only `gate_outcome_history[]` ledger (entries with
  `status` `block`/`route-back`) when the run has one; legacy runs that predate that ledger fall
  back to counting `transitions[]` entries with `status == "blocked"` (every route-back or in-place
  block is itself a gate firing against the run). Both paths are exercised by dedicated fixtures
  (`evals/fixtures/economics/run-binding/routeback-completed` carries a real-shaped
  `gate_outcome_history`, mirroring production run `kontourai-flow-agents-1206`'s ledger, so the
  `gate_outcome_history`-preferred branch is not just reachable but actually reached by the eval).
- **`defects.verification_verdict`** — the **last** transition departing the `verify` step, bounded
  by whether the run ever reached a terminal state: `PASS` if that last transition is `allowed`;
  `FAIL` only if it is `blocked` **and** the run has since terminated without a later pass (a block
  that is still open on a still-`active_abandoned` run is `NOT_VERIFIED`, not `FAIL` — the run has
  not finished attempting verification); `NOT_VERIFIED` if `verify` was never reached.
- **`time.human_wait_s`** — real pause→resume (and pause→cancel, and an still-open pause→`now`)
  intervals summed from the run's `lifecycle[]` ledger. This is the TRUE total, independent of
  phase-window attribution (see `phases[].human_wait_s` above).
- **`producer_authority: "flow_run_record"`** — a new enum value distinct from
  `authenticated_runtime_binding`. This mode reads real on-disk Flow run state (not a
  caller-fabricated event pretending to be validated), so it does **not** require
  `FLOW_AGENTS_ECONOMICS_FIXTURE_MODE`; it is, however, **local-only** — `economics-record.sh` never
  attempts a console relay for a `flow_run_record` producer regardless of
  `FLOW_AGENTS_CONSOLE_ECONOMICS_RELAY`, since that authority level is not (yet) an authenticated
  runtime binding console can trust as a de-duplicable per-run fact. Wiring an authenticated,
  relayable version of this path is #922's broader runtime-binding scope.
- **Top-level `cost.*` preserves `null`, never coalesces to a fabricated `0` (#925 review finding
  3).** Scope honesty: this holds at the EMITTER. At least one downstream aggregate
  (`learning-review-proposals.sh`) still coalesces `null // 0` when consuming `economics.jsonl` —
  tracked in #1225; the never-fabricate property is not yet system-wide. When `tokens_unattributed` is `true` (any phase has `null` tokens — always true today, since
  this mode never auto-merges transcript-derived tokens), every top-level `cost.input_tokens` /
  `output_tokens` / `cache_creation_input_tokens` / `cache_read_input_tokens` /
  `estimated_cost_usd` is **`null`**, not a summed-with-nulls-as-zero `0`. `cost` stays a *required*
  key (present as an object) even when every leaf is `null` — the leaves were widened to allow
  `null` (matching `phases[]`) rather than making the whole `cost` block optional/absent, because
  (a) it keeps the R7 Goodhart guard's "cost and defects are co-required" structurally intact (see
  below), and (b) an existing consumer keeps the same `.cost.input_tokens` access path and only
  needs to add a `null` check — the same pattern `phases[]` already teaches — rather than also
  needing an existence check on `cost` itself. `estimated_cost_usd` is unconditionally `null` in
  this mode regardless of token attribution: pricing is never attempted here (see "What phase A does
  NOT do" below).
- **Unrecognized `status` values are REFUSED, never silently bucketed (#925 review finding 5).** The
  Flow `status` enum has already grown once between an earlier working copy and the pinned
  `@kontourai/flow@3.9.0` dependency (`paused`/`canceled`/`lifecycle`/`gate_outcome_history`/
  `multi_cursor` are all new). A `state.status` value outside the eight known values
  (`active`/`blocked`/`needs_decision`/`paused`/`canceled`/`completed`/`failed`/
  `accepted_by_exception`) makes `deriveFlowRunEconomics` return `{ok:false, reason:"..."}` — no
  record is produced — rather than silently folding an unrecognized future status into
  `active_abandoned`, which would be indistinguishable from a genuinely-observed
  active/blocked/needs_decision/paused run.
- **Active `multi_cursor` concurrent step claims are REFUSED, never silently mis-windowed (#925
  review finding 5 / finding 10).** The installed Flow schema supports durable concurrent step
  claims (`multi_cursor.active_claims`/`claim_history`) for hosts running more than one cursor
  through a run. This tool's single-cursor, one-phase-active-between-any-two-transitions model has
  no awareness of concurrency — if a claim ledger is genuinely non-empty, phase-window derivation
  would silently attribute wrong, overlapping windows. `deriveFlowRunEconomics` refuses
  (`ok:false`) whenever `multi_cursor.active_claims` or `multi_cursor.claim_history` is non-empty.
  Every real run inspected to date carries an empty, inert `multi_cursor` ledger, so this has never
  fired in production; it is a forward guard, not a retrofit for an observed failure.

**Token attribution — `economics-enrich-tokens.mjs` (optional, separate tool).**
`scripts/telemetry/economics-enrich-tokens.mjs --transcript <path> --windows-json <path>` streams a
runtime transcript (JSONL, one `{"type":"assistant","timestamp":...,"message":{"usage":{...}}}` line
per turn — the same shape `scripts/telemetry/lib/usage.sh`'s `usage_parse_transcript` already reads)
with `node:readline` (constant memory regardless of transcript size) and sums each assistant turn's
real `.message.usage` block into whichever phase window (`{phase, start, end}` — the exact
`phase_windows` `flow-run-economics.mjs` already computed from transition timestamps) its
`timestamp` falls inside. Malformed lines are counted (`malformed_lines_skipped`) and skipped, never
fatal. A transcript is **never auto-discovered** — the caller passes `--transcript` explicitly (no
cwd/path/time/"most recent" heuristic — see #922's boundary on heuristic joins). A phase window with
no matching lines, or a missing/unreadable transcript, is absence of a signal and is **never**
reported as a real zero: token fields for phases the slicer could not attribute stay out of its
output entirely, leaving the caller's `null` + `tokens_unattributed:true` in place.

**`isSidechain` (subagent turns) — explicit, disclosed design decision (#925 review finding 6).**
Real transcripts carry an `isSidechain` boolean on every assistant turn (subagent/delegated turns).
`economics-enrich-tokens.mjs` does **not** filter on it — sidechain turns are **included** in phase
sums, matching `/Users/brian/dev/github/kontourai/builder-rebuild/baseline/BASELINE.md`'s Phase-0
burn definition (burn = total token consumption regardless of orchestrator-vs-delegated turn, not an
orchestrator-only subset). The output's `sidechain_usage_lines_included` count discloses how many of
the matched lines were sidechain turns, so a consumer can see the inclusion rather than infer it.
This is a deliberate choice for *this* producer's burn accounting, distinct from — and not a
substitute for — the `delegations[]` per-sub-agent routing facts elsewhere in this record, which
still carry no per-delegation cost (`signals.per_delegation_tokens`).

**What phase A does NOT do (deferred to #922/#925 phase B).** `economics-record.sh`'s
`--flow-run-dir` mode does not itself invoke `economics-enrich-tokens.mjs` or merge its output in —
the two tools are independently runnable and independently tested; gluing them together
automatically (and doing so from the live `Stop` hook, replacing today's session.usage-event path
with a Flow-run-derived one end-to-end) is explicit phase-B follow-up. Phase A also does not bind a
real runtime session identity into this mode's `run_correlation` (it stays `incomplete`), and does
not attempt cost pricing for flow-run-record-mode tokens (`cost.estimated_cost_usd` stays `null` —
see "Top-level `cost.*` preserves `null`" above — not a fabricated `0`).

**Schema additivity is one-directional, not bidirectional (#925 review finding 7).** "Additive on
v0.2" in this contract means: an **old-shape record still validates under the NEW schema** (forward
compatible — a v0.2 consumer reading historical records is unaffected), and old **readers** of the
record stream are unaffected because nothing required was removed or narrowed. It does **not** mean
a **new-shape record** (e.g. `producer_authority: "flow_run_record"`, `phases[].input_tokens: null`)
validates under any schema consumer still pinning the **pre-this-change** `economics-record.schema.json`
— widening an enum or a type is inherently one-directional. This is expected, not a defect;
`evals/integration/test_economics_run_binding.sh` pins the forward-compatible direction as a
regression guard (the pre-existing golden fixture record validates under the new schema). If another
repo (e.g. console) vendors its own copy of this schema file and validates incoming/archived records
against it independently, that copy must be updated to accept `flow_run_record`-mode records before
it starts receiving them — today it cannot, because this producer never reaches the console (see
"local-only" above).

## `delegations[]` — per-sub-agent routing facts + outcome (#415)

When the emitter is given `--agents-dir <slug>/agents`, it assembles one entry per delegated
sub-agent, joined from each `<slug>/agents/<agent-id>/events.jsonl`:

| Field | Type | Source |
| --- | --- | --- |
| `agent_id` | string\|null | the sub-agent id (join key) |
| `role` | string | routing role recorded on the delegation event (`delegate-mechanical`\|`delegate-implementation`\|`delegate-design`\|…) |
| `resolved_model` | string | the model that role resolved to (`.datum/config.json`), e.g. `claude-haiku-4-5@anthropic` |
| `escalated_from` | string | present only when the sub-agent escalated: the lower tier it was promoted from |
| `dispatch_count` | int | how many times the orchestrator (re)dispatched this agent_id (delegation + escalation events); `>1` = re-prompted |
| `outcome` | enum | `accepted`\|`rework`\|`diverged`\|`failed`\|`unavailable` — derived (see below) |

**Assembly rule:** only agent events stamped with the exact parent run-correlation
envelope are eligible. All eligible events for an `agent_id` are grouped; role/model
come from the **latest** `delegation`/`escalation` event (an escalation supersedes and
carries `escalated_from`). Free-text summaries are intentionally excluded from
economics. Any read/parse failure degrades to `[]` — never fatal.

**Outcome — derived only from ORCHESTRATOR-OBSERVABLE signals, never fabricated.** The orchestrator
knows what it dispatched, how often it re-dispatched, and how it corrected — so outcome holds **without
peeking inside the sub-agent** (which most harnesses forbid — see `harness-capability-matrix.md`):

- `diverged` — an explicit supersession marker (`kind:"supersession"` or `status:"diverged"`) exists.
- `rework` — an escalation happened **or** the orchestrator re-dispatched the agent (`dispatch_count > 1`).
- `failed` — the latest terminal verdict event (`kind` `evidence`/`verdict`) is a FAIL.
- `accepted` — the latest terminal verdict is a PASS (and no escalation / re-dispatch / supersession).
- `unavailable` — no terminal verdict was recorded on this harness. **Not assumed `accepted`** — absence
  of a verdict is not evidence of success.

**Per-delegation COST is still not carried here.** Token usage is *sub-agent-internal* and no runtime
isolates it today (`signals.per_delegation_tokens = false`), so a per-delegation cost split would be
fabrication. Cost per `(role, model)` is a **console projection** — join `delegations[]` (role→model)
against `cost.by_model` (1:1 with roles under the current `.datum/config.json`), labeled model-granularity.

## `signals` — harness-capability declaration

Declares what telemetry the emitting runtime actually exposed, so a consumer distinguishes a real zero
from a harness-blind gap (full doctrine + per-runtime matrix in `harness-capability-matrix.md`):

| Field | Meaning |
| --- | --- |
| `runtime` | the runtime that produced the record (`claude-code`, `kiro-cli`, …), from `session.usage .agent.runtime` |
| `per_delegation_tokens` | `true` iff the runtime isolates per-sub-agent tokens. **Derived (not a hardcoded literal, #620)** from the runtime's capability declaration — the emitter reads the build-only `build/generated/capability-declarations.json` (generated from `src/lib/capability-declarations.ts`), keys it on the normalized `.agent.runtime` (`kiro-cli`→`kiro`), and emits `true` iff the declared `per_delegation_tokens` status is `supported`. An unresolved runtime or a missing declaration JSON yields the explicit sentinel `false` — never a fabricated `true`. `false` everywhere today → per-delegation cost unavailable |
| `per_delegation_outcome` | outcome-signal coverage this run: `full`\|`partial`\|`none`\|`n/a` |

Consumers MUST read `signals` before rendering a delegation metric: if the needed signal is unavailable,
show "not measurable on this harness," never a misleading number.

## Correlated sidecar join

The stop-time producer resolves workflow sidecars only from the authenticated
`session.usage.run_correlation` and its accompanying `task_slug`. It obtains a
descriptor-safe snapshot under the actor-bound task directory and accepts state only
when it carries the exact same correlation envelope. Acceptance, critique, and agent
records are read from that same stable directory without following symlinks.

The producer never consults a shared `current.json`, scans for a recent task, or repairs
identity from paths or timestamps. A missing or mismatched binding leaves the economics
record explicitly incomplete and excludes the untrusted sidecars.

Direct `--state`, `--acceptance`, `--critique`, and `--agents-dir` inputs are
available only with `FLOW_AGENTS_ECONOMICS_FIXTURE_MODE=true`. That mode is
local-only and exits before Console relay; structurally valid caller-supplied
correlation is not runtime authentication.

Every local Stop observation is retained for the retrospective compiler. The
runtime seals a cumulative transcript baseline on the first non-terminal hook
observation after a correlation becomes active and subtracts its token, cost, and
elapsed-duration counters at Stop. A missing
baseline leaves the source explicitly session-scoped and local-only. Production
relay requires an authenticated actor binding, a present run baseline, and a
canonical completed, canceled, or failed workflow outcome. It uses the correlation
id as Console's immutable run id, so repeated terminal Stops deduplicate instead of
adding totals.

Workflow outcome is a separate `workflow.outcome` record sourced from the canonical
Builder projection. Its process status can be `completed`, `blocked`, `canceled`,
`failed`, or `not_verified`; its quality status is always
`not_independently_evaluated`. Artifact-derived task status remains an observational
source and cannot replace this runtime outcome. Independent eval attempt and grade
identity is joined externally and is never exposed to Builder or this producer.

## R7 Goodhart guard (structural, hard requirement)

`cost` and `defects` are **co-required** in the JSON Schema
(`"required": ["schema","version","run_id","cost","time","iterations","defects"]`). A record
with `cost` but no `defects` block is **schema-invalid**. This is structural: **no consumer
can render "cheaper" without also rendering "and here is what it caught / missed."** Cost is
only meaningful paired with the defect signal it traded against — the Goodhart pair.

## Phase-sum invariant

The sum over `phases[].input_tokens` (and each other token / cost / wall field) MUST equal
the corresponding top-level `cost` / `time` total. When no phase context exists in
`state.json`, **all** amounts land in a single `{"phase":"unattributed", ...}` entry — never
silently dropped or misattributed. The eval asserts this invariant for both the
phase-known and phase-unknown fixtures.

## Version semantics

`version` is the record-shape version, independent of `pricing_version` (which versions the
cost derivation). A shape change bumps `version`; a pricing change bumps `pricing_version`.
Because the record stream is immutable and tenant-stamped, shape evolution is a
**re-projection** console-side, not a migration of authority.

## Emission (local-first, best-effort)

1. The record is assembled with a **single `jq -c` filter** so every untrusted field
   (`task_slug`, model names, finding text) is `\u`-escaped — JSON is never string-built.
2. The record is written to the local economics log
   (`${TELEMETRY_ECONOMICS_LOG_FILE:-${TELEMETRY_DATA_DIR}/economics.jsonl}`) **first** — the
   fixed, non-doubled path (#469; `TELEMETRY_DATA_DIR` is already the fully-qualified
   `.../.kontourai/telemetry` data dir, so only `economics.jsonl` is appended to it, never a
   second `.kontourai/telemetry/...` suffix on top).
3. Only then is the record best-effort POSTed to `<console>/records` via the shared
   `console_post_json` transport core — detached, fail-open, and gated on
   `FLOW_AGENTS_CONSOLE_ECONOMICS_RELAY` and only when a console endpoint is configured.
4. Every failure path is `exit 0`. The emitter only writes/relays a fact — it never mutates
   a kit, gate, or claim (render-don't-execute).
5. **Unattributed/no-signal suppression** (economics-relay-unattributed-suppression): the local
   write in step 2 is unconditional, but the console POST in step 3 is additionally suppressed —
   the run's fact still lands in the local `economics.jsonl`, it just never reaches the console —
   when the assembled record carries **none** of the following:

   ```
   suppress_relay =
         (task_slug is null/empty/"unattributed")
     AND (cost.estimated_cost_usd == 0)
     AND (no token volume — cost.input_tokens + cost.output_tokens
          + cost.cache_creation_input_tokens + cost.cache_read_input_tokens == 0)
     AND (defects.gate_fires == 0)
     AND (defects.caught_false_completions == 0)
     AND (sum of defects.findings_by_severity.* == 0)
   ```

   Any one of real task attribution, real cost, real token volume, or a real defect/gate signal
   is enough to still relay the record unchanged. The token-volume leg exists because cost
   legitimately degrades to `0` on an unpriced/new model (see `scripts/telemetry/lib/usage.sh`'s
   contract) while the transcript-ground-truth token counts remain a real signal — without this
   leg, a real, unattributed, unpriced-model run with genuine token volume would be
   indistinguishable from a truly-empty run and would be wrongly suppressed, dropping real ROI
   data.

   This guard exists because `telemetry.sh` invokes the emitter on every `session.usage` Stop
   event once usage tracking is on, regardless of whether the run had an active Builder task —
   with no `active_slug`, `task_slug` resolves to `null` (assembled as `state.task_slug // null`;
   it is never the literal string `"unattributed"` as *data* — that literal is only how the
   console *renders* a `null`/empty `task_slug` in its ROI view) and every `defects.*` field sits
   at its zero default, so without this guard every no-task, no-signal run relayed a `null`
   task_slug, `$0`-cost, zero-token, zero-defect record that diluted the console
   `/api/economics` ROI view's `firstPassRate` and cost aggregates. The `!= "unattributed"` leg
   in the predicate is harmless defense-in-depth (in case an upstream caller ever passes that
   literal string), not a claim that the emitter itself produces it. `delegations[]`/`signals.*`
   are deliberately excluded from the predicate — `--agents-dir` is only ever passed alongside
   `--state`, so `delegations` is already `[]` whenever the other terms are at their zero
   defaults.

   **The guard itself fails OPEN toward relaying.** The suppress path only fires when jq
   successfully evaluates the predicate above to an explicit `false` (a genuinely-empty record);
   a jq/read failure (non-zero exit, or any output other than the literal `false`) falls through
   and the record RELAYS unchanged — dropping a real record is worse than an extra empty one
   reaching the console, so a guard failure never silently swallows real data. Set
   `TELEMETRY_ECONOMICS_DEBUG=1` to log a one-line `economics-record: suppressing console relay
   (...)` diagnostic to stderr whenever the guard actually suppresses a POST.

### Enabling the relay (config-driven, opt-out — #469)

The console relay is **on by default once a Console telemetry sink is configured** — it is no
longer env-var-only. `scripts/telemetry/lib/config.sh` resolves
`FLOW_AGENTS_CONSOLE_ECONOMICS_RELAY` as follows:

- An explicit `console_economics_relay` key in a trusted conf (`.kontourai/telemetry-console.conf`
  or `~/.flow-agents/telemetry-console.conf` — mode `600`, owned by the current user; see the
  telemetry-mirror trust gate in `docs/agent-usage-feedback-loop.md`) always wins: truthy
  (`1`/`true`/`yes`/`on`) forces the relay on, falsey (`0`/`false`/`no`/`off`) forces it off.
- Otherwise, once `console_telemetry_url` / `console_telemetry_endpoint_url` resolves (from that
  same trusted conf, or a directly-set env var), the relay **defaults on**.
- A caller-pre-set `FLOW_AGENTS_CONSOLE_ECONOMICS_RELAY` environment variable is left untouched
  and takes priority over the default-on rule (but not over an explicit conf key).
- The optional `console_economics_endpoint_url` conf key (or the
  `FLOW_AGENTS_CONSOLE_ECONOMICS_ENDPOINT_URL` env var) overrides the derived `<console>/records`
  endpoint when it must differ from the telemetry sink's origin.
- To opt out without hand-editing the conf, pass `--no-economics-relay` to
  `install-console-config.sh`, which writes `console_economics_relay=0`.

The raw `FLOW_AGENTS_CONSOLE_ECONOMICS_RELAY` / `FLOW_AGENTS_CONSOLE_ECONOMICS_ENDPOINT_URL` env
vars are still honored directly, for one-off invocations or CI where writing a conf file isn't
worth it — but the conf keys above are the normal path for an installed setup.
