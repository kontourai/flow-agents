# Routing-efficiency review

**Turn recorded delegation outcomes into advisory proposals about which model each role should route
to — the #409 small-model value proof, pointed inward at our own agent fan-out (#415).**

`scripts/telemetry/routing-efficiency.sh` reads the per-run economics records (`delegations[]` +
`outcome`, from `economics-record.sh`) and, per `(role, model)`, asks: *is the model this role routes
to actually efficient, or is a cheaper tier being re-worked so often it should be escalated (or an
expensive tier so reliably accepted it is over-provisioned)?* `learning-review` runs it at closeout
(step 2a) and a human ratifies any change.

## Input / output

```bash
routing-efficiency.sh [economics.jsonl ...]     # defaults to .kontourai/telemetry/economics.jsonl
cat economics.jsonl | routing-efficiency.sh -   # or records on stdin
```

Emits a `kontour.routing-efficiency` v0.1 document: `by_role_model[]` (per-group outcome counts +
`trouble_rate`) and `proposals[]` (one advisory proposal per group), plus `notes`.

## What it computes (honest by construction)

For each `(role, bare-model)` group across all delegations:

- `measurable = accepted + rework + diverged + failed` — **`unavailable` outcomes are excluded**. A
  delegation whose outcome the harness could not expose is neither a success nor a failure, so it never
  moves a rate (see `harness-capability-matrix.md`). It is counted separately as coverage.
- `trouble_rate = (rework + diverged + failed) / measurable` — the share of *measurable* delegations
  that did not cleanly accept.

## Proposal kinds

| Kind | Fires when | Meaning |
| --- | --- | --- |
| `escalate-minimum-tier` | `measurable ≥ ROUTING_MIN_SAMPLE` and `trouble_rate ≥ ROUTING_HIGH_TROUBLE` (0.5) | the cheap tier is under-routed for this role — consider raising its minimum tier |
| `keep-tier` | `measurable ≥ min` and `trouble_rate ≤ ROUTING_LOW_TROUBLE` (0.1) | efficient — accepts cleanly; keep current routing (a candidate to try a *cheaper* tier lives in future work) |
| `monitor` | `measurable ≥ min`, trouble in between | within tolerance; watch |
| `insufficient-signal` | `measurable < min` | not enough measurable outcomes to judge — coverage reported, no confident call |

Thresholds are tunable via env: `ROUTING_MIN_SAMPLE` (default 3), `ROUTING_HIGH_TROUBLE` (0.5),
`ROUTING_LOW_TROUBLE` (0.1).

## Guardrails (ADR 0002 / ADR 0003 call 5)

- **Advisory only.** Every proposal is `severity: "advisory"`. The analyzer NEVER edits
  `.datum/config.json` or any routing config — it only reads and reports.
- **Human-ratified.** A person decides whether to act on a proposal; the resulting role→model change
  travels the normal deliver loop, never an auto-apply.
- **No fabrication.** `unavailable` outcomes are excluded from rates; a thin sample yields
  `insufficient-signal`, not a confident verdict; empty input yields an empty `proposals[]`, never an
  invented lesson.

## Relationship to the value plane

This is the same question the external value proof (`kontourai/evals`, #409) asks — "does routing the
right model to each task pay off?" — asked of our *internal* delegation. The console renders the
`(role, model)` cost + acceptance surface (#415 console panel); this analyzer produces the actionable
proposal that closes the loop back to the routing ladder.
