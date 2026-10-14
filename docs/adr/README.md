---
title: ADR Directory (Frozen)
---

# Architecture Decision Records — FROZEN

**This whole directory is frozen immutable history.** Every file in it is
frozen: the numbered ADRs 0001–0023, including both files numbered 0007 and
ADR 0023, which was added after the freeze, plus this README and
[`index.md`](./index.md). Do not add files here and do not change the decisions
they record. The numbers stay as they are; nothing is renumbered. The numbered
ADRs are preserved as provenance for the decisions that shaped Flow Agents;
their subjects are carried forward in the topic-keyed decision registry
(ADR 0023 has no registry record yet).

`corpus.json` declares this directory as `decisions.adr.dir`, so Corpus's
adr-freeze gate (`npm run check:decisions`, in the required CI lane) refuses
any file added under `docs/adr/` since the pull request base, including a
rename. See [Numbered ADRs](https://github.com/kontourai/corpus/blob/main/docs/decisions.md#numbered-adrs).

## Where decisions live now

New and superseding decisions are recorded as **topic-keyed living decision
records** under [`docs/decisions/`](../decisions/index.md), one file per decision
**subject** (a noun from the `CONTEXT.md` glossary), never as a new numbered ADR.

- Record format: the [Corpus decision-record format](https://github.com/kontourai/corpus/blob/main/docs/decisions.md)
  (frontmatter, statuses, evidence, and the index).
- Contract: [`context/contracts/decision-registry-contract.md`](../../context/contracts/decision-registry-contract.md)
  — the Flow Agents rules for topic slugs, supersession, and retrieval-at-write.
- Validate + regenerate the index: `npm run check:decisions` /
  `npm run gen:decisions-index`.
- Glossary: [`../decisions/decision-records.md`](../decisions/decision-records.md)
  explains the registry model; `CONTEXT.md`'s **Decision Records** / **Decision
  Registry** terms are the vocabulary.

## How to record a decision

1. Consult [`../decisions/index.md`](../decisions/index.md) to decide
   **revise-vs-create**: if the subject already has a topic file, edit it
   (supersession is an edit); otherwise create `docs/decisions/<subject-slug>.md`
   using a subject noun from `CONTEXT.md` (add the term first if absent).
2. Fill the frontmatter (`status`, `subject`, `decided`, `evidence[]`) in the
   Corpus format, then run `npm run gen:decisions-index` and
   `npm run check:decisions`.
3. Each frozen ADR whose subject you are ratifying is already linked from its
   `needs-decision` stub's `evidence[]`; flip that stub's `status` to `current`
   and add rationale rather than starting a new file.

Agent **probes** (`design-probe`, `pickup-probe`) author decision records
directly per
[`context/contracts/probe-docs-write-contract.md`](../../context/contracts/probe-docs-write-contract.md)
(issue [#311](https://github.com/kontourai/flow-agents/issues/311)): each
crystallized understanding emits a `CONTEXT.md` vocabulary delta, a
`docs/decisions/<slug>.md` decision delta (revise-vs-create against the index),
and a transcript-provenance link back to the Probe's session artifact.
