# Grounded narrative evals corpus (#612)

A versioned, frozen-manifest-grounded adversarial fixture corpus and its scorer
for the narrative faithfulness program. This directory is the shared, externally
consumable package for the human-study and cross-presentation work in
kontourai/evals#95: the corpus + result schema are self-describing and can be
ingested unmodified.

## Package contract

- `corpus.json` (`schema_version: "narrative-evals-corpus/v1"`) enumerates every
  fixture: its `id`, its `case_class` (one of the ten R1 classes), a declarative
  `build` recipe (seeded source records materialized through the public
  `snapshotNarrative` API into a frozen manifest — never a hand-fabricated
  manifest), and a typed `expected` answer key (`verdict` of `accept` / `reject`
  / `known_gap`, plus `material_claims`, `epistemic_labels`, and citation
  resolvability). Corruption fixtures additionally carry a `corruption` block and
  the named `check` their defect must trip. The serialization references only
  seeded records and fa1 source IDs, never internal flow-agents APIs.
- `schemas/narrative-eval-result.schema.json` (`schema_version:
  "narrative-eval-result/v1"`, at the repo root) is the consolidated result
  contract: per-fixture verdicts, aggregate faithfulness metrics
  (unsupported-claim rate, citation precision/recall/resolvability, material-claim
  coverage, per-class omission rate, epistemic-classification accuracy), an
  `uncertainty` block (every metric carries a sample count + range), the DECLARED
  cross-runtime `capability_parity` block, documented `known_gaps`, and per-fixture
  `raw_source_links` for audit. `validateNarrativeEvalResult` (exported from the
  package root) is the ajv-free validator.
- `scorer.mjs` is the hermetic scorer. `node scorer.mjs all` replays the whole
  corpus and emits one schema-valid `narrative-eval-result/v1` object (write it to
  a file with `NARRATIVE_EVAL_RESULT_OUT=<path>`); per-check modes
  (`support` / `citation` / `coverage` / `epistemic` / `injection`) drive the
  mutation battery. It imports only the BUILT modules under `build/`, so run
  `npm run build` first.

## Case classes and detection

The ten R1 case classes (`passing`, `failing`, `ambiguous`, `contradictory`,
`redacted`, `nested-agent`, `timeout`, `no-op`, `created-file`,
`prompt-injection`) are honest narratives scored `accept`, except the
`contradictory` case which is disclosed as a documented `known_gap`
(contradiction detection is an upstream gap, sequenced #568/#425 — it is never
faked as real detection). Five R3 corruption fixtures (hallucinated statement,
omitted failure, dangling citation, mislabeled inference, injection-followed
prose) each carry one deliberate defect the scorer must detect (`reject`). Every
corruption class is the teeth-proving mutation target for its `/* eval-check:<name> */`
anchor: `evals/integration/test_narrative_evals.sh` disables each detection in
turn and proves the matching fixture flips `expected=reject -> actual=accept`,
then restores the scorer byte-for-byte.

Results are per-corpus MEASUREMENTS, not proofs: no metric is asserted from a
single fixture, model, or runtime, and capability gaps are asserted from the
#620 declarations (`queryCapability`), never probed from behavior.

## Running

```sh
npm run build
node evals/fixtures/narrative-evals/scorer.mjs all
# or the full gate (corpus + schema validation + mutation battery):
bash evals/integration/test_narrative_evals.sh
```
