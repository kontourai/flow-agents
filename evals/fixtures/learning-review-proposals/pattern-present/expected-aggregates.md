# `pattern-present` — hand-computed aggregate arithmetic (AC1)

Six `kontour.console.economics` records in `economics.jsonl`, ordered ascending by `.at`
(`pp-r1` .. `pp-r6`), all joined (via `sessions/<task_slug>/trust.bundle`, one `builder.verify.tests`
claim each) to `kit_id = "builder"`. Four of the six sessions (`task-lr-pp-1..4`) also carry a
`gate-review.inquiries.json` with one `InquiryRecord` each for gate `"unit tests pass"`; the
remaining two (`task-lr-pp-5`, `task-lr-pp-6`) have no gate-review join (counted in `notes`).

Raw per-record inputs (identical across records except `cost` and — for the first four — the
gate calibration):

| run_id | at | cost.estimated_cost_usd | findings (high+low) | time.wall_clock_s | time.human_wait_s | iterations.count | iterations.route_backs | defects.caught_false_completions | gate calibration |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| pp-r1 | 1751500000000 | 0.10 | 1+1=2 | 100 | 10 | 2 | 1 | 1 | correct |
| pp-r2 | 1751500001000 | 0.10 | 1+1=2 | 100 | 10 | 2 | 1 | 1 | false_block |
| pp-r3 | 1751500002000 | 0.10 | 1+1=2 | 100 | 10 | 2 | 1 | 1 | false_block |
| pp-r4 | 1751500003000 | 0.20 | 1+1=2 | 100 | 10 | 2 | 1 | 1 | false_block |
| pp-r5 | 1751500004000 | 0.20 | 1+1=2 | 100 | 10 | 2 | 1 | 1 | (no gate join) |
| pp-r6 | 1751500005000 | 0.20 | 1+1=2 | 100 | 10 | 2 | 1 | 1 | (no gate join) |

## `by_kit[]` — `kit_id: "builder"` (runs = 6)

`half_point = floor(6 / 2) = 3` → first half = {pp-r1, pp-r2, pp-r3} (oldest 3 by `.at`), second
half = {pp-r4, pp-r5, pp-r6} (newest 3).

- `first_half_avg_cost_usd` = (0.10 + 0.10 + 0.10) / 3 = **0.10**
- `second_half_avg_cost_usd` = (0.20 + 0.20 + 0.20) / 3 = **0.20**
- `cost_trend_pct` = ((0.20 − 0.10) / 0.10) × 100 = **100** ( ≥ `LR_COST_RISE_PCT` default 25 )
- `first_half_findings_total` = 2 + 2 + 2 = **6**
- `second_half_findings_total` = 2 + 2 + 2 = **6**
- `findings_delta_pct` = first half is non-zero (6), so `((6 − 6) / 6) × 100` = **0** ( ≤
  `LR_FLAT_FINDINGS_PCT` default 10 — flat, not rising )
- `avg_wall_clock_s` = (100 × 6) / 6 = **100** (all six records, not half-split)
- `avg_human_wait_s` = (10 × 6) / 6 = **10**
- `route_back_rate` = sum(route_backs) / sum(count) = (1×6) / (2×6) = 6 / 12 = **0.5**
- `caught_false_completions_total` = 1 × 6 = **6**

`runs (6) >= LR_MIN_KIT_SAMPLE (6)` AND `cost_trend_pct (100) >= LR_COST_RISE_PCT (25)` AND
`findings_delta_pct (0) <= LR_FLAT_FINDINGS_PCT (10)` → **`kit-review-cost-inflation` fires** for
`{kind:"kit", id:"builder"}` (AC2).

## `by_gate[]` — `gate_id: "unit tests pass"` (fire_count = 4)

Gate rows come only from `task-lr-pp-1..4`'s `gate-review.inquiries.json` (one row each);
`task-lr-pp-5`/`-6` contribute none (2 sessions without a gate-review join, per `notes`).

- `fire_count` = 4 (pp-r1 correct, pp-r2/pp-r3/pp-r4 false_block)
- `correct_count` = 1 (pp-r1)
- `false_block_count` = 3 (pp-r2, pp-r3, pp-r4)
- `missed_block_count` = 0
- `false_block_rate` = 3 / 4 = **0.75** ( ≥ `LR_GATE_FALSE_BLOCK_RATE` default 0.5 )
- `avg_wall_clock_s_when_fired` = mean of the parent record's `time.wall_clock_s` over the 4
  distinct records with a `fired:true` row for this gate (pp-r1..pp-r4, all 100) = **100**
- `avg_human_wait_s_when_fired` = same, `time.human_wait_s` (all 10) = **10**

`fire_count (4) >= LR_MIN_GATE_SAMPLE (3)` AND `false_block_rate (0.75) >= LR_GATE_FALSE_BLOCK_RATE
(0.5)` → **`gate-false-block-review` fires** for `{kind:"gate", id:"unit tests pass"}` (AC2).
`gate-well-calibrated` does NOT fire (`false_block_count` is 3, not 0).

These are the exact numbers asserted (4-decimal-rounded per the contract's `round4`, though every
value here is already exact at 0–2 decimal places) in
`evals/integration/test_learning_review_proposals.sh` and recorded verbatim in
`expected-aggregates.json` — computed from the formulas in
`docs/specs/learning-review-proposals-contract.md`, independently of running
`scripts/telemetry/learning-review-proposals.sh` (then cross-checked against the script's actual
output as a confirmation, not a derivation).
