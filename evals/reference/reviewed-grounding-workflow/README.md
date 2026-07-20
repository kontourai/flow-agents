# Reviewed grounding reference workflow

This deterministic reference composes Traverse 0.19.0, Survey 1.18.0, Lookout
0.3.2, and Surface 2.13.0 through their public contracts. Those packages are
exact, dev-only dependencies; the Flow Agents runtime dependency boundary is
unchanged.

Run without credentials:

```bash
node evals/reference/reviewed-grounding-workflow/run.mjs
```

It acquires a fictional public record, replays an unchanged snapshot without a
provider call, extracts a changed snapshot with exact provenance, routes the
semantic transition into review, projects reviewed evidence, and refuses
publication until the grounding policy is satisfied. It also exercises typed
missing-evidence, prepared-content tamper, and source-drift failures.

Optional live-mode telemetry is input, never a credential:

```bash
node evals/reference/reviewed-grounding-workflow/run.mjs --live-telemetry telemetry.json
```

The record must include `provider`, `model`, `taskDigest`, `usageTokens`,
`latencyMs`, and `fixtureRevision`. Do not include prompts, source bodies,
credentials, or provider-native responses.
