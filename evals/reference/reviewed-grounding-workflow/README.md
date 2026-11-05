# Reviewed grounding reference workflow

This deterministic reference composes Forage 1.0.2, Traverse 5.0.3, Survey
8.4.0, Lookout 0.8.9, and Surface 5.0.0 through their public contracts. The
returned revision record and integration test bind these manifest pins.
Forage, Traverse, and Lookout are exact development dependencies; Survey and
Surface use the existing runtime pins. The fixture adds no runtime dependency.

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

Acquisition persists deterministic captures in Forage's in-memory snapshot
store. Both extraction and Lookout's unchanged comparison resolve the actual
capture references there. The recorder retains only the last reference that
Lookout's `extractedSnapshotRef` reports as handled. A later changed capture
can retain the reviewed field's value while invalidating source currentness.

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
