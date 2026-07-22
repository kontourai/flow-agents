# Reviewed grounding reference workflow

This deterministic reference composes Traverse 0.19.1, Survey 1.19.0, Lookout
0.3.2, and Surface 2.13.0 through their public contracts. Those packages are
exact, dev-only dependencies; the Flow Agents runtime dependency boundary is
unchanged.

Run without credentials:

```bash
node evals/reference/reviewed-grounding-workflow/run.mjs
```

Or use the package script:

```bash
npm run reference:reviewed-grounding
```

It acquires a fictional public record, replays an unchanged snapshot without a
provider call, extracts a changed snapshot with exact provenance, routes the
semantic transition into review, projects reviewed evidence, and refuses
publication until the grounding policy is satisfied. It also exercises typed
missing-evidence, prepared-content tamper, and source-drift failures.

Optional live mode loads a provider adapter and observes one extraction. Keep
credentials in the provider's normal environment; the workflow records no
prompt, source body, credential, or provider-native response:

```bash
node evals/reference/reviewed-grounding-workflow/run.mjs \
  --live-provider-module /absolute/path/to/provider.mjs
```

The module must default-export (or export as `provider`) a Traverse extraction
provider. The observed record contains `provider`, `model`, `taskDigest`,
`usageTokens`, `latencyMs`, and `fixtureRevision` bound to that execution.
