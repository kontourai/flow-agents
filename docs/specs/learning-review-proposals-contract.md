# `kontour.learning-review-proposals` — kit/gate tuning proposal contract (v0.1)

**Status:** ratified (flow-agents #352). **Kind:** `kontour.learning-review-proposals`.
**Version:** `0.1`.

## Purpose

Turn already-accumulated `kontour.console.economics` records (fa#349) into **advisory,
evidence-cited** kit/gate tuning proposals — the same "turn recorded outcomes into a proposal
a human ratifies" shape as `routing-efficiency.sh` (#415), generalized from per-`(role,model)`
to **per-kit** and **per-gate**. `scripts/telemetry/learning-review-proposals.sh` reads a
window of `economics.jsonl`, joins each record's kit/gate identity from already-shipped
sidecar shapes, computes aggregates, and emits proposals into a durable, idempotent ledger. A
companion script, `scripts/telemetry/learning-review-decide.sh`, records the human
ratify/reject/defer decision against a proposal id. Nothing here is ever auto-applied:
`learning-review` step 2b (see `kits/builder/skills/learning-review/SKILL.md`) surfaces the
output for review; a human decides.

This is a pure **consumer**: it makes zero edits to `economics-record.sh`,
`economics-record.schema.json`, or `gate-review`'s `InquiryRecord` output (ADR 0008/0010
consume-never-fork). It never writes to `kits/**`, `.datum/config.json`, or any gate/flow
config file.

## Invocation

```bash
scripts/telemetry/learning-review-proposals.sh [economics.jsonl ...]      # defaults to the local economics log
cat economics.jsonl | scripts/telemetry/learning-review-proposals.sh -    # records on stdin
scripts/telemetry/learning-review-proposals.sh --since 2026-07-01 --until 2026-07-07 \
  --sessions-root .kontourai/flow-agents --ledger .kontourai/telemetry/learning-review-proposals.jsonl
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--since VAL` | unbounded | date-only (`2026-07-01`), full ISO-8601 with `Z` (`2026-07-01T00:00:00Z`), full ISO-8601 with a `+00:00` UTC offset, or epoch-ms; lower bound on each record's `.at` |
| `--until VAL` | unbounded | same accepted formats; upper bound on each record's `.at` |
| `--sessions-root DIR` | `.kontourai/flow-agents` | where per-session `<task_slug>/trust.bundle` and `<task_slug>/gate-review.inquiries.json` are looked up for the kit/gate join |
| `--ledger PATH` | `.kontourai/telemetry/learning-review-proposals.jsonl` (override via `LEARNING_REVIEW_PROPOSALS_LEDGER` env, mirrors `TELEMETRY_ECONOMICS_LOG_FILE`) | the durable, idempotent proposal ledger |
| `-h`/`--help` | — | usage |

Positional args and stdin follow the exact `routing-efficiency.sh` convention: explicit file
args (a bare `-` means stdin), else stdin when piped, else the default log
(`${TELEMETRY_ECONOMICS_LOG_FILE:-${TELEMETRY_DATA_DIR:-<repo>}/.kontourai/telemetry/economics.jsonl}`).

**Accepted timestamp formats** (for `--since`/`--until` AND every record's own `.at`): an
epoch-ms integer (as a JSON number or a digit-only string); a date-only string (`YYYY-MM-DD`,
normalized to midnight UTC); a full ISO-8601 string with a literal `Z` UTC suffix; or a full
ISO-8601 string with an explicit `+00:00` UTC offset (converted internally to `Z` before
parsing — jq's `fromdateiso8601` only understands the `Z` form). Fractional seconds are
accepted and stripped before parsing (e.g. `2026-07-01T00:00:00.123Z`, the default shape of a
JS `Date.toISOString()` value) — precision finer than one second is not retained. Arbitrary
non-UTC offsets are not supported. A `--since`/`--until` value in none of these forms is a
CLI usage error: the analyzer exits non-zero with a stderr diagnostic and writes nothing,
never a fabricated `"insufficient-data"` result (an unrecognized CLI argument is operator-
correctable input, not a data gap). A record's own `.at` field, by contrast, degrades to an
unbounded (`null`) timestamp on an unrecognized value — the same honest-degradation treatment
as an absent `.at` — so one malformed record never aborts analysis of an otherwise-good window.

Tunables (env, all optional): `LR_MIN_WINDOW_SAMPLE` (5), `LR_MIN_KIT_SAMPLE` (6),
`LR_MIN_GATE_SAMPLE` (3), `LR_COST_RISE_PCT` (25), `LR_FLAT_FINDINGS_PCT` (10),
`LR_GATE_FALSE_BLOCK_RATE` (0.5), `LR_GATE_WELL_CALIBRATED_RATE` (0.9).

## Output document shape

```json
{
  "schema": "kontour.learning-review-proposals",
  "version": "0.1",
  "window": { "since": "<epoch-ms|null>", "until": "<epoch-ms|null>" },
  "records_considered": 0,
  "outcome": "ok | insufficient-data",
  "aggregates": {
    "by_kit": [ { "kit_id": "...", "runs": 0, "...": "..." } ],
    "by_gate": [ { "gate_id": "...", "fire_count": 0, "...": "..." } ],
    "partial": false
  },
  "proposals": [
    {
      "proposal_id": "...",
      "target": { "kind": "kit|gate", "id": "..." },
      "pattern": "kit-review-cost-inflation | gate-false-block-review | gate-well-calibrated",
      "proposed_change": "<human-readable recommendation>",
      "severity": "advisory",
      "evidence": { "cost": { "...": "..." }, "defect": { "...": "..." } },
      "expected_effect": { "metric": "...", "direction": "decrease|increase|maintain", "description": "..." },
      "decision": { "status": "proposed|ratified|rejected|deferred", "decided_by": null, "decided_at": null, "rationale": null },
      "follow_on_ref": null,
      "effect_observed": null,
      "already_proposed": false
    }
  ],
  "notes": [ "..." ]
}
```

`window.since`/`window.until` in the OUTPUT document are the run's **effective** bounds:
the `--since`/`--until` arg when given, else respectively the min/max `.at` (epoch-ms,
normalized) actually observed among the records considered (or `null` when no records at
all). This makes the effect-fill chronological comparison (below) well-defined even when a
run is invoked with unbounded `--since`/`--until`.

`already_proposed` is an OUTPUT-ONLY annotation (not stored on the ledger line itself): `true`
when a proposal with the same `proposal_id` already exists in the ledger from a prior run (no
duplicate line is appended); `false` when this run appended a brand-new ledger line for it.

## Kit/gate identity join (honest, reuses already-shipped shapes — no new field on fa#349's record)

For each economics record with a non-null `task_slug`, the analyzer looks for
`<sessions-root>/<task_slug>/trust.bundle` and `<sessions-root>/<task_slug>/gate-review.inquiries.json`
(both already-shipped, read-only inputs — never invoked, never modified):

- **`kit_id`** = the mode (most frequent) of `[.claims[].claimType | split(".")[0]]` from that
  session's `trust.bundle` (the real Kit Catalog namespace, e.g. `builder`,
  `veritas-governance` — `kits/<name>/` on disk). If the `trust.bundle` is absent, empty, or
  unreadable, `kit_id` degrades to `"unattributed"` — the same honest-degradation idiom
  `economics-record.sh` already uses for `phases[].phase`.
- **Per-gate rows** for that record = one row per `gate-review.inquiries.json` `InquiryRecord`:
  `{ gate_id: .inquiry.target.fieldOrBehavior, outcome: .answer.value.calibration, fired: .answer.value.gateFired }`.
  If the file is absent, empty, or unreadable, this record contributes zero gate rows (counted
  separately in `notes` as "sessions without a gate-review join").
- A record with a **null** `task_slug` (or a `task_slug` with no matching session directory)
  gets `kit_id = "unattributed"` directly, with zero gate rows contributed — no lookup is
  attempted.

**Honest current-data gap (stated, not hidden):** real `economics.jsonl` records emitted today
all carry `"task_slug":null` (fa#349 slice-1; `task_slug` plumbing was never wired end-to-end
for the emitter's live invocation path). Until that separate, out-of-scope plumbing gap is
fixed, every real run's `kit_id` degrades to `"unattributed"` and it contributes zero gate
rows — per-kit/per-gate attribution is genuinely vacuous on live data today. This analyzer does
not fabricate an identity to paper over that gap; fixtures (not live data) are what exercise
the attributed path until `task_slug` is populated on real runs.

**Trusted-as-is inputs (consume-never-fork):** `cost.estimated_cost_usd` and every other numeric
field read from an `economics.jsonl` record is trusted exactly as fa#349 emitted it, including a
negative or zero value — this analyzer never clamps, floors, or re-derives it; a negative/zero
cost simply flows through the same average/percentage formulas as any other value (and can
legitimately produce a negative `cost_trend_pct`, which is not an error).

## Window and aggregates (exact formulas)

All derived floating-point values (rates, percentages, dollar/second averages) are rounded to
**4 decimal places** using `(<value> * 10000 | round) / 10000` — the same rounding idiom
`routing-efficiency.sh` uses for `trouble_rate` (scaled to 4 places here instead of 3, for
dollar-amount precision). Any ratio with a zero or otherwise undefined denominator is `null`,
never a fabricated `0` or `Infinity`.

### `by_kit[]`

Records are grouped by `kit_id`. Within a group, records are sorted ascending by `.at` and
split into a first half (oldest) and a second half (newest): `half_point = floor(runs / 2)`;
the first `half_point` records are the "first half," the remaining `runs - half_point` records
(the odd one out, if `runs` is odd, lands in the newer half) are the "second half."

| Field | Formula |
| --- | --- |
| `kit_id` | group key |
| `runs` | count of records in the group |
| `first_half_avg_cost_usd` | mean of `.cost.estimated_cost_usd` over the first half (`null` if the first half is empty) |
| `second_half_avg_cost_usd` | mean of `.cost.estimated_cost_usd` over the second half |
| `cost_trend_pct` | `((second_half_avg_cost_usd - first_half_avg_cost_usd) / first_half_avg_cost_usd) * 100`; `null` if `first_half_avg_cost_usd` is `null` or `0` |
| `first_half_findings_total` | sum of `.defects.findings_by_severity.{critical,high,medium,low}` over the first half |
| `second_half_findings_total` | same, over the second half |
| `findings_delta_pct` | `((second_half_findings_total - first_half_findings_total) / first_half_findings_total) * 100`; if `first_half_findings_total == 0`: `0` when `second_half_findings_total == 0` too, else `null` (a rise from a zero base has no defined percentage) |
| `avg_wall_clock_s` | mean of `.time.wall_clock_s` over ALL records in the group (not half-split) |
| `avg_human_wait_s` | mean of `.time.human_wait_s` over ALL records in the group |
| `route_back_rate` | `sum(.iterations.route_backs) / sum(.iterations.count)` over ALL records in the group; `null` if the count sum is `0` |
| `caught_false_completions_total` | sum of `.defects.caught_false_completions` over ALL records in the group |

### `by_gate[]`

Gate rows from every considered record's join (above) are flattened and grouped by `gate_id`.

| Field | Formula |
| --- | --- |
| `gate_id` | group key (`inquiry.target.fieldOrBehavior`) |
| `fire_count` | total gate rows for this `gate_id` (every calibration: `correct` + `false_block` + `missed_block`) |
| `correct_count` | rows with `outcome == "correct"` |
| `false_block_count` | rows with `outcome == "false_block"` |
| `missed_block_count` | rows with `outcome == "missed_block"` |
| `false_block_rate` | `false_block_count / fire_count` |
| `avg_wall_clock_s_when_fired` | mean of the PARENT economics record's `.time.wall_clock_s`, over the distinct records that contributed at least one row for this `gate_id` with `fired == true` |
| `avg_human_wait_s_when_fired` | same, for `.time.human_wait_s` |

(`InquiryRecord`s themselves carry no wall-clock time; "when fired" averages borrow the
parent record's own time fields for exactly the records whose gate-review join produced a
`fired:true` row for that `gate_id`.)

## Whole-window insufficient-data gate (AC4)

`records_considered` = the count of `kontour.console.economics` records whose `.at` falls in
`[since, until]` (both inclusive; unbounded when the flag is omitted). If
`records_considered < LR_MIN_WINDOW_SAMPLE` (default `5`): top-level `outcome` is
`"insufficient-data"`, `proposals` is `[]`, and `aggregates.partial` is `true` — but
`aggregates.by_kit`/`by_gate` are STILL computed and returned, for transparency (never hidden,
per `harness-capability-matrix.md`'s "degrade to an explicit unavailable, never fabricate").
This whole-window gate is distinct from, and evaluated in addition to, the per-target sample
gates (`LR_MIN_KIT_SAMPLE`/`LR_MIN_GATE_SAMPLE`) below, which just silently exclude a single
under-sampled target from proposal consideration without flipping the top-level `outcome`.

## Proposal rules (Goodhart-paired: `evidence.cost` + `evidence.defect` always co-required)

Only evaluated when `outcome == "ok"` (i.e. the whole-window gate passed).

1. **`kit-review-cost-inflation`** — fires when, for a `by_kit[]` entry: `runs >= LR_MIN_KIT_SAMPLE`
   (default `6`) AND `cost_trend_pct >= LR_COST_RISE_PCT` (default `25`) AND
   `findings_delta_pct <= LR_FLAT_FINDINGS_PCT` (default `10`) — cost is rising while defects
   caught are flat or falling (the pattern a Goodhart-blind cost-only metric would miss).
   - `evidence.cost = { first_half_avg_cost_usd, second_half_avg_cost_usd, cost_trend_pct }`
   - `evidence.defect = { first_half_findings_total, second_half_findings_total, findings_delta_pct, caught_false_completions_total }`
   - `expected_effect = { metric: "avg_cost_usd", direction: "decrease", description: "cost should come back down without a corresponding rise in escaped defects" }`
2. **`gate-false-block-review`** — fires when, for a `by_gate[]` entry:
   `fire_count >= LR_MIN_GATE_SAMPLE` (default `3`) AND `false_block_rate >= LR_GATE_FALSE_BLOCK_RATE`
   (default `0.5`) — the gate is blocking on already-passing claims more often than not.
   - `evidence.cost = { avg_wall_clock_s_when_fired, avg_human_wait_s_when_fired }`
   - `evidence.defect = { fire_count, correct_count, false_block_count, missed_block_count }`
   - `expected_effect = { metric: "false_block_rate", direction: "decrease", description: "false_block_rate should fall toward correctly-calibrated blocking" }`
3. **`gate-well-calibrated`** (monitor-style, still `severity:"advisory"` — mirrors
   `routing-efficiency.sh`'s `keep-tier`) — fires when `fire_count >= LR_MIN_GATE_SAMPLE` AND
   `(correct_count / fire_count) >= LR_GATE_WELL_CALIBRATED_RATE` (default `0.9`) AND
   `false_block_count == 0` AND `missed_block_count == 0`.
   - `evidence.cost = { avg_wall_clock_s_when_fired, avg_human_wait_s_when_fired }`
   - `evidence.defect = { fire_count, correct_count, false_block_count, missed_block_count }`
   - `expected_effect = { metric: "false_block_rate", direction: "maintain", description: "gate is well-calibrated; no change expected or needed" }`

A `by_kit`/`by_gate` entry under its rule's sample-size gate contributes **no proposal at
all** for that rule (silently excluded from proposals, still visible in `aggregates`).

Every proposal's `evidence` object structurally REQUIRES both `cost` and `defect`
(`learning-review-proposals.schema.json`, mirroring fa#349's own `cost`+`defects`
co-requirement, R7) — a proposal citing cost alone (or defect alone) is schema-invalid. This
is the Goodhart guard: no proposal may claim "cheaper" without also showing "and here is what
it caught or missed."

## Idempotent ledger (`.kontourai/telemetry/learning-review-proposals.jsonl`)

Durable, append-mostly JSONL — one proposal per line, in the exact shape above (minus the
output-only `already_proposed` field). Default path
`.kontourai/telemetry/learning-review-proposals.jsonl`, override via `--ledger PATH` or
`LEARNING_REVIEW_PROPOSALS_LEDGER` (mirrors `TELEMETRY_ECONOMICS_LOG_FILE`'s local-first
convention: the per-run snapshot lives in the session artifact dir; this ledger is the durable,
cross-session trail).

- **`proposal_id`** = `slugify("<since>_<until>_<target_kind>-<target_id>_<pattern>")`, where
  `<since>`/`<until>` are the raw `--since`/`--until` argument strings (or the literal `all`
  when the flag was omitted) and `slugify()` is the SAME idiom already used at
  `evals/ci/run-baseline.sh:139-140`:
  `tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-//; s/-$//'` — no external hash
  dependency.
- On every run: proposals are computed fresh (stateless — the analyzer never reads its own
  ledger to decide WHAT to propose, only to decide whether a computed proposal is new). For
  each computed proposal, the ledger is checked for an existing line with the same
  `proposal_id`:
  - **Found** → mark `already_proposed:true` in this run's OUTPUT; no duplicate line is
    appended.
  - **Not found** → append a new ledger line with
    `decision:{status:"proposed",decided_by:null,decided_at:null,rationale:null}`,
    `follow_on_ref:null`, `effect_observed:null`, and mark `already_proposed:false` in the
    output.
- Running the analyzer twice over the identical window therefore produces zero duplicate
  `proposal_id`s in the ledger (AC4) — the second run's output marks every proposal
  `already_proposed:true`.

## Decision recording (`learning-review-decide.sh`)

```bash
scripts/telemetry/learning-review-decide.sh <ledger-path> <proposal-id> \
  --ratify|--reject|--defer --decided-by NAME [--rationale TEXT] [--follow-on-ref REF]
```

Finds the ledger line with the matching `proposal_id` and rewrites its `decision` object
(`status`, `decided_by`, `decided_at: <now, ISO-8601>`, `rationale`) in place, atomically
(temp file + `mv`). `follow_on_ref` is set ONLY when `--ratify` and `--follow-on-ref` are both
present. Exits non-zero, writing nothing, when: the `proposal_id` is not found; more than one
of `--ratify`/`--reject`/`--defer` is passed; or `--follow-on-ref` is passed without `--ratify`
(the AC3 ratify-before-follow-on ordering guard — a follow-on work item can never be linked to
an unratified proposal). All other ledger lines are left byte-identical.

## Effect-fill pass (AC5)

On every `learning-review-proposals.sh` invocation, AFTER computing and ledgering the current
window's proposals: scan the ledger for entries where `decision.status == "ratified"` AND
`effect_observed == null` AND the entry's `window.until` (epoch-ms) is chronologically before
the CURRENT invocation's effective `window.since` (epoch-ms) — i.e. the ratified proposal's
own window has fully elapsed before this new window begins. For each match, recompute the
metric named in that entry's `expected_effect.metric` over the CURRENT window's aggregates,
for the exact same `target`:

- `target.kind == "kit"` → `after` = the current window's `by_kit[]` entry for that `kit_id`'s
  overall average cost (`second_half_avg_cost_usd`, i.e. the newest-half average of the new
  window — comparable apples-to-apples against the value that triggered the original
  proposal); `before` = the ratified proposal's own `evidence.cost.second_half_avg_cost_usd`
  (the elevated level that triggered it).
- `target.kind == "gate"` → `after` = the current window's `by_gate[]` entry's
  `false_block_rate` for that `gate_id`; `before` = the ratified proposal's own
  `evidence.defect.false_block_count / evidence.defect.fire_count`.

If no `by_kit`/`by_gate` entry exists for that target in the current window (e.g. the kit/gate
had zero runs this window), `effect_observed` is left `null` this pass — an honest gap, not a
fabricated measurement; it is retried on the next invocation that does have data.

Writes:

```json
"effect_observed": {
  "measured_at": "<ISO-8601, now>",
  "metric": "avg_cost_usd | false_block_rate",
  "before": 0.0,
  "after": 0.0,
  "moved": "improved | worsened | unchanged"
}
```

`moved` is derived from `expected_effect.direction`: `"improved"` = the metric moved in the
direction the proposal intended (`decrease` → `after < before`; `increase` → `after > before`);
`"unchanged"` = `after == before` exactly; `"worsened"` = moved, but the wrong way (or any
non-zero move when `direction == "maintain"`).

## Guardrails (ADR 0008/0010, ADR 0002/0003 call 5)

- **Advisory only.** Every proposal is `severity: "advisory"`. Neither
  `learning-review-proposals.sh` nor `learning-review-decide.sh` EVER writes to `kits/**`,
  `.datum/config.json`, or any gate/flow config file — they only read economics/session
  artifacts and write to their own ledger.
- **Human-ratified, decision-before-follow-on.** A recorded human decision
  (`learning-review-decide.sh`) is required before any follow-on work item may cite a
  proposal; `--follow-on-ref` is refused without `--ratify` (AC3).
- **Consume-never-fork.** `economics-record.schema.json` (fa#349) and
  `gate-review.inquiries.json` (#118-120) are read-only inputs, never modified, never
  re-derived by inventing a parallel schema.
- **No fabrication.** Ratios with an undefined denominator are `null`, never `0`; an
  under-threshold window yields an explicit `"insufficient-data"` outcome, never a confident
  but thin call; real records lacking `task_slug` degrade to `"unattributed"`, never an
  invented kit identity.

## Relationship to `routing-efficiency.sh` (#415)

Same architecture, same input stream (`economics.jsonl`), same guardrails — generalized from
per-`(role,model)` delegation efficiency to per-kit/per-gate review efficiency. Both are purely
manual/skill-invoked (no scheduler/cron primitive exists in this repo for either); both are
wired into `learning-review`'s closeout step (2a for routing, 2b for this contract).
